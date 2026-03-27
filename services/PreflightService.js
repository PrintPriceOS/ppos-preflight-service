const db = require('../src/services/db');
const policyEngine = require('../src/services/policyEngine');
const auditLogger = require('../src/services/auditLogger');
const { ErrorCodes, ErrorTypes, PPOSError } = require('../src/utils/errors');
const path = require('path');
const fs = require('fs-extra');

/**
 * PreflightService
 * 
 * Orchestrates the analysis and autofix lifecycle with governance persistence.
 */
class PreflightService {
    constructor(engineClient, workerClient, storage) {
        this.engine = engineClient;
        this.worker = workerClient;
        this.storage = storage;
    }

    async analyze(fileStream, filename, context, options = {}) {
        const { auth, deployment, request: contextRequest } = context;
        if (!auth || !auth.tenantId) {
            throw new PPOSError(ErrorCodes.UNAUTHORIZED, 'Tenant identification is mandatory.', ErrorTypes.USER_ERROR);
        }

        // Idempotency Check
        const idempotencyKey = contextRequest.headers?.['idempotency-key'];
        if (idempotencyKey) {
            const [existing] = await db.query("SELECT id FROM jobs WHERE idempotency_key = ? AND tenant_id = ?", [idempotencyKey, auth.tenantId]);
            if (existing) {
                console.log(`[PRELIGHT][JOBS] Reusing existing job for idempotency key: ${idempotencyKey}`);
                return { jobId: existing.id, status: 'QUEUED', reused: true };
            }
        }

        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const tenantId = auth.tenantId;

        // --- Phase 4: Runtime Governance (Pre-Job Enforcement) ---
        const effectivePolicy = await policyEngine.resolveEffectivePolicy(context);
        
        // Initial staging to check file size (temporarily staged)
        await this.storage.initializeJobStorage(context, jobId);
        const { filePath } = await this.storage.saveInputFile(tenantId, jobId, fileStream, filename);
        const stats = await require('fs-extra').stat(filePath);

        try {
            await policyEngine.validateExecution(context, effectivePolicy, {
                fileSize: stats.size,
                type: 'ANALYZE'
            });
        } catch (err) {
             if (err.isPolicyViolation) {
                 // Cleanup before throwing
                 await this.storage.deleteJobStorage(tenantId, jobId);
                 throw err;
             }
             throw err;
        }

        // 3. PERSIST INITIAL STATE (Phase 3)
        console.log(`[PRELIGHT][JOBS] Creating job: ${jobId} (Tenant: ${tenantId})`);
        await db.execute(
            `INSERT INTO jobs (id, tenant_id, deployment_id, user_id, job_type, status, input_bytes, idempotency_key) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [jobId, tenantId, deployment.deploymentId, auth.userId, 'ANALYZE', 'PROCESSING', stats.size, idempotencyKey],
            { tenantId, requestId: contextRequest.requestId }
        );

        // Audit Event (Phase 7)
        await auditLogger.log(context, {
            action: 'JOB_CREATED',
            resourceType: 'JOB',
            resourceId: jobId,
            governanceSnapshot: effectivePolicy
        });

        // 4. Decide: Synchronous Engine vs Asynchronous Worker
        if (stats.size < 5 * 1024 * 1024) { // < 5MB sync
            const report = await this.engine.analyze(filePath, { 
                tenantId, 
                jobId,
                outputDir: this.storage.getJobSubfolder(tenantId, jobId, 'output')
            });

            // Update on Completion
            await db.execute(
                "UPDATE jobs SET status = 'COMPLETED', input_bytes = ? WHERE id = ?",
                [stats.size, jobId],
                { tenantId, requestId: contextRequest.requestId }
            );

            return report;
        } else {
            // Phase 2: Normalized Job Envelope
            const jobEnvelope = {
                jobId,
                tenantId,
                requestedBy: auth.userId,
                deploymentId: deployment.deploymentId,
                tenantIsolation: deployment.tenantIsolation,
                serviceTier: deployment.serviceTier,
                payload: {
                    filePath,
                    options: {
                        storage: {
                            base: this.storage.getJobPath(tenantId, jobId),
                            input: filePath
                        }
                    }
                }
            };

            const result = await this.worker.enqueue('ANALYZE', jobEnvelope);
            
            // Log enqueued status
            await db.execute("UPDATE jobs SET status = 'QUEUED' WHERE id = ?", [jobId]);
            
            await auditLogger.log(context, {
                 action: 'JOB_QUEUED',
                 resourceType: 'JOB',
                 resourceId: jobId
            });

            return result;
        }
    }

    async autofix(assetId, policy, context, options = {}) {
        const { auth, deployment, request: contextRequest } = context || {};
        if (!auth || !auth.tenantId) throw new Error('Tenant identification is mandatory for autofix.');

        const jobId = `fix_${Date.now()}`;
        const tenantId = auth.tenantId;

        const effectivePolicy = await policyEngine.resolveEffectivePolicy(context);
        await policyEngine.validateExecution(context, effectivePolicy, {
             fileSize: options.fileSize || 0,
             type: 'AUTOFIX'
        });

        const idempotencyKey = contextRequest?.headers?.['idempotency-key'];
        const safeRequestId = contextRequest?.requestId || context?.requestId || 'unknown';
        if (idempotencyKey) {
            const [existing] = await db.query("SELECT id FROM jobs WHERE idempotency_key = ? AND tenant_id = ?", [idempotencyKey, auth.tenantId]);
            if (existing) {
                console.log(`[PRELIGHT][JOBS] Reusing existing job for idempotency key: ${idempotencyKey}`);
                return { jobId: existing.id, status: 'QUEUED', reused: true };
            }
        }

        // 1. Resolve Asset File Reference
        const inputDir = this.storage.getJobSubfolder(tenantId, assetId, 'input');
        const files = await fs.readdir(inputDir);
        const fileName = files.find(f => f.endsWith('.pdf'));
        if (!fileName) {
            throw new PPOSError(ErrorCodes.NOT_FOUND, `Asset file not found for asset: ${assetId}`, ErrorTypes.SERVICE_ERROR);
        }
        const fileUrl = path.join(inputDir, fileName);

        // 2. PERSIST INITIAL STATE
        console.log(`[PRELIGHT][JOBS] Creating autofix job: ${jobId} (Asset: ${assetId})`);
        await db.execute(
             `INSERT INTO jobs (id, tenant_id, deployment_id, user_id, job_type, status, idempotency_key) 
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
             [jobId, tenantId, deployment.deploymentId, auth.userId, 'AUTOFIX', 'QUEUED', idempotencyKey],
             { tenantId, requestId: safeRequestId }
        );

        await auditLogger.log(context, {
             action: 'AUTOFIX_ENQUEUED',
             resourceType: 'JOB',
             resourceId: jobId
        });

        // 3. Orchestrate canonical AUTOFIX envelope (Worker V2 Contract)
        const jobEnvelope = { 
            jobId,
            tenantId,
            input: {
                fileUrl,
                specs: {
                    ...policy,
                    ...options
                }
            },
            policyProfile: effectivePolicy.id || 'default_autofix_profile',
            trace: {
                requestId: safeRequestId,
                traceparent: contextRequest?.headers?.['traceparent'] || context?.traceparent
            }
        };
        
        return await this.worker.enqueue('AUTOFIX', jobEnvelope);
    }

    /**
     * Generates visual previews for a job.
     */
    async generatePreviews(jobId, context, options = {}) {
        const { auth } = context;
        const tenantId = auth.tenantId;

        // 1. Retrieve input file
        const jobPath = this.storage.getJobPath(tenantId, jobId);
        const files = await fs.readdir(jobPath);
        const inputFile = files.find(f => f.endsWith('.pdf'));
        
        if (!inputFile) throw new Error('Input PDF not found for previews.');
        const inputPath = path.join(jobPath, inputFile);
        
        // 2. Prepare output dir
        const previewDir = this.storage.getJobSubfolder(tenantId, jobId, 'previews');
        await fs.ensureDir(previewDir);

        // 3. Render (Sync for p1 as baseline)
        const outputPath = path.join(previewDir, 'p1.png');
        await this.engine.renderPage(inputPath, outputPath, 1, options);

        return {
            ok: true,
            jobId,
            previews: [{ page: 1, url: `/api/preflight/preview/${jobId}/1` }]
        };
    }
    /**
     * Retrieves the status of a job from the database.
     */
    async getJobStatus(jobId, context) {
        const { auth } = context;
        console.log(`[PRELIGHT][JOBS] Querying status for job: ${jobId}`);
        
        const [job] = await db.query(
            "SELECT id, status, job_type, progress, result, error, created_at FROM jobs WHERE id = ? AND tenant_id = ?", 
            [jobId, auth.tenantId]
        );

        if (!job) return null;

        // Map internal result string to object if necessary
        let result = job.result;
        if (typeof result === 'string') {
            try { result = JSON.parse(result); } catch (e) {}
        }

        return {
            id: job.id,
            status: job.status,
            type: job.job_type,
            progress: job.progress || 0,
            result: result || {},
            error: job.error || null,
            createdAt: job.created_at
        };
    }

    /**
     * Retrieves the active preflight policies.
     */
    async getPolicies(context) {
        console.log(`[PRELIGHT][POLICIES] Resolving policies for tenant: ${context.auth?.tenantId}`);
        const effectivePolicy = await policyEngine.resolveEffectivePolicy(context);
        
        // Transform internal policy format to canonical contract
        return {
            policies: [
                {
                    id: effectivePolicy.id || 'default_policy',
                    name: effectivePolicy.name || 'Standard Preflight Policy',
                    rules: effectivePolicy.rules || []
                }
            ]
        };
    }
}

module.exports = PreflightService;
