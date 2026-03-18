const db = require('../src/services/db');
const policyEngine = require('../src/services/policyEngine');
const auditLogger = require('../src/services/auditLogger');

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

    async analyze(fileStream, filename, context) {
        const { auth, deployment, request: contextRequest } = context;
        if (!auth || !auth.tenantId) throw new Error('Tenant identification is mandatory for analysis.');
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
             fileSize: options.fileSize || 0, // In autofix, we might assume check was passed in analyze or use direct input
             type: 'AUTOFIX'
        });

        // 1. PERSIST INITIAL STATE
        await db.execute(
             `INSERT INTO jobs (id, tenant_id, deployment_id, user_id, job_type, status) 
              VALUES (?, ?, ?, ?, ?, ?)`,
             [jobId, tenantId, deployment.deploymentId, auth.userId, 'AUTOFIX', 'QUEUED'],
             { tenantId, requestId: contextRequest.requestId }
        );

        await auditLogger.log(context, {
             action: 'AUTOFIX_ENQUEUED',
             resourceType: 'JOB',
             resourceId: jobId
        });

        // Orchestrate autofix job with strict contract-governed isolation
        const jobEnvelope = { 
            jobId,
            tenantId: auth.tenantId,
            requestedBy: auth.userId,
            deploymentId: deployment.deploymentId,
            tenantIsolation: deployment.tenantIsolation,
            serviceTier: deployment.serviceTier,
            payload: {
                assetId, 
                policy,
                ...options
            }
        };
        
        return await this.worker.enqueue('AUTOFIX', jobEnvelope);
    }
}

module.exports = PreflightService;
