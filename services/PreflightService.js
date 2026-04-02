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
const policyCatalog = require('./policyCatalog');

class PreflightService {
    constructor(engineClient, workerClient, storage) {
        this.engine = engineClient;
        this.worker = workerClient;
        this.storage = storage;
    }

    /**
     * Internal helper to normalize context for storage operations.
     */
    _normalizeStorageContext(context) {
        const { auth, deployment } = context || {};
        if (!auth?.tenantId || !deployment?.deploymentId) {
            throw new PPOSError(ErrorCodes.UNAUTHORIZED, 'Invalid context for storage: missing tenantId or deploymentId', ErrorTypes.SERVICE_ERROR);
        }
        return {
            tenantId: auth.tenantId,
            deploymentId: deployment.deploymentId,
            tenantIsolation: deployment.tenantIsolation || 'logical'
        };
    }

    /**
     * Internal helper to resolve the canonical input PDF path for a job.
     */
    async _resolveCanonicalInputPdf(tenantId, jobId, type = 'JOB') {
        try {
            const inputDir = this.storage.getJobSubfolder(tenantId, jobId, 'input');
            if (!(await fs.pathExists(inputDir))) {
                throw new Error(`Input directory missing: ${inputDir}`);
            }
            const files = await fs.readdir(inputDir);
            const fileName = files.find(f => f.toLowerCase().endsWith('.pdf'));
            if (!fileName) {
                throw new Error(`No PDF found in input subfolder for ${type} ${jobId}`);
            }
            return path.join(inputDir, fileName);
        } catch (err) {
            const errCode = type === 'AUTOFIX' ? 'AUTOFIX-INPUT-ERROR' : 'ANALYZE-INPUT-ERROR';
            console.error(`[${errCode}] ${err.message} (jobId=${jobId}, tenantId=${tenantId})`);
            throw new PPOSError(ErrorCodes.NOT_FOUND, `[${errCode}] No input PDF found for jobId=${jobId} tenantId=${tenantId}`, ErrorTypes.SERVICE_ERROR);
        }
    }

    async analyze(fileStream, filename, context, options = {}) {
        // --- Phase 10: context normalization ---
        const safeContext = context || {};
        const contextRequest = safeContext.request || safeContext.req || null;
        const requestHeaders = contextRequest?.headers || {};
        const safeRequestId = contextRequest?.requestId || safeContext.requestId || 'unknown';
        const safeTraceparent = requestHeaders['traceparent'] || safeContext.traceparent || null;

        const { auth, deployment } = safeContext;
        if (!auth || !auth.tenantId) {
            throw new PPOSError(ErrorCodes.UNAUTHORIZED, 'Tenant identification is mandatory.', ErrorTypes.USER_ERROR);
        }

        // Idempotency Check
        const idempotencyKey = requestHeaders['idempotency-key'];
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
        const effectivePolicy = await policyEngine.resolveEffectivePolicy(safeContext);

        // Initial staging to check file size (temporarily staged)
        const storageContext = this._normalizeStorageContext(safeContext);
        await this.storage.initializeJobStorage(storageContext, jobId);
        const { filePath } = await this.storage.saveInputFile(tenantId, jobId, fileStream, filename);
        const stats = await require('fs-extra').stat(filePath);

        try {
            await policyEngine.validateExecution(safeContext, effectivePolicy, {
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
            [jobId, tenantId, deployment?.deploymentId || 'unknown', auth?.userId || 'SYSTEM', 'ANALYZE', 'PROCESSING', stats.size, idempotencyKey || null],
            { tenantId, requestId: safeRequestId }
        );

        // Audit Event (Phase 7)
        await auditLogger.log(safeContext, {
            action: 'JOB_CREATED',
            resourceType: 'JOB',
            resourceId: jobId,
            governanceSnapshot: effectivePolicy
        });

        // 4. Decide: Synchronous Engine vs Asynchronous Worker
        if (stats.size < 5 * 1024 * 1024) { // < 5MB sync
            console.log(`[PREFLIGHT][SERVICE] Starting sync analysis for job: ${jobId}`);
            const start = Date.now();
            
            const report = await this.engine.analyze(filePath, {
                tenantId,
                jobId,
                outputDir: this.storage.getJobSubfolder(tenantId, jobId, 'output')
            });

            const elapsed = Date.now() - start;
            console.log(`[PREFLIGHT][SERVICE][${safeRequestId}] Sync analysis completed in ${elapsed}ms for job: ${jobId}`);

            const outputDir = this.storage.getJobSubfolder(tenantId, jobId, 'output');
            
            try {
                // v2.4.10: Explicit Artifact Generation (Phase 10 Intelligence Layer)
                console.log(`[PREFLIGHT][SERVICE][${safeRequestId}] Generating persistent artifacts for job: ${jobId}`);
                const reportPath = path.join(outputDir, 'report.json');
                await fs.writeJson(reportPath, report);
                console.log(`[PREFLIGHT][SERVICE][${safeRequestId}] Analysis report artifact saved to: ${reportPath}`);

                // Update on Completion with full result persistence
                console.log(`[PREFLIGHT][SERVICE][${safeRequestId}] Finalizing job status and results in database for job: ${jobId}`);
                await db.execute(
                    "UPDATE jobs SET status = 'COMPLETED', input_bytes = ?, result = ? WHERE id = ?",
                    [stats.size, JSON.stringify(report), jobId],
                    { tenantId, requestId: safeRequestId }
                );
                console.log(`[PREFLIGHT][SERVICE][${safeRequestId}] FINALIZED_JOB: ${jobId} (status: COMPLETED)`);
            } catch (finalizeErr) {
                console.error(`[PREFLIGHT][SERVICE][ERROR][${safeRequestId}] Job finalization failed for ${jobId}:`, finalizeErr.message);
                throw finalizeErr;
            }

            return report;
        } else {
            console.log(`[PREFLIGHT][SERVICE] Delegating to background worker for large job: ${jobId} (${stats.size} bytes)`);
            
            // Phase 2: Normalized Job Envelope (V2 Canonical)
            const fileUrl = await this._resolveCanonicalInputPdf(tenantId, jobId, 'ANALYZE');

            const jobEnvelope = {
                jobId,
                tenantId,
                requestedBy: auth?.userId || 'SYSTEM',
                deploymentId: deployment?.deploymentId || 'LOCAL',
                tenantIsolation: deployment?.tenantIsolation || 'logical',
                serviceTier: deployment?.serviceTier || 'standard',
                input: {
                    fileUrl,
                    specs: {
                        options: options
                    }
                },
                trace: {
                    requestId: safeRequestId,
                    traceparent: safeTraceparent
                },
                contractMode: 'v2_emitted'
            };

            const startWorker = Date.now();
            const result = await this.worker.enqueue('ANALYZE', jobEnvelope);
            const elapsedWorker = Date.now() - startWorker;
            console.log(`[PREFLIGHT][SERVICE] Job enqueued to worker in ${elapsedWorker}ms for job: ${jobId}`);

            // Log enqueued status
            console.log(`[PREFLIGHT][SERVICE] Updating job status to QUEUED in DB for job: ${jobId}`);
            await db.execute("UPDATE jobs SET status = 'QUEUED' WHERE id = ?", [jobId]);

            await auditLogger.log(safeContext, {
                action: 'JOB_QUEUED',
                resourceType: 'JOB',
                resourceId: jobId
            });

            return { ...result, id: jobId, jobId: jobId };
        }
    }

    async autofix(assetId, policy, context, options = {}) {
        // --- Phase 10: context normalization ---
        const safeContext = context || {};
        const contextRequest = safeContext.request || safeContext.req || null;
        const requestHeaders = contextRequest?.headers || {};
        const safeRequestId = contextRequest?.requestId || safeContext.requestId || 'unknown';
        const safeTraceparent = requestHeaders['traceparent'] || safeContext.traceparent || null;

        const { auth, deployment } = safeContext;
        if (!auth || !auth.tenantId) throw new Error('Tenant identification is mandatory for autofix.');

        const jobId = `fix_${Date.now()}`;
        const tenantId = auth.tenantId;

        const effectivePolicy = await policyEngine.resolveEffectivePolicy(safeContext);
        const storageContext = this._normalizeStorageContext(safeContext);

        await policyEngine.validateExecution(safeContext, effectivePolicy, {
            fileSize: options.fileSize || 0,
            type: 'AUTOFIX'
        });

        // Ensure storage is initialized even if asset exists (for the new jobId)
        await this.storage.initializeJobStorage(storageContext, jobId);

        const idempotencyKey = requestHeaders['idempotency-key'];
        if (idempotencyKey) {
            const [existing] = await db.query("SELECT id FROM jobs WHERE idempotency_key = ? AND tenant_id = ?", [idempotencyKey, auth.tenantId]);
            if (existing) {
                console.log(`[PRELIGHT][JOBS] Reusing existing job for idempotency key: ${idempotencyKey}`);
                return { jobId: existing.id, status: 'QUEUED', reused: true };
            }
        }

        // 1. Resolve Asset File Reference (Fail Fast)
        const fileUrl = await this._resolveCanonicalInputPdf(tenantId, assetId, 'AUTOFIX');

        // 2. PERSIST INITIAL STATE
        console.log(`[PRELIGHT][JOBS] Creating autofix job: ${jobId} (Asset: ${assetId})`);
        await db.execute(
            `INSERT INTO jobs (id, tenant_id, deployment_id, user_id, job_type, status, idempotency_key) 
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [jobId, tenantId, deployment?.deploymentId || 'unknown', auth?.userId || 'SYSTEM', 'AUTOFIX', 'QUEUED', idempotencyKey || null],
            { tenantId, requestId: safeRequestId }
        );

        await auditLogger.log(safeContext, {
            action: 'AUTOFIX_ENQUEUED',
            resourceType: 'JOB',
            resourceId: jobId
        });

        // 3. Orchestrate canonical AUTOFIX envelope (Worker V2 Contract)
        const resolvedPolicyProfile = effectivePolicy.id || policy.id || policy.profileId || 'default_autofix_profile';

        const jobEnvelope = {
            jobId,
            tenantId,
            requestedBy: auth?.userId || 'SYSTEM',
            deploymentId: deployment?.deploymentId || 'LOCAL',
            tenantIsolation: deployment?.tenantIsolation || 'logical',
            serviceTier: deployment?.serviceTier || 'standard',
            input: {
                fileUrl,
                specs: {
                    policy: policy,
                    options: options
                }
            },
            policyProfile: resolvedPolicyProfile,
            trace: {
                requestId: safeRequestId,
                traceparent: safeTraceparent
            },
            contractMode: 'v2_emitted'
        };

        console.log(`[PRELIGHT][JOBS] Emitting V2 AUTOFIX contract for job: ${jobId} (Tenant: ${tenantId}, Profile: ${resolvedPolicyProfile})`);

        return await this.worker.enqueue('AUTOFIX', jobEnvelope);
    }

    /**
     * Generates visual previews for a job.
     */
    async generatePreviews(jobId, context, options = {}) {
        // --- Phase 10: context normalization ---
        const safeContext = context || {};
        const { auth } = safeContext;
        if (!auth || !auth.tenantId) throw new Error('Tenant identification is mandatory for preview generation.');

        const tenantId = auth.tenantId;

        // 1. Retrieve input file (Search input subfolder)
        const inputPath = await this._resolveCanonicalInputPdf(tenantId, jobId, 'PREVIEW');

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
        // --- Phase 10: context normalization ---
        const safeContext = context || {};
        const { auth } = safeContext;
        if (!auth || !auth.tenantId) throw new Error('Tenant identification is mandatory for job status check.');

        console.log(`[PRELIGHT][JOBS] Querying status for job: ${jobId}`);

        const [job] = await db.query(
            "SELECT id, status, job_type, progress, result, error, created_at FROM jobs WHERE id = ? AND tenant_id = ?",
            [jobId, auth.tenantId]
        );

        if (!job) return null;

        // Map internal result string to object if necessary
        let result = job.result;
        if (typeof result === 'string') {
            try { result = JSON.parse(result); } catch (e) { }
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
        // --- Phase 10: context normalization ---
        const safeContext = context || {};
        const { auth } = safeContext;

        console.log(`[PRELIGHT][POLICIES] Resolving policies for tenant: ${auth?.tenantId || 'unknown'}. Loaded ${policyCatalog.length} policies.`);

        // Return the full production-ready catalog
        return {
            policies: policyCatalog
        };
    }
}

module.exports = PreflightService;
