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

                // Phase 10: Silent Failure Prevention & Runtime Extraction Verification
                const missingToolsCheck = Array.isArray(report?.missing_tools) ? report.missing_tools :
                    Array.isArray(report?.forensics?.missing_tools) ? report.forensics.missing_tools :
                        Array.isArray(report?.analysis?.missing_tools) ? report.analysis.missing_tools :
                            Array.isArray(report?.environment?.missing_tools) ? report.environment.missing_tools :
                                Array.isArray(report?.meta?.missing_tools) ? report.meta.missing_tools :
                                    (typeof report?.missing_tools === 'string' ? [report.missing_tools] : []);

                const extractionErrorsCheck = Array.isArray(report?.analysisIntegrity?.extractionErrors)
                    ? report.analysisIntegrity.extractionErrors
                    : Array.isArray(report?.extractionErrors)
                        ? report.extractionErrors
                        : [];

                const hasEnvFailure = missingToolsCheck.length > 0 ||
                    /ENVIRONMENT|TOOLCHAIN|MISSING_TOOL|ENOENT|spawn/i.test(String(report?.error || '')) ||
                    extractionErrorsCheck.some(e => /ENOENT|spawn|missing tool|missing binary|toolchain/i.test(String(e?.message || e || ''))) ||
                    report?.analysis_status === 'FAILED_RUNTIME_ENVIRONMENT';

                const findings = report.findings || report.issues || [];
                const hasBlockingFindings = findings.some(f => ['critical', 'error'].includes(String(f?.severity || '').toLowerCase()));
                const finalOk = !hasEnvFailure && !hasBlockingFindings;

                const artifactOutputDir = this.storage.getJobSubfolder(tenantId, jobId, 'output');
                const certifiedPath = path.join(artifactOutputDir, 'certified.pdf');

                if (!hasEnvFailure && finalOk) {
                    if (!(await fs.pathExists(certifiedPath))) {
                        console.log(`[CERTIFY][OUTPUT][${safeRequestId}] Promoting input as certified carrier for job: ${jobId}`);
                        await fs.copy(filePath, certifiedPath);
                        report.certification_basis = "analysis_input";
                    }
                } else {
                    console.warn(`[CERTIFY][BLOCKED] Certification blocked for job ${jobId} due to invalid runtime extraction or analysis failure.`);
                }

                const reportPath = path.join(artifactOutputDir, 'report.json');
                await fs.writeJson(reportPath, report);

                const artifacts = await this.getJobArtifacts(jobId, tenantId);

                // v2.4.120: Verify critical analysis artifacts
                const hasCertified = artifacts.some(a => a.type === 'certified_pdf');
                const hasReport = artifacts.some(a => a.type === 'analysis_report');

                const missingArtifacts = [];
                if (!hasReport) missingArtifacts.push('analysis_report');
                if (finalOk && !hasCertified) missingArtifacts.push('certified_pdf');

                if (missingArtifacts.length > 0) {
                    console.error(`[PREFLIGHT][INTEGRITY] Missing critical artifacts for job ${jobId}: ${missingArtifacts.join(', ')}`);
                }

                const hasArtifactFailure = missingArtifacts.length > 0;

                const jobObjForNorm = {
                    id: jobId,
                    status: hasEnvFailure ? 'FAILED' : 'COMPLETED',
                    job_type: 'ANALYZE',
                    error: report.error || (hasEnvFailure ? 'ENGINE_ENVIRONMENT_FAILURE' : null)
                };

                const normalizedPayload = this._normalizeJobPayload(jobObjForNorm, artifacts, {
                    ...report,
                    ok: finalOk && !hasArtifactFailure,
                    type: 'ANALYZE',
                    missingArtifacts,
                    artifactIntegrity: {
                        ready: !hasArtifactFailure,
                        missingArtifacts,
                        hasReport,
                        hasCertified
                    },
                    artifacts: artifacts.reduce((acc, a) => ({ ...acc, [a.type]: a.name }), {})
                });

                await db.execute(
                    "UPDATE jobs SET status = ?, input_bytes = ?, result = ? WHERE id = ?",
                    [
                        jobObjForNorm.status,
                        stats.size,
                        JSON.stringify(normalizedPayload.result),
                        jobId
                    ],
                    { tenantId, requestId: safeRequestId }
                );

                return {
                    ...normalizedPayload,
                    ...normalizedPayload.result,
                    id: jobId,
                    jobId,
                    ok: normalizedPayload.ok,
                    status: normalizedPayload.status
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

        // 1b. Check Source Job Analysis Integrity (Block if runtime extraction was invalid)
        try {
            const [sourceJobRow] = await db.query(
                "SELECT status, error, result FROM jobs WHERE id = ? AND tenant_id = ?",
                [assetId, tenantId]
            );
            if (sourceJobRow) {
                const sourceResult = typeof sourceJobRow.result === 'string'
                    ? JSON.parse(sourceJobRow.result) : sourceJobRow.result || {};

                const missingToolsSource = Array.isArray(sourceResult?.missing_tools) ? sourceResult.missing_tools :
                    Array.isArray(sourceResult?.forensics?.missing_tools) ? sourceResult.forensics.missing_tools :
                        Array.isArray(sourceResult?.analysis?.missing_tools) ? sourceResult.analysis.missing_tools :
                            Array.isArray(sourceResult?.environment?.missing_tools) ? sourceResult.environment.missing_tools :
                                Array.isArray(sourceResult?.meta?.missing_tools) ? sourceResult.meta.missing_tools :
                                    (typeof sourceResult?.missing_tools === 'string' ? [sourceResult.missing_tools] : []);

                const hasEnvFailure = missingToolsSource.length > 0 ||
                    sourceJobRow.error?.includes('ENVIRONMENT') ||
                    sourceResult?.analysis_status === 'FAILED_RUNTIME_ENVIRONMENT' ||
                    sourceResult?.analysis_type === 'DEGRADED';

                if (hasEnvFailure) {
                    console.warn(`[SERVICE][AUTOFIX][BLOCKED] Autofix blocked for asset ${assetId} due to invalid runtime extraction/environment failure.`);
                    throw new PPOSError(ErrorCodes.BAD_REQUEST, `Autofix blocked: Source job ${assetId} failed runtime environment validation/extraction fidelity.`, ErrorTypes.USER_ERROR);
                }
            }
        } catch (err) {
            if (err.isPPOSError || err.code === 'BAD_REQUEST') throw err;
            console.warn(`[SERVICE][AUTOFIX][CHECK-WARN] Could not check source job integrity: ${err.message}`);
        }

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

        // Resolve CMYK target from policy when no explicit target was set.
        // Mirrors AutofixProcessor.resolveFixPlan so inline (sync) and worker paths behave identically.
        // NOTE: runs even when options.type is already set (e.g. 'bleed') so CMYK is chained after the primary fix.
        if (!options.target) {
            const policyName = typeof effectivePolicy === 'string' ? effectivePolicy : (effectivePolicy?.name || effectivePolicy?.id || policy || '');
            const isCmykPolicy = /offset|coated|uncoated|iso|pso|cmyk/i.test(policyName);
            if (isCmykPolicy) {
                options = { ...options, target: 'cmyk' };
                console.log(`[SERVICE][AUTOFIX][DERIVED] CMYK target resolved from policy: ${policyName}`);
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

        // Phase 10: Timeout Detection for Polling
        if (job.status === 'FAILED' && (job.error === 'TIMEOUT' || result?.error === 'TIMEOUT')) {
            return {
                id: canonicalId,
                jobId: canonicalId,
                status: 'DEGRADED',
                ok: false,
                error: 'ANALYSIS_TIMEOUT',
                message: 'Analysis timed out. Results are unavailable.'
            };
        }

        // Canonical Primary Artifact Resolution
        const isAutofix = job.job_type === 'AUTOFIX';
        const primaryArtifact = isAutofix
            ? artifacts.find(a => a.type === 'final_fixed_pdf')
            : artifacts.find(a => a.type === 'certified_pdf');

        const primary_artifact_type = primaryArtifact?.type || null;
        const primary_artifact_name = primaryArtifact?.name || null;

        console.log(`[SERVICE][ARTIFACT] Primary resolved for ${job.job_type} job ${jobId}: ${primary_artifact_name} (${primary_artifact_type})`);

        let safeResult = result || {};
        safeResult.primary_artifact_type = primary_artifact_type;
        safeResult.primary_artifact_name = primary_artifact_name;

        // Verify environment failure to avoid overwriting error with generic ARTIFACT_MISSING
        const missingToolsPolled = Array.isArray(safeResult?.missing_tools) ? safeResult.missing_tools :
            Array.isArray(safeResult?.forensics?.missing_tools) ? safeResult.forensics.missing_tools :
                Array.isArray(safeResult?.analysis?.missing_tools) ? safeResult.analysis.missing_tools :
                    Array.isArray(safeResult?.environment?.missing_tools) ? safeResult.environment.missing_tools :
                        Array.isArray(safeResult?.meta?.missing_tools) ? safeResult.meta.missing_tools :
                            (typeof safeResult?.missing_tools === 'string' ? [safeResult.missing_tools] : []);

        const isEnvFailPolled = missingToolsPolled.length > 0 ||
            job.error?.includes('ENVIRONMENT') ||
            safeResult?.error?.includes('ENVIRONMENT') ||
            safeResult?.analysis_status === 'FAILED_RUNTIME_ENVIRONMENT' ||
            safeResult?.analysis_type === 'DEGRADED';

        if (job.status === 'COMPLETED' && !primaryArtifact && !isEnvFailPolled) {
            console.error(`[PREFLIGHT][INTEGRITY] Critical artifact missing for ${job.job_type} job ${jobId}`);
            if (!safeResult.error && !job.error) {
                safeResult.error = isAutofix ? 'NO_OUTPUT_GENERATED' : 'CERTIFIED_ARTIFACT_MISSING';
            }
        }

        // Autofix Effectiveness Validation (Phases 10+)
        let okPolled = safeResult?.ok ?? (job.status === 'COMPLETED');
        if (isAutofix && job.status === 'COMPLETED' && okPolled && primaryArtifact && safeResult?.autofix_effective === undefined) {
            try {
                const sourceJobId = safeResult?.sourceJobId;
                if (sourceJobId) {
                    const inputPath = await this._resolveCanonicalInputPdf(auth.tenantId, sourceJobId, 'AUTOFIX');
                    const outputPath = path.join(this.storage.getJobSubfolder(auth.tenantId, jobId, 'output'), primaryArtifact.name);

                    const isIdentical = await HashUtility.areFilesIdentical(inputPath, outputPath);

                    safeResult.autofix_attempted = true;
                    safeResult.autofix_effective = !isIdentical;
                    safeResult.no_effective_changes = isIdentical;

                    console.log(`[SERVICE][AUTOFIX][VALIDATION] Job ${jobId} Effectiveness: ${safeResult.autofix_effective ? 'REPAIRED' : 'NO_CHANGES'} (Identical: ${isIdentical})`);

                    await db.execute(
                        "UPDATE jobs SET result = ? WHERE id = ?",
                        [JSON.stringify(safeResult), jobId],
                        { tenantId: auth.tenantId }
                    );
                }
            } catch (err) {
                console.error(`[SERVICE][AUTOFIX][VALIDATION-NON-FATAL] Effectiveness check skipped for ${jobId}: ${err.message}`);
            }
        }

        return this._normalizeJobPayload(job, artifacts, safeResult);
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

    /**
     * _normalizeJobPayload
     * Enforces strict API normalization for job payloads and Control Plane compatibility adapters.
     * Prevents contradictory invariant states, deduplicates findings, and implements separate counters.
     */
    _normalizeJobPayload(job, artifacts, rawResult) {
        const canonicalId = job?.id || job?.jobId || 'unknown';
        const res = rawResult || {};
        const artifactList = Array.isArray(artifacts) ? artifacts : [];

        const unique = (items) => [...new Set((items || []).filter(Boolean).map(item => String(item)))];
        const asArray = (value) => {
            if (Array.isArray(value)) return value;
            if (typeof value === 'string' && value.trim()) return [value];
            return [];
        };
        const errorText = (value) => String(value?.message || value?.error || value || '');
        const isToolchainText = (value) => /ENOENT|spawn|MISSING_TOOL|missing tool|missing binary|toolchain|pdfinfo|pdfimages|mutool|ghostscript|\bgs\b|qpdf|exiftool/i.test(errorText(value));
        const isRuntimeInfraText = (value) => /ENGINE_RUNTIME|WORKER_UNAVAILABLE|WORKER_TIMEOUT|QUEUE_FAILURE|REDIS|RABBIT|STORAGE_RUNTIME|SERVICE_UNAVAILABLE|PROCESS_CRASH|TIMEOUT/i.test(errorText(value));
        const isArtifactText = (value) => /ARTIFACT|CERTIFIED_ARTIFACT_MISSING|NO_OUTPUT_GENERATED|REPORT_MISSING|OUTPUT_MISSING|MISSING_CRITICAL_ARTIFACT/i.test(errorText(value));

        // 1. Toolchain extraction: only native binary/tool failures belong here.
        const missingToolsRaw = Array.isArray(res.missing_tools) ? res.missing_tools :
            Array.isArray(res.forensics?.missing_tools) ? res.forensics.missing_tools :
                Array.isArray(res.analysis?.missing_tools) ? res.analysis.missing_tools :
                    Array.isArray(res.environment?.missing_tools) ? res.environment.missing_tools :
                        Array.isArray(res.meta?.missing_tools) ? res.meta.missing_tools :
                            (typeof res.missing_tools === 'string' ? [res.missing_tools] : []);
        const missingTools = unique(missingToolsRaw);
        const hasMissingTools = missingTools.length > 0;

        const extractionErrors = [
            ...asArray(res.extractionErrors),
            ...asArray(res.analysisIntegrity?.extractionErrors),
            ...asArray(res.environment?.extractionErrors),
            ...asArray(res.forensics?.extractionErrors)
        ];

        // 2. Raw error aggregation, then split into toolchain/runtime/artifact buckets.
        const rawErrorCandidates = [];
        if (job?.error) rawErrorCandidates.push(job.error);
        if (res.error && res.error !== job?.error) rawErrorCandidates.push(res.error);
        if (res.code && res.code !== job?.error && res.code !== res.error) rawErrorCandidates.push(res.code);
        if (res.analysis_status === 'FAILED_RUNTIME_ENVIRONMENT' || res.status === 'FAILED_RUNTIME_ENVIRONMENT') {
            rawErrorCandidates.push('FAILED_RUNTIME_ENVIRONMENT');
        }

        const toolchainErrors = unique([
            ...missingTools.map(tool => `MISSING_TOOL:${tool}`),
            ...extractionErrors.filter(isToolchainText).map(errorText),
            ...rawErrorCandidates.filter(isToolchainText).map(errorText)
        ]);

        const runtimeInfraErrors = unique([
            ...rawErrorCandidates.filter(e => !isArtifactText(e) && isRuntimeInfraText(e)).map(errorText),
            ...extractionErrors.filter(e => !isToolchainText(e) && isRuntimeInfraText(e)).map(errorText)
        ]);

        const artifactErrors = unique([
            ...asArray(res.artifactErrors),
            ...rawErrorCandidates.filter(isArtifactText).map(errorText)
        ]);

        const explicitMissingArtifacts = unique([
            ...asArray(res.missingArtifacts),
            ...asArray(res.artifactIntegrity?.missingArtifacts)
        ]);

        const hasReportArtifact = artifactList.some(a => a.type === 'analysis_report');
        const hasCertifiedArtifact = artifactList.some(a => a.type === 'certified_pdf');

        const rawFindings = Array.isArray(res.findings) && res.findings.length > 0 ? res.findings :
            Array.isArray(res.issues) && res.issues.length > 0 ? res.issues :
                Array.isArray(res.analysis?.issues) && res.analysis.issues.length > 0 ? res.analysis.issues :
                    Array.isArray(res.forensics?.findings) && res.forensics.findings.length > 0 ? res.forensics.findings :
                        [];

        const documentFindings = rawFindings.filter(f =>
            !f.isEnvironmentError &&
            f.type !== 'ENVIRONMENT' &&
            !String(f.code || '').includes('TOOL') &&
            !/missing binary|missing tool|toolchain/i.test(String(f.message || ''))
        );

        const hasBlockingFindings = documentFindings.some(f => ['critical', 'error'].includes(String(f?.severity || '').toLowerCase()));
        const wouldBeDocumentCertifiable = !hasBlockingFindings;

        const inferredMissingArtifacts = [];
        if (!hasReportArtifact && (res.artifacts || artifactList.length > 0 || res.artifactIntegrity)) {
            inferredMissingArtifacts.push('analysis_report');
        }
        if (wouldBeDocumentCertifiable && res.certifiable !== false && res.artifactIntegrity?.requiresCertified !== false && res.type !== 'AUTOFIX' && job?.job_type !== 'AUTOFIX') {
            if (!hasCertifiedArtifact && (res.artifacts || artifactList.length > 0 || res.artifactIntegrity)) {
                inferredMissingArtifacts.push('certified_pdf');
            }
        }

        const missingArtifacts = unique([...explicitMissingArtifacts, ...inferredMissingArtifacts]);
        const hasArtifactFailure = missingArtifacts.length > 0 || artifactErrors.length > 0;

        const isToolchainFailure = hasMissingTools || toolchainErrors.length > 0;
        const isRuntimeInfraFailure = runtimeInfraErrors.length > 0 || rawErrorCandidates.includes('FAILED_RUNTIME_ENVIRONMENT');
        const isEnvFailure = isToolchainFailure || isRuntimeInfraFailure;

        const runtimeErrors = unique([...toolchainErrors, ...runtimeInfraErrors]);

        // Enforce invariants and log warnings if raw payload was contradictory.
        const rawDegradedMode = res.analysisIntegrity?.degradedMode ?? res.degradedMode;
        const rawExtractionFidelity = res.analysisIntegrity?.extractionFidelity ?? res.extractionFidelity ?? res.extraction_fidelity;
        const rawAnalysisStatus = res.analysis_status ?? res.status ?? job?.status;

        if (isEnvFailure) {
            if (rawDegradedMode === false || rawExtractionFidelity === 'REAL_EXTRACTION' || rawAnalysisStatus === 'COMPLETED' || rawAnalysisStatus === 'PASS') {
                console.warn(`[SERVICE][CONTRACT][INVARIANT-VIOLATION] Contradictory payload detected. Runtime/toolchain failure present but received degradedMode=${rawDegradedMode}, fidelity=${rawExtractionFidelity}. Overwriting to enforce invariants.`);
            }
            if (isToolchainFailure) {
                console.log(`[SERVICE][INTEGRITY][TOOLCHAIN-FAILURE] Enforcing degraded integrity invariants due to missing or failed industrial tools.`);
            } else {
                console.log(`[SERVICE][INTEGRITY][RUNTIME-FAILURE] Enforcing degraded integrity invariants due to infrastructure/runtime failure.`);
            }
            console.log(`[SERVICE][NORMALIZE][ENVIRONMENT-FAILURE] Normalizing result payload to FAILED_RUNTIME_ENVIRONMENT.`);
        } else if (hasArtifactFailure) {
            console.log(`[SERVICE][INTEGRITY][ARTIFACT-PARTIAL] Missing or invalid output artifacts for job ${canonicalId}: ${missingArtifacts.join(', ') || artifactErrors.join(', ')}`);
            console.log(`[SERVICE][NORMALIZE][ARTIFACT-PARTIAL] Normalizing result payload to PARTIAL_ARTIFACTS.`);
        }

        // Establish outcome category.
        let outcomeCategory = 'SUCCESS';
        if (isEnvFailure) {
            outcomeCategory = 'ENVIRONMENT_FAILURE';
        } else if (hasArtifactFailure) {
            outcomeCategory = 'ARTIFACT_INTEGRITY_FAILURE';
        } else if (hasBlockingFindings) {
            outcomeCategory = 'PDF_DOCUMENT_FAILURE';
        } else if (documentFindings.length > 0) {
            outcomeCategory = 'SUCCESS_WITH_FINDINGS';
        }

        const integrityFailureClass = isEnvFailure
            ? (isToolchainFailure ? 'TOOLCHAIN_FAILURE' : 'RUNTIME_INFRA_FAILURE')
            : hasArtifactFailure
                ? 'ARTIFACT_INTEGRITY_FAILURE'
                : null;

        // Runtime/toolchain failures degrade extraction. Artifact failures do not: they mean extraction ran but outputs are incomplete.
        const extractionFidelity = isEnvFailure ? 'DEGRADED' : (rawExtractionFidelity || 'REAL_EXTRACTION');
        const scoreBasis = isEnvFailure ? 'ENVIRONMENT_FAILURE' : (documentFindings.length > 0 ? 'DOCUMENT_FINDINGS' : 'CLEAN');
        const certifiable = !isEnvFailure && !hasArtifactFailure && !hasBlockingFindings;

        const certificationBlockedReason = isEnvFailure
            ? `Runtime environment validation failed. ${missingTools.length ? `Missing required tools: ${missingTools.join(', ')}` : 'Worker/engine runtime failure.'}`
            : hasArtifactFailure
                ? `Artifact integrity incomplete. Missing artifacts: ${missingArtifacts.join(', ') || 'required output artifact'}`
                : (!certifiable ? 'Document contains unrectified critical defects or errors.' : null);

        const baseRiskScore = res.summary?.risk_score ?? res.risk_score ?? 100;
        const riskScore = isEnvFailure ? 0 : baseRiskScore;

        const summary = {
            ...(res.summary || {}),
            issue_count: documentFindings.length,
            environment_errors: isEnvFailure ? Math.max(runtimeErrors.length, missingTools.length, 1) : 0,
            artifact_errors: hasArtifactFailure ? Math.max(missingArtifacts.length, artifactErrors.length, 1) : 0,
            risk_score: riskScore
        };

        const toolchainIntegrity = {
            ready: !isToolchainFailure,
            missingTools,
            errors: toolchainErrors
        };

        const runtimeIntegrity = {
            ready: !isRuntimeInfraFailure,
            errors: runtimeInfraErrors
        };

        const artifactIntegrity = {
            ready: !hasArtifactFailure,
            missingArtifacts,
            errors: artifactErrors,
            hasReport: hasReportArtifact,
            hasCertified: hasCertifiedArtifact
        };

        const analysisIntegrity = {
            degradedMode: isEnvFailure,
            realExtraction: !isEnvFailure,
            certifiable,
            extractionFidelity,
            scoreBasis,
            integrityFailureClass,
            toolchainIntegrity,
            runtimeIntegrity,
            artifactIntegrity
        };

        const analysisStatus = isEnvFailure
            ? 'FAILED_RUNTIME_ENVIRONMENT'
            : hasArtifactFailure
                ? 'PARTIAL_ARTIFACTS'
                : documentFindings.length > 0
                    ? 'COMPLETED_WITH_FINDINGS'
                    : 'COMPLETED';

        const normalizedResult = {
            ...res,
            ok: !isEnvFailure && !hasArtifactFailure && (res.ok ?? (!hasBlockingFindings)),
            analysis_type: isEnvFailure ? 'DEGRADED' : (res.analysis_type || job?.job_type || 'ANALYZE'),
            analysis_status: analysisStatus,
            outcome_category: outcomeCategory,
            integrityFailureClass,
            runtimeErrors,
            toolchainErrors,
            artifactErrors,
            missingTools,
            missingArtifacts,
            toolchainIntegrity,
            runtimeIntegrity,
            artifactIntegrity,
            extractionFidelity,
            scoreBasis,
            certificationBlockedReason,
            certifiable,
            analysisIntegrity,
            summary,
            findings: documentFindings
        };

        // Explicitly remove redundant repeated finding arrays.
        delete normalizedResult.issues;
        if (normalizedResult.analysis) {
            delete normalizedResult.analysis.issues;
        }
        if (normalizedResult.forensics) {
            delete normalizedResult.forensics.findings;
        }

        const finalJobStatus = isEnvFailure ? 'FAILED' : (job?.status || 'COMPLETED');
        const finalError = isEnvFailure
            ? (runtimeErrors[0] || 'ENGINE_ENVIRONMENT_FAILURE')
            : hasArtifactFailure
                ? (artifactErrors[0] || missingArtifacts[0] || 'ARTIFACT_INTEGRITY_FAILURE')
                : (normalizedResult.error || job?.error || null);

        const partial = !isEnvFailure && (hasArtifactFailure || (documentFindings.length > 0 && !hasBlockingFindings));
        const analysis_warnings = partial ? documentFindings : [];

        return {
            id: canonicalId,
            jobId: canonicalId,
            ok: normalizedResult.ok,
            status: finalJobStatus,
            type: job?.job_type || normalizedResult.analysis_type,
            progress: job?.progress || (finalJobStatus === 'COMPLETED' ? 100 : 0),
            result: normalizedResult,
            error: finalError,
            message: normalizedResult.message || (isEnvFailure
                ? 'Runtime environment validation failed.'
                : hasArtifactFailure
                    ? 'Analysis completed but required artifacts are incomplete.'
                    : null),
            partial,
            analysis_warnings,
            createdAt: job?.created_at || new Date().toISOString(),
            artifacts: artifactList
        };
    }
}

module.exports = PreflightService;
