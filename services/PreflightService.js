const db = require('../src/services/db');
const policyEngine = require('../src/services/policyEngine');
const auditLogger = require('../src/services/auditLogger');
const { ErrorCodes, ErrorTypes, PPOSError } = require('../src/utils/errors');

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
            if (existing) return { jobId: existing.id, status: 'QUEUED', reused: true };
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
        await db.execute(
            `INSERT INTO jobs (id, tenant_id, deployment_id, user_id, job_type, status, input_bytes) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [jobId, tenantId, deployment.deploymentId, auth.userId, 'ANALYZE', 'PROCESSING', stats.size],
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
        const { auth, deployment, request: contextRequest } = context;
        if (!auth || !auth.tenantId) throw new Error('Tenant identification is mandatory for autofix.');
        
        const jobId = `fix_${Date.now()}`;
        const tenantId = auth.tenantId;

        // --- Phase 4: Runtime Governance ---
        const effectivePolicy = await policyEngine.resolveEffectivePolicy(context);
        await policyEngine.validateExecution(context, effectivePolicy, {
             fileSize: options.fileSize || 0,
             type: 'AUTOFIX'
        });

        // 1. PERSIST INITIAL STATE
        await db.execute(
             `INSERT INTO jobs (id, tenant_id, deployment_id, user_id, job_type, status, idempotency_key) 
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
             [jobId, tenantId, deployment.deploymentId, auth.userId, 'AUTOFIX', 'QUEUED', idempotencyKey],
             { tenantId, requestId: contextRequest.requestId }
        );

        await auditLogger.log(context, {
             action: 'AUTOFIX_ENQUEUED',
             resourceType: 'JOB',
             resourceId: jobId
        });

        // Orchestrate autofix job
        const jobEnvelope = { 
            jobId,
            tenantId: auth.tenantId,
            requestedBy: auth.userId,
            deploymentId: deployment.deploymentId,
            tenantIsolation: deployment.tenantIsolation,
            serviceTier: deployment.serviceTier,
            headers: contextRequest.headers, // PROPAGATE TRACE
            payload: {
                assetId, 
                policy,
                ...options
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
        // Find the input file in the job's storage (assuming it's fixed name or we search)
        const fs = require('fs-extra');
        const path = require('path');
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
}

module.exports = PreflightService;
