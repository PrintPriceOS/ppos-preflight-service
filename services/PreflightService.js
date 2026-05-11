const db = require('../src/services/db');
const policyEngine = require('../src/services/policyEngine');
const auditLogger = require('../src/services/auditLogger');
const { ErrorCodes, ErrorTypes, PPOSError } = require('../src/utils/errors');
const path = require('path');
const fs = require('fs-extra');
const IdentityValidator = require('../src/utils/identityValidator');
const HashUtility = require('../src/utils/hashUtility');


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
        const isCanonical = IdentityValidator.isValidJobId(jobId);
        console.log(`[SERVICE][AUTOFIX][SOURCE-ASSET] Resolving input for ${type}. ID: ${jobId} | Canonical: ${isCanonical} | Tenant: ${tenantId}`);

        try {
            const inputDir = this.storage.getJobSubfolder(tenantId, jobId, 'input');
            if (!(await fs.pathExists(inputDir))) {
                // If it's an AUTOFIX type and we're looking for source input, it might be in the output of a previous job?
                // No, current architecture assumes input is always in the 'input' folder of the referenced job.
                throw new Error(`Input directory missing: ${inputDir}`);
            }
            const files = await fs.readdir(inputDir);
            const fileName = files.find(f => f.toLowerCase().endsWith('.pdf'));
            if (!fileName) {
                throw new Error(`No PDF found in input subfolder for ${type} ${jobId}`);
            }
            const resolvedPath = path.join(inputDir, fileName);
            console.log(`[SERVICE][AUTOFIX][RESOLVED-INPUT] Path found: ${resolvedPath} (id=${jobId})`);
            return resolvedPath;
        } catch (err) {
            // Only use AUTOFIX-INPUT-ERROR if we are sure it's an input resolution failure for a NEW job
            const errCode = type === 'AUTOFIX' ? 'AUTOFIX-INPUT-ERROR' : 'ANALYZE-INPUT-ERROR';
            console.error(`[SERVICE][${errCode}] Resolution failed: ${err.message} (jobId=${jobId}, tenantId=${tenantId})`);
            
            // If the error is already a PPOSError, just rethrow
            if (err instanceof PPOSError) throw err;

            throw new PPOSError(
                ErrorCodes.NOT_FOUND, 
                `[${errCode}] No input PDF found for jobId=${jobId} (Reason: ${err.message})`, 
                ErrorTypes.SERVICE_ERROR
            );
        }
    }

    async analyze(fileStream, filename, context, options = {}) {
        const start = Date.now();
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
        const stats = await fs.stat(filePath);

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
            try {
                const report = await this.engine.analyze(filePath, {
                    tenantId,
                    jobId,
                    outputDir: this.storage.getJobSubfolder(tenantId, jobId, 'output')
                });

                const elapsed = Date.now() - start;
                console.log(`[PREFLIGHT][SERVICE][${safeRequestId}] Sync analysis completed in ${elapsed}ms for job: ${jobId}`);

                // Phase 10: Silent Failure Prevention (Contract Enforcement)
                const findings = report.findings || report.issues || [];
                const finalStatus = findings.length > 0 ? 'COMPLETED' : 'FAILED';
                const finalOk = findings.length > 0;

                const artifactOutputDir = this.storage.getJobSubfolder(tenantId, jobId, 'output');
                const certifiedPath = path.join(artifactOutputDir, 'certified.pdf');

                if (!(await fs.pathExists(certifiedPath))) {
                    console.log(`[CERTIFY][OUTPUT][${safeRequestId}] Promoting input as certified carrier for job: ${jobId}`);
                    await fs.copy(filePath, certifiedPath);
                    // Mark certification basis for traceability
                    report.certification_basis = "analysis_input";
                }

                const reportPath = path.join(artifactOutputDir, 'report.json');
                await fs.writeJson(reportPath, report);
                
                const artifacts = await this.getJobArtifacts(jobId, tenantId);
                
                // v2.4.120: Verify critical analysis artifacts
                const hasCertified = artifacts.some(a => a.type === 'certified_pdf');
                const hasReport = artifacts.some(a => a.type === 'analysis_report');
                
                if (!hasCertified || !hasReport) {
                    console.error(`[PREFLIGHT][INTEGRITY] Missing critical artifacts for job ${jobId}`);
                }

                await db.execute(
                    "UPDATE jobs SET status = ?, input_bytes = ?, result = ? WHERE id = ?",
                    [
                        finalOk ? 'COMPLETED' : 'FAILED', 
                        stats.size, 
                        JSON.stringify({ 
                            ...report, 
                            ok: finalOk,
                            type: 'ANALYZE', 
                            artifacts: artifacts.reduce((acc, a) => ({ ...acc, [a.type]: a.name }), {}) 
                        }), 
                        jobId
                    ],
                    { tenantId, requestId: safeRequestId }
                );

                if (!finalOk) {
                    return {
                        id: jobId,
                        jobId,
                        ok: false,
                        status: 'FAILED',
                        error: 'ANALYSIS_FAILED',
                        message: 'Engine returned no findings. Verification required.',
                        findings: []
                    };
                }

                return {
                    id: jobId,
                    jobId,
                    ok: true,
                    status: 'COMPLETED',
                    ...report,
                    meta: {
                        ...(report?.meta || {}),
                        jobId,
                        tenantId
                    }
                };
            } catch (err) {
                if (err.message === 'ENGINE_ANALYSIS_TIMEOUT') {
                    console.error(`[PREFLIGHT][TIMEOUT] Sync analysis timed out for job: ${jobId}`);
                    await db.execute("UPDATE jobs SET status = 'FAILED', error = 'TIMEOUT' WHERE id = ?", [jobId]);
                    return {
                        id: jobId,
                        jobId,
                        ok: false,
                        status: 'DEGRADED',
                        error: 'ANALYSIS_TIMEOUT',
                        message: 'Analysis timed out. Service degraded.'
                    };
                }
                throw err;
            }
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
                return { jobId: existing.id, status: 'QUEUED', reused: true, sourceJobId: assetId };
            }
        }

        // 1. Resolve Asset File Reference (Fail Fast)
        console.log(`[SERVICE][AUTOFIX][INIT] Initializing fix for asset: ${assetId}`);
        const fileUrl = await this._resolveCanonicalInputPdf(tenantId, assetId, 'AUTOFIX');

        const stats = await fs.stat(fileUrl);

        // Derive fix plan from source job issues when caller doesn't specify a type
        if (!options.type && !options.repairStrategy && !options.forceBleed) {
            try {
                const [sourceJob] = await db.query(
                    "SELECT result FROM jobs WHERE id = ? AND tenant_id = ?",
                    [assetId, tenantId]
                );
                const sourceResult = typeof sourceJob?.result === 'string'
                    ? JSON.parse(sourceJob.result) : sourceJob?.result || {};
                const sourceIssues = sourceResult.findings || sourceResult.issues || [];
                const bleedIssue = sourceIssues.find(i =>
                    i.fix_method === 'APPLY_BLEED' || i.repairStrategy === 'APPLY_BLEED'
                );
                if (bleedIssue) {
                    options = { ...options, type: 'bleed', repairStrategy: 'APPLY_BLEED' };
                    console.log(`[SERVICE][AUTOFIX][DERIVED] Fix plan derived from source job issues: type=bleed`);
                }
            } catch (e) {
                console.warn(`[SERVICE][AUTOFIX][DERIVE-WARN] Could not derive fix plan from source job: ${e.message}`);
            }
        }

        // 2. PERSIST INITIAL STATE
        console.log(`[PRELIGHT][JOBS] Creating autofix job: ${jobId} (Asset: ${assetId})`);
        await db.execute(
            `INSERT INTO jobs (id, tenant_id, deployment_id, user_id, job_type, status, idempotency_key, result)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                jobId,
                tenantId,
                deployment?.deploymentId || 'unknown',
                auth?.userId || 'SYSTEM',
                'AUTOFIX',
                'QUEUED',
                idempotencyKey || null,
                JSON.stringify({ sourceJobId: assetId, targetJobId: jobId })
            ],
            { tenantId, requestId: safeRequestId }
        );

        await auditLogger.log(safeContext, {
            action: 'AUTOFIX_ENQUEUED',
            resourceType: 'JOB',
            resourceId: jobId
        });

        // 3a. Sync path for small files (< 5MB) — no worker required
        if (stats.size < 5 * 1024 * 1024) {
            console.log(`[SERVICE][AUTOFIX][SYNC] Running inline fix for job: ${jobId} (${stats.size} bytes)`);
            try {
                const outputDir = this.storage.getJobSubfolder(tenantId, jobId, 'output');
                const fixResult = await this.engine.autofix(fileUrl, options, { outputDir });

                const fixedPath = path.join(outputDir, 'fixed.pdf');
                if (fixResult.ok && fixResult.fixedPath) {
                    await fs.copy(fixResult.fixedPath, fixedPath);
                }

                const resultPayload = {
                    sourceJobId: assetId,
                    targetJobId: jobId,
                    ok: fixResult.ok,
                    repairs: fixResult.repairs || [],
                    autofix_attempted: true
                };

                await db.execute(
                    "UPDATE jobs SET status = ?, result = ? WHERE id = ?",
                    [fixResult.ok ? 'COMPLETED' : 'FAILED', JSON.stringify(resultPayload), jobId],
                    { tenantId, requestId: safeRequestId }
                );

                return {
                    id: jobId,
                    jobId,
                    sourceJobId: assetId,
                    targetJobId: jobId,
                    ok: fixResult.ok,
                    status: fixResult.ok ? 'COMPLETED' : 'FAILED',
                    repairs: fixResult.repairs || []
                };
            } catch (err) {
                console.error(`[SERVICE][AUTOFIX][SYNC-ERROR] ${err.message}`);
                await db.execute("UPDATE jobs SET status = 'FAILED', error = ? WHERE id = ?",
                    [err.message, jobId], { tenantId });
                throw err;
            }
        }

        // 3b. Async path for large files — delegate to worker
        const resolvedPolicyProfile = effectivePolicy.id || policy?.id || policy?.profileId || 'default_autofix_profile';

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

        const enqueueResult = await this.worker.enqueue('AUTOFIX', jobEnvelope);

        const finalResponse = {
            ...enqueueResult,
            id: jobId,
            jobId: jobId,
            sourceJobId: assetId,
            targetJobId: jobId
        };

        console.log(`[SERVICE][AUTOFIX][RESPONSE-CONTRACT] Generated for job: ${jobId} | Source: ${assetId}`);
        return finalResponse;
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
        IdentityValidator.validate(jobId, 'JobStatus');
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

        const canonicalId = job.id;
        console.log(`[SERVICE][JOB][PUBLIC-ID-NORMALIZED] Mapping data for ${canonicalId} (Type: ${job.job_type})`);

        // Map internal result string to object if necessary
        let result = job.result;
        if (typeof result === 'string') {
            try { result = JSON.parse(result); } catch (e) { }
        }

        const artifacts = await this.getJobArtifacts(canonicalId, auth.tenantId);
        
        // Phase 10: Silent Failure Enforcement for Polling
        // V2.5: Improved Error Propagation - Preserve worker-side engine failures
        let ok = result?.ok ?? (job.status === 'COMPLETED');
        let error = job.error || result?.error || result?.code || null;
        let message = result?.message || null;
        
        let partial = false;
        let analysis_warnings = [];

        if (job.status === 'COMPLETED' && job.job_type === 'ANALYZE') {
            const findings = result?.findings || result?.issues || [];
            if (findings.length === 0) {
                ok = false;
                if (!error) error = 'ANALYSIS_FAILED';
            } else {
                // Check for partial success (warnings only)
                const hasErrors = findings.some(f => f.severity === 'error' || f.severity === 'critical');
                if (!hasErrors) {
                    partial = true;
                    analysis_warnings = findings;
                }
            }
        }

        // Phase 10: Timeout Detection for Polling
        if (job.status === 'FAILED' && error === 'TIMEOUT') {
            return {
                id: canonicalId,
                jobId: canonicalId,
                status: 'DEGRADED',
                ok: false,
                error: 'ANALYSIS_TIMEOUT',
                message: 'Analysis timed out. Results are unavailable.'
            };
        }

        // Phase 10: Canonical Primary Artifact Resolution
        const isAutofix = job.job_type === 'AUTOFIX';
        const primaryArtifact = isAutofix 
            ? artifacts.find(a => a.type === 'final_fixed_pdf')
            : artifacts.find(a => a.type === 'certified_pdf');

        const primary_artifact_type = primaryArtifact?.type || null;
        const primary_artifact_name = primaryArtifact?.name || null;
        
        console.log(`[SERVICE][ARTIFACT] Primary resolved for ${job.job_type} job ${jobId}: ${primary_artifact_name} (${primary_artifact_type})`);

        // Safety Guard: Force failure if primary output is missing for completed jobs
        // V2.5: Do NOT overwrite real engine error with generic ARTIFACT_MISSING if error already exists
        if (job.status === 'COMPLETED' && !primaryArtifact) {
            console.error(`[PREFLIGHT][INTEGRITY] Critical artifact missing for ${job.job_type} job ${jobId}`);
            ok = false;
            if (!error) {
                error = isAutofix ? 'NO_OUTPUT_GENERATED' : 'CERTIFIED_ARTIFACT_MISSING';
            }
        }

        // Autofix Effectiveness Validation (Phases 10+)
        // V2.5: Skip validation if the fix failed (ok=false) to avoid misleading resolution errors
        if (isAutofix && job.status === 'COMPLETED' && ok && primaryArtifact && result?.autofix_effective === undefined) {
            try {
                // Determine source job for input comparison
                const sourceJobId = result?.sourceJobId;
                if (sourceJobId) {
                    const inputPath = await this._resolveCanonicalInputPdf(auth.tenantId, sourceJobId, 'AUTOFIX');
                    const outputPath = path.join(this.storage.getJobSubfolder(auth.tenantId, jobId, 'output'), primaryArtifact.name);
                    
                    const isIdentical = await HashUtility.areFilesIdentical(inputPath, outputPath);
                    
                    result.autofix_attempted = true;
                    result.autofix_effective = !isIdentical;
                    result.no_effective_changes = isIdentical;
                    
                    console.log(`[SERVICE][AUTOFIX][VALIDATION] Job ${jobId} Effectiveness: ${result.autofix_effective ? 'REPAIRED' : 'NO_CHANGES'} (Identical: ${isIdentical})`);
                    
                    // Persist validation result to avoid redundant hashing
                    await db.execute(
                        "UPDATE jobs SET result = ? WHERE id = ?",
                        [JSON.stringify(result), jobId],
                        { tenantId: auth.tenantId }
                    );
                }
            } catch (err) {
                console.error(`[SERVICE][AUTOFIX][VALIDATION-NON-FATAL] Effectiveness check skipped for ${jobId}: ${err.message}`);
                // V2.5: Do not crash the entire status response if validation fails (e.g. source input missing)
            }
        }

        return {
            id: canonicalId,
            jobId: canonicalId,
            ok,
            status: job.status,
            type: job.job_type,
            progress: job.progress || 0,
            result: {
                ...result,
                primary_artifact_type,
                primary_artifact_name,
                error: result?.error || error,
                message: result?.message || message
            },
            error,
            message,
            partial,
            analysis_warnings,
            createdAt: job.created_at,
            artifacts: artifacts
        };
    }


    /**
     * getJobArtifacts
     * Scans storage and returns a canonical list of artifacts for a job.
     */
    async getJobArtifacts(jobId, tenantId) {
        const artifacts = [];
        const outputDir = this.storage.getJobSubfolder(tenantId, jobId, 'output');

        try {
            if (await fs.pathExists(outputDir)) {
                const files = await fs.readdir(outputDir);
                for (const file of files) {
                    const filePath = path.join(outputDir, file);
                    const stats = await fs.stat(filePath);

                    // Categorize artifact based on filename/ext (Canonical Phase 10 Mapping)
                    let type = 'output_file';
                    if (file === 'report.json') type = 'analysis_report';
                    else if (file === 'fixed.pdf' || file === 'normalized.pdf') type = 'final_fixed_pdf';
                    else if (file === 'fix_audit.json') type = 'fix_audit';
                    else if (file === 'certified.pdf') type = 'certified_pdf';
                    else if (file.endsWith('.png')) type = 'page_preview';

                    artifacts.push({
                        id: Buffer.from(`${jobId}:${file}`).toString('base64').replace(/=/g, ''),
                        jobId,
                        type,
                        name: file,
                        path: `/jobs/${jobId}/output/${file}`,
                        mimeType: this._getMimeByExt(path.extname(file)),
                        size: stats.size,
                        createdAt: stats.birthtime,
                        status: 'READY'
                    });
                }
            }
        } catch (err) {
            console.error(`[ARTIFACT-DISCOVERY-ERROR] jobId=${jobId}:`, err.message);
        }

        return artifacts;
    }

    _getMimeByExt(ext) {
        const mapping = {
            '.pdf': 'application/pdf',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.txt': 'text/plain'
        };
        return mapping[ext.toLowerCase()] || 'application/octet-stream';
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
