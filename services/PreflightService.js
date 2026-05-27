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

function classifyEngineResult(report) {
    if (!report) return 'FULL_ENVIRONMENT_FAILURE';
    
    // Gather findings from all possible locations
    const findings = [
        ...(Array.isArray(report.findings) ? report.findings : []),
        ...(Array.isArray(report.issues) ? report.issues : []),
        ...(Array.isArray(report.analysis?.findings) ? report.analysis.findings : []),
        ...(Array.isArray(report.analysis?.issues) ? report.analysis.issues : []),
        ...(Array.isArray(report.forensics?.findings) ? report.forensics.findings : [])
    ];
    
    const missingToolsCheck = Array.isArray(report?.missing_tools) ? report.missing_tools :
        Array.isArray(report?.forensics?.missing_tools) ? report.forensics.missing_tools :
        Array.isArray(report?.analysis?.missing_tools) ? report.analysis.missing_tools :
        Array.isArray(report?.environment?.missing_tools) ? report.environment.missing_tools :
        Array.isArray(report?.meta?.missing_tools) ? report.meta.missing_tools :
        (typeof report?.missing_tools === 'string' ? [report.missing_tools] : []);

    const hasMissingTools = missingToolsCheck.length > 0;
    
    const hasCoverage = report.analyzerCoverage || report.analyzer_coverage || report.analysis?.analyzerCoverage;
    const hasSummary = report.summary || report.analysis?.summary;
    const hasUsableResult = findings.length > 0 || hasSummary || hasCoverage;
    
    const realExtraction = report.analysisIntegrity?.realExtraction ?? report.realExtraction;
    const degradedMode = report.analysisIntegrity?.degradedMode ?? report.degradedMode;
    
    const hardRuntimeError = /ENVIRONMENT|TOOLCHAIN|MISSING_TOOL|ENOENT|spawn/i.test(String(report.error || '')) && !hasUsableResult;

    // 1. FULL_ENVIRONMENT_FAILURE
    if (
        report.analysis_status === 'FAILED_RUNTIME_ENVIRONMENT' ||
        report.status === 'FAILED_RUNTIME_ENVIRONMENT' ||
        (realExtraction === false && !hasUsableResult) ||
        hardRuntimeError
    ) {
        return 'FULL_ENVIRONMENT_FAILURE';
    }
    
    // 2. DEGRADED_ANALYSIS
    if (
        hasMissingTools ||
        degradedMode === true
    ) {
        if (hasUsableResult || realExtraction !== false) {
            return 'DEGRADED_ANALYSIS';
        }
    }
    
    // 3. PARTIAL_ANALYSIS
    const partialOrSkippedCoverage = 
        (report.analyzerCoverage?.partial && report.analyzerCoverage.partial.length > 0) ||
        (report.analyzerCoverage?.skipped && report.analyzerCoverage.skipped.length > 0) ||
        (report.analyzer_coverage?.partial && report.analyzer_coverage.partial.length > 0) ||
        (report.analyzer_coverage?.skipped && report.analyzer_coverage.skipped.length > 0);
        
    if (
        report.analysis_status === 'PARTIAL' ||
        report.status === 'PARTIAL' ||
        partialOrSkippedCoverage
    ) {
        return 'PARTIAL_ANALYSIS';
    }
    
    // 4. DOCUMENT_FAILURE
    const hasBlockingFindings = findings.some(f => ['critical', 'error'].includes(String(f?.severity || '').toLowerCase()));
    if (hasBlockingFindings) {
        return 'DOCUMENT_FAILURE';
    }
    
    // 5. SUCCESS
    return 'SUCCESS';
}

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
                const engineClass = classifyEngineResult(report);
                const hasEnvFailure = engineClass === 'FULL_ENVIRONMENT_FAILURE';

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

        // 1b. Check Source Job Analysis Integrity (Block ONLY if full environment failure is classified)
        let sourceResultObj = null;
        try {
            const [sourceJobRow] = await db.query(
                "SELECT status, error, result FROM jobs WHERE id = ? AND tenant_id = ?",
                [assetId, tenantId]
            );
            if (sourceJobRow) {
                const sourceResult = typeof sourceJobRow.result === 'string'
                    ? JSON.parse(sourceJobRow.result) : sourceJobRow.result || {};
                sourceResultObj = sourceResult;

                const engineClass = classifyEngineResult(sourceResult);

                const hasEnvFailure = engineClass === 'FULL_ENVIRONMENT_FAILURE' ||
                    (sourceJobRow.error && /ENVIRONMENT|TOOLCHAIN|MISSING_TOOL|ENOENT|spawn/i.test(sourceJobRow.error)) ||
                    sourceResult?.analysis_status === 'FAILED_RUNTIME_ENVIRONMENT' ||
                    sourceResult?.status === 'FAILED_RUNTIME_ENVIRONMENT';

                if (hasEnvFailure) {
                    console.warn(`[SERVICE][AUTOFIX][BLOCKED] Autofix blocked for asset ${assetId} due to invalid runtime extraction/environment failure.`);
                    throw new PPOSError(ErrorCodes.BAD_REQUEST, `Autofix blocked: Source job ${assetId} failed runtime environment validation/extraction fidelity.`, ErrorTypes.USER_ERROR);
                }
            }
        } catch (err) {
            if (err.isPPOSError || err.code === 'BAD_REQUEST') throw err;
            console.warn(`[SERVICE][AUTOFIX][CHECK-WARN] Could not check source job integrity: ${err.message}`);
        }

        // Fallback Derivation Logic for AUTOFIX requested_fixes
        const reqBody = contextRequest?.body || {};
        const asFlatArray = (val) => {
            if (Array.isArray(val)) return val;
            if (typeof val === 'string' && val.trim()) return [val.trim()];
            return [];
        };

        let rawRequested = [
            ...asFlatArray(options.requested_fixes),
            ...asFlatArray(options.fixes),
            ...asFlatArray(options.requestedFixes),
            ...asFlatArray(reqBody.requested_fixes),
            ...asFlatArray(reqBody.fixes),
            ...asFlatArray(reqBody.requestedFixes)
        ].filter(f => typeof f === 'string' && f.trim());

        let derivedFixes = [...rawRequested];

        if (derivedFixes.length === 0) {
            // Derive requested_fixes from source job findings before calling Engine
            if (sourceResultObj) {
                const sFindings = [
                    ...(Array.isArray(sourceResultObj.findings) ? sourceResultObj.findings : []),
                    ...(Array.isArray(sourceResultObj.issues) ? sourceResultObj.issues : []),
                    ...(Array.isArray(sourceResultObj.analysis?.findings) ? sourceResultObj.analysis.findings : []),
                    ...(Array.isArray(sourceResultObj.analysis?.issues) ? sourceResultObj.analysis.issues : []),
                    ...(Array.isArray(sourceResultObj.forensics?.findings) ? sourceResultObj.forensics.findings : [])
                ];
                sFindings.forEach(f => {
                    if (f && typeof f === 'object') {
                        if (typeof f.repairStrategy === 'string' && f.repairStrategy.trim()) derivedFixes.push(f.repairStrategy.trim());
                        if (typeof f.fix_method === 'string' && f.fix_method.trim()) derivedFixes.push(f.fix_method.trim());
                        if (typeof f.recommended_fix === 'string' && f.recommended_fix.trim()) derivedFixes.push(f.recommended_fix.trim());
                    }
                });
            }

            if (derivedFixes.length === 0) {
                console.log('[SERVICE][FIX-ACTION][NO_REQUESTED_FIXES] No requested fixes provided by client and none could be derived from source job findings.');
            }
        }

        const orderMap = {
            'REBUILD_TRIMBOX': 1,
            'APPLY_BLEED': 2,
            'CONVERT_CMYK': 3,
            'INJECT_OUTPUT_INTENT': 4
        };

        derivedFixes = [...new Set(derivedFixes)];
        derivedFixes.sort((a, b) => {
            const orderA = orderMap[a] ?? 999;
            const orderB = orderMap[b] ?? 999;
            return orderA - orderB;
        });

        const fixesArray = derivedFixes;
        const requestedFixesArray = derivedFixes;
        options.fixes = fixesArray;
        options.requested_fixes = requestedFixesArray;

        const forceBleedFlag = options.forceBleed ?? false;
        const targetProfileStr = options.targetProfile ?? 'FOGRA51';

        console.log(`[SERVICE][FIX-ACTION][REQUEST] Received fix action request. SourceJobId: ${assetId}, FixJobId: ${jobId}, RequestedFixes: ${JSON.stringify(requestedFixesArray)}, ForceBleed: ${forceBleedFlag}, TargetProfile: ${targetProfileStr}`);

        const hasExplicitFixes = fixesArray.length > 0;
        if (!options.type && hasExplicitFixes) {
            options.type = 'composite';
        }

        // Derive fix plan from source job issues when caller doesn't specify a type
        if (!options.type && !options.repairStrategy && !options.forceBleed && !hasExplicitFixes) {
            try {
                const sourceResult = sourceResultObj || {};
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
                JSON.stringify({ 
                    sourceJobId: assetId, 
                    targetJobId: jobId,
                    requested_fixes: requestedFixesArray,
                    fixes: fixesArray,
                    forceBleed: forceBleedFlag,
                    targetProfile: targetProfileStr
                })
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
                    fixes: fixesArray,
                    requested_fixes: requestedFixesArray,
                    forceBleed: forceBleedFlag,
                    targetProfile: targetProfileStr,
                    autofix_attempted: true
                };

                await db.execute(
                    "UPDATE jobs SET status = ?, result = ? WHERE id = ?",
                    [fixResult.ok ? 'COMPLETED' : 'FAILED', JSON.stringify(resultPayload), jobId],
                    { tenantId, requestId: safeRequestId }
                );

                const syncResponse = {
                    id: jobId,
                    jobId,
                    sourceJobId: assetId,
                    targetJobId: jobId,
                    type: 'AUTOFIX',
                    ok: fixResult.ok,
                    status: fixResult.ok ? 'COMPLETED' : 'FAILED',
                    repairs: fixResult.repairs || [],
                    fixes: fixesArray,
                    requested_fixes: requestedFixesArray,
                    forceBleed: forceBleedFlag,
                    targetProfile: targetProfileStr
                };
                console.log(`[SERVICE][FIX-ACTION][RESPONSE] Returning immediate inline response. SourceJobId: ${assetId}, FixJobId: ${jobId}, RepairsCount: ${syncResponse.repairs.length}, SkippedCount: 0, FailedCount: 0`);
                return syncResponse;
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
            type: 'AUTOFIX',
            sourceJobId: assetId,
            requested_fixes: requestedFixesArray,
            fixes: fixesArray,
            forceBleed: forceBleedFlag,
            targetProfile: targetProfileStr,
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

        console.log(`[SERVICE][FIX-ACTION][QUEUE-PAYLOAD] Enqueueing worker payload. SourceJobId: ${assetId}, FixJobId: ${jobId}, QueuedFixesCount: ${fixesArray.length}, ForceBleed: ${forceBleedFlag}, TargetProfile: ${targetProfileStr}`);
        console.log(`[PRELIGHT][JOBS] Emitting V2 AUTOFIX contract for job: ${jobId} (Tenant: ${tenantId}, Profile: ${resolvedPolicyProfile})`);

        const enqueueResult = await this.worker.enqueue('AUTOFIX', jobEnvelope);

        const finalResponse = {
            ...enqueueResult,
            id: jobId,
            jobId: jobId,
            sourceJobId: assetId,
            targetJobId: jobId,
            type: 'AUTOFIX',
            requested_fixes: requestedFixesArray,
            fixes: fixesArray,
            forceBleed: forceBleedFlag,
            targetProfile: targetProfileStr
        };

        console.log(`[SERVICE][AUTOFIX][RESPONSE-CONTRACT] Generated for job: ${jobId} | Source: ${assetId}`);
        console.log(`[SERVICE][FIX-ACTION][RESPONSE] Returning immediate async response. SourceJobId: ${assetId}, FixJobId: ${jobId}, QueuedFixesCount: ${fixesArray.length}, RepairsCount: 0, SkippedCount: 0, FailedCount: 0`);
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
     * Lists jobs with Service persistence/source of truth, pagination, and tenant isolation.
     */
    async listJobs(context, options = {}) {
        const safeContext = context || {};
        const { auth } = safeContext;
        
        let parsedLimit = parseInt(options.limit, 10);
        if (isNaN(parsedLimit) || parsedLimit < 1) {
            parsedLimit = 50;
        } else if (parsedLimit > 100) {
            parsedLimit = 100;
        }

        let parsedOffset = parseInt(options.offset, 10);
        if (isNaN(parsedOffset) || parsedOffset < 0) {
            parsedOffset = 0;
        }

        const statusParam = options.status ? String(options.status).trim() : '';
        const typeParam = options.type ? String(options.type).trim() : '';
        const requestedTenantId = options.tenantId ? String(options.tenantId).trim() : '';

        console.log('[SERVICE][JOBS][LIST-REQUEST] Listing jobs requested.', { limit: parsedLimit, offset: parsedOffset, status: statusParam, type: typeParam, tenantId: requestedTenantId });

        if (!auth || !auth.tenantId) {
            const errMsg = 'Tenant identification is mandatory for listing jobs.';
            console.error('[SERVICE][JOBS][LIST-ERROR] Listing jobs failed.', { code: 'UNAUTHORIZED', message: errMsg });
            throw new Error(errMsg);
        }

        try {
            const isAdmin = ['admin', 'super_admin', 'superadmin', 'system_admin', 'owner', 'legacy_admin'].includes(String(auth.role || '').toLowerCase()) || 
                            (auth.scopes && auth.scopes.includes('*'));

            const conditions = [];
            const params = [];

            let targetTenantId = requestedTenantId;
            if (targetTenantId) {
                if (!isAdmin && targetTenantId !== auth.tenantId) {
                    targetTenantId = auth.tenantId;
                }
                conditions.push("tenant_id = ?");
                params.push(targetTenantId);
            } else {
                if (!isAdmin) {
                    conditions.push("tenant_id = ?");
                    params.push(auth.tenantId);
                }
            }

            if (statusParam) {
                conditions.push("status = ?");
                params.push(String(statusParam).toUpperCase());
            }

            if (typeParam) {
                conditions.push("job_type = ?");
                params.push(String(typeParam).toUpperCase());
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

            // 1. Total count query
            const countSql = `SELECT COUNT(*) as total FROM jobs ${whereClause}`;
            const countRows = await db.query(countSql, params);
            const total = countRows[0]?.total ? parseInt(countRows[0].total, 10) : 0;

            // 2. Fetch jobs query (safely inlining sanitized integers to prevent ER_WRONG_ARGUMENTS)
            const fetchSql = `SELECT id, tenant_id, deployment_id, user_id, job_type, status, idempotency_key, input_bytes, output_bytes, result, error, created_at, updated_at FROM jobs ${whereClause} ORDER BY created_at DESC LIMIT ${parsedLimit} OFFSET ${parsedOffset}`;
            
            console.log('[SERVICE][JOBS][LIST-SQL] Executing query.', { sql: fetchSql, params });
            
            const rows = await db.query(fetchSql, params);

            // 3. Process each job using Service source of truth
            const jobs = [];
            for (const row of rows) {
                const canonicalId = row.id;
                let resObj = {};
                if (typeof row.result === 'string') {
                    try { resObj = JSON.parse(row.result); } catch (e) {}
                } else if (row.result && typeof row.result === 'object') {
                    resObj = row.result;
                }

                // Retrieve artifacts if available
                const artifacts = await this.getJobArtifacts(canonicalId, row.tenant_id);

                // Run baseline normalization
                const normalized = this._normalizeJobPayload(row, artifacts, resObj);

                const isAutofix = row.job_type === 'AUTOFIX';
                const filename = resObj.meta?.filename || resObj.document?.filename || resObj.filename || 'document.pdf';
                const size = resObj.meta?.size !== undefined ? resObj.meta.size : (resObj.document?.size !== undefined ? resObj.document.size : (row.input_bytes || 0));

                const jobEnvelope = {
                    ...normalized,
                    jobId: canonicalId,
                    id: canonicalId,
                    sourceJobId: resObj.sourceJobId || null,
                    type: row.job_type || normalized.type,
                    status: normalized.status || row.status,
                    progress: row.progress !== undefined && row.progress !== null ? row.progress : (normalized.status === 'COMPLETED' ? 100 : 0),
                    tenantId: row.tenant_id,
                    policy: resObj.policy || resObj.policyProfile || row.deployment_id || 'default',
                    document: { filename, size },
                    meta: { filename, size },
                    createdAt: row.created_at || new Date().toISOString(),
                    updatedAt: row.updated_at || row.created_at || new Date().toISOString(),
                    ...(isAutofix ? {
                        requested_fixes: resObj.requested_fixes || resObj.fixes || [],
                        fixes: resObj.fixes || resObj.requested_fixes || [],
                        repairs: resObj.repairs || []
                    } : {})
                };

                jobs.push(jobEnvelope);
            }

            console.log('[SERVICE][JOBS][LIST-RESULT] Listing jobs successful.', { count: jobs.length, total });

            return {
                ok: true,
                total,
                jobs,
                source_status: "SERVICE_RUNTIME"
            };

        } catch (err) {
            console.error('[SERVICE][JOBS][LIST-ERROR] Listing jobs failed.', { code: err.code || 'UNKNOWN_ERROR', message: err.message });
            throw err;
        }
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
        const polledEngineClass = classifyEngineResult(safeResult);
        const isEnvFailPolled =
            polledEngineClass === 'FULL_ENVIRONMENT_FAILURE' ||
            job.error?.includes('ENVIRONMENT') ||
            safeResult?.error?.includes('ENVIRONMENT') ||
            safeResult?.analysis_status === 'FAILED_RUNTIME_ENVIRONMENT' ||
            safeResult?.status === 'FAILED_RUNTIME_ENVIRONMENT';

        const rawFindingsPolled = Array.isArray(safeResult.findings) && safeResult.findings.length > 0 ? safeResult.findings :
            Array.isArray(safeResult.issues) && safeResult.issues.length > 0 ? safeResult.issues :
                Array.isArray(safeResult.analysis?.findings) && safeResult.analysis.findings.length > 0 ? safeResult.analysis.findings :
                Array.isArray(safeResult.analysis?.issues) && safeResult.analysis.issues.length > 0 ? safeResult.analysis.issues :
                    Array.isArray(safeResult.forensics?.findings) && safeResult.forensics.findings.length > 0 ? safeResult.forensics.findings :
                        [];
        const hasBlockingFindingsPolled = rawFindingsPolled.some(f => ['critical', 'error'].includes(String(f?.severity || '').toLowerCase()));
        const isExplicitlyCertifiablePolled = safeResult.certifiable === true || safeResult.analysisIntegrity?.certifiable === true || safeResult.analysis?.certifiable === true;
        const isInputCertifiablePolled = isExplicitlyCertifiablePolled || (safeResult.certifiable === undefined && safeResult.analysisIntegrity?.certifiable === undefined && !hasBlockingFindingsPolled);
        const expectsCertifiedPolled = !isEnvFailPolled && isInputCertifiablePolled === true && !hasBlockingFindingsPolled && !isAutofix;

        const isPrimaryRequired = isAutofix ? true : expectsCertifiedPolled;
        if (job.status === 'COMPLETED' && !primaryArtifact && !isEnvFailPolled && isPrimaryRequired) {
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

        if (isAutofix) {
            const requestedFixesList = safeResult.requested_fixes || safeResult.fixes || [];
            const repairsList = safeResult.repairs || [];
            const skippedList = safeResult.skipped_fixes || [];
            const failedList = safeResult.failed_fixes || [];
            console.log(`[SERVICE][JOB-STATUS][AUTOFIX-RESULT] Autofix result polled. SourceJobId: ${safeResult.sourceJobId || 'unknown'}, FixJobId: ${jobId}, RequestedFixes: ${JSON.stringify(requestedFixesList)}, ForceBleed: ${!!safeResult.forceBleed}, TargetProfile: ${safeResult.targetProfile || 'FOGRA51'}, RepairsCount: ${repairsList.length}, Repairs: ${JSON.stringify(repairsList)}, SkippedCount: ${skippedList.length}, Skipped: ${JSON.stringify(skippedList)}, FailedCount: ${failedList.length}, Failed: ${JSON.stringify(failedList)}`);
        }

        return this._normalizeJobPayload(job, artifacts, safeResult);
    }


    async getJobArtifacts(jobId, tenantId) {
        const artifacts = [];
        const outputDir = this.storage.getJobSubfolder(tenantId, jobId, 'output');

        let requiresReview = false;
        let productionCertified = true;
        let isAutofix = false;
        let status = '';

        try {
            const [jobRows] = await db.query("SELECT * FROM jobs WHERE id = ? AND tenant_id = ?", [jobId, tenantId]);
            const job = jobRows[0];
            if (job) {
                isAutofix = job.job_type === 'AUTOFIX';
                status = job.status;
                let res = {};
                if (typeof job.result === 'string') {
                    try { res = JSON.parse(job.result); } catch(e) {}
                } else if (job.result && typeof job.result === 'object') {
                    res = job.result;
                }
                
                productionCertified = res.production_certified !== false && res.productionCertified !== false && res.summary?.after?.production_certified !== false;
                requiresReview = res.requires_human_review === true || res.requiresHumanReview === true || res.summary?.after?.requires_human_review === true || status === "COMPLETED_WITH_REVIEW" || status === "AUTOFIX_PARTIAL" || productionCertified === false;
            }
        } catch(e) {
            console.warn(`[ARTIFACT-DISCOVERY-WARN] Could not fetch job ${jobId} for review status check: ${e.message}`);
        }

        try {
            if (await fs.pathExists(outputDir)) {
                const files = await fs.readdir(outputDir);
                for (const file of files) {
                    const filePath = path.join(outputDir, file);
                    const stats = await fs.stat(filePath);

                    const pushArtifact = (type) => {
                        artifacts.push({
                            id: Buffer.from(`${jobId}:${type}:${file}`).toString('base64').replace(/=/g, ''),
                            jobId,
                            type,
                            name: file,
                            path: `/jobs/${jobId}/output/${file}`,
                            mimeType: this._getMimeByExt(path.extname(file)),
                            size: stats.size,
                            createdAt: stats.birthtime,
                            status: 'READY'
                        });
                    };

                    if (file === 'report.json') {
                        pushArtifact('analysis_report');
                        pushArtifact('report_json');
                    } else if (file === 'fix_audit.json') {
                        pushArtifact('fix_audit');
                    } else if (file === 'certified.pdf') {
                        pushArtifact('certified_pdf');
                    } else if (file === 'fixed.pdf') {
                        pushArtifact('fixed_pdf');
                        pushArtifact('final_fixed_pdf');
                        if (requiresReview || (isAutofix && ['AUTOFIX_PARTIAL', 'COMPLETED_WITH_REVIEW'].includes(status))) {
                            pushArtifact('review_pdf');
                        }
                    } else if (file === 'normalized.pdf') {
                        pushArtifact('normalized_pdf');
                        if (!files.includes('fixed.pdf')) {
                            pushArtifact('final_fixed_pdf');
                            if (requiresReview || (isAutofix && ['AUTOFIX_PARTIAL', 'COMPLETED_WITH_REVIEW'].includes(status))) {
                                pushArtifact('review_pdf');
                            }
                        }
                    } else if (file.endsWith('.png')) {
                        pushArtifact('page_preview');
                    } else {
                        pushArtifact('output_file');
                    }
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

        // Return the full production-ready catalog with extensive intelligence metadata
        return {
            source: 'LOCAL_CATALOG',
            fallbackMode: false,
            policyVersion: '1.0.0',
            loadedAt: new Date().toISOString(),
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

        const engineClass = classifyEngineResult(res);
        const isEnvFailure = engineClass === 'FULL_ENVIRONMENT_FAILURE';

        const toolchainErrors = unique([
            ...missingTools.map(tool => `MISSING_TOOL:${tool}`),
            ...extractionErrors.filter(isToolchainText).map(errorText),
            ...rawErrorCandidates.filter(isToolchainText).map(errorText)
        ]);

        const runtimeInfraErrors = unique([
            ...rawErrorCandidates.filter(e => !isArtifactText(e) && isRuntimeInfraText(e)).map(errorText),
            ...extractionErrors.filter(e => !isToolchainText(e) && isRuntimeInfraText(e)).map(errorText)
        ]);

        const isToolchainFailure = isEnvFailure && hasMissingTools;
        const isRuntimeInfraFailure = isEnvFailure && !hasMissingTools;
        const runtimeErrors = unique([...toolchainErrors, ...runtimeInfraErrors]);

        const hasReportArtifact = artifactList.some(a => a.type === 'analysis_report');
        const hasCertifiedArtifact = artifactList.some(a => a.type === 'certified_pdf');

        // Merge findings from all sources
        const collectedFindings = [
            ...(Array.isArray(res.findings) ? res.findings : []),
            ...(Array.isArray(res.issues) ? res.issues : []),
            ...(Array.isArray(res.analysis?.findings) ? res.analysis.findings : []),
            ...(Array.isArray(res.analysis?.issues) ? res.analysis.issues : []),
            ...(Array.isArray(res.forensics?.findings) ? res.forensics.findings : [])
        ];

        // Deduplicate findings by id if present, else by code + page + severity + message
        const seenFindings = new Set();
        const mergedFindings = [];
        for (const finding of collectedFindings) {
            if (!finding || typeof finding !== 'object') continue;
            let key;
            if (finding.id) {
                key = `id:${finding.id}`;
            } else {
                key = `key:${finding.code || ''}_${finding.page || ''}_${finding.severity || ''}_${finding.message || ''}`;
            }
            if (!seenFindings.has(key)) {
                seenFindings.add(key);
                mergedFindings.push(finding);
            }
        }

        const documentFindings = mergedFindings.filter(f =>
            !f.isEnvironmentError &&
            f.type !== 'ENVIRONMENT' &&
            !String(f.code || '').includes('TOOL') &&
            !/missing binary|missing tool|toolchain/i.test(String(f.message || ''))
        );

        // Task 1: Compute hasBlockingFindings, certifiable, and requiresCertifiedArtifact exactly as specified
        const hasBlockingFindings = documentFindings.some(f => ['critical', 'error'].includes(String(f?.severity || '').toLowerCase()));

        const isJobAutofix = res.type === 'AUTOFIX' || job?.job_type === 'AUTOFIX';
        const isExplicitlyCertifiable = res.certifiable === true || res.analysisIntegrity?.certifiable === true || res.analysis?.certifiable === true;
        const isInputCertifiable = isExplicitlyCertifiable || (res.certifiable === undefined && res.analysisIntegrity?.certifiable === undefined && !hasBlockingFindings);

        const requiresCertifiedArtifact = !isEnvFailure && isInputCertifiable === true && !hasBlockingFindings && !isJobAutofix;

        let artifactErrors = unique([
            ...asArray(res.artifactErrors),
            ...rawErrorCandidates.filter(isArtifactText).map(errorText)
        ]);

        // Task 2: Only add CERTIFIED_ARTIFACT_MISSING when requiresCertifiedArtifact is true and certified artifact is absent.
        if (!requiresCertifiedArtifact) {
            artifactErrors = artifactErrors.filter(e => e !== 'CERTIFIED_ARTIFACT_MISSING');
            if (res.error === 'CERTIFIED_ARTIFACT_MISSING') {
                delete res.error;
            }
        }

        let explicitMissingArtifacts = unique([
            ...asArray(res.missingArtifacts),
            ...asArray(res.artifactIntegrity?.missingArtifacts)
        ]);

        if (!requiresCertifiedArtifact) {
            explicitMissingArtifacts = explicitMissingArtifacts.filter(a => a !== 'certified_pdf');
        }

        const inferredMissingArtifacts = [];
        const rawAnalysisStatus = res.analysis_status ?? res.status ?? job?.status;
        const isAnalysisCompleted = job?.status === 'COMPLETED' || /COMPLETED|SUCCESS|PASS/i.test(rawAnalysisStatus) || res.artifacts || artifactList.length > 0 || res.artifactIntegrity;

        // Task 3: Always require analysis_report after completed analysis
        if (!hasReportArtifact && isAnalysisCompleted && !isJobAutofix) {
            inferredMissingArtifacts.push('analysis_report');
        }

        if (requiresCertifiedArtifact && !hasCertifiedArtifact && isAnalysisCompleted) {
            inferredMissingArtifacts.push('certified_pdf');
            if (!artifactErrors.includes('CERTIFIED_ARTIFACT_MISSING')) {
                artifactErrors.push('CERTIFIED_ARTIFACT_MISSING');
            }
        }

        const missingArtifacts = unique([...explicitMissingArtifacts, ...inferredMissingArtifacts]);
        const hasArtifactFailure = missingArtifacts.length > 0 || artifactErrors.length > 0;

        // Enforce invariants and log warnings if raw payload was contradictory.
        const rawDegradedMode = res.analysisIntegrity?.degradedMode ?? res.degradedMode;
        const rawExtractionFidelity = res.analysisIntegrity?.extractionFidelity ?? res.extractionFidelity ?? res.extraction_fidelity;

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
        } else if (engineClass === 'DEGRADED_ANALYSIS') {
            outcomeCategory = 'DEGRADED_ANALYSIS';
        } else if (engineClass === 'PARTIAL_ANALYSIS') {
            outcomeCategory = 'PARTIAL_ANALYSIS';
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
        const degradedMode = engineClass === 'DEGRADED_ANALYSIS' || hasMissingTools || !!rawDegradedMode;
        const realExtraction = !isEnvFailure;
        const extractionFidelity = (isEnvFailure || degradedMode) ? 'DEGRADED' : (rawExtractionFidelity || 'REAL_EXTRACTION');
        const scoreBasis = isEnvFailure ? 'ENVIRONMENT_FAILURE' : (documentFindings.length > 0 ? 'DOCUMENT_FINDINGS' : 'CLEAN');
        const certifiable = !isEnvFailure && !hasArtifactFailure && !hasBlockingFindings && isInputCertifiable;

        // Task 4: Set certificationBlockedReason accurately
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
            degradedMode,
            realExtraction,
            certifiable,
            extractionFidelity,
            scoreBasis,
            integrityFailureClass,
            toolchainIntegrity,
            runtimeIntegrity,
            artifactIntegrity
        };

        // Task 4 & 5: Ensure analysis_status uses correct diagnostics
        const analysisStatus = isEnvFailure
            ? 'FAILED_RUNTIME_ENVIRONMENT'
            : hasArtifactFailure
                ? 'PARTIAL_ARTIFACTS'
                : engineClass === 'DEGRADED_ANALYSIS'
                    ? 'DEGRADED'
                    : engineClass === 'PARTIAL_ANALYSIS'
                        ? 'PARTIAL'
                        : hasBlockingFindings
                            ? 'COMPLETED_WITH_FINDINGS'
                            : documentFindings.length > 0
                                ? 'COMPLETED_WITH_FINDINGS'
                                : 'COMPLETED';

        let consensusStatus = res.status || 'PASS';
        if (isEnvFailure) {
            consensusStatus = 'FAILED_RUNTIME_ENVIRONMENT';
        } else if (hasBlockingFindings) {
            consensusStatus = (consensusStatus === 'FAIL_PREPRESS' || res.status === 'FAIL_PREPRESS') ? 'FAIL_PREPRESS' : 'FAIL';
        } else if (documentFindings.some(f => ['warning', 'info'].includes(String(f?.severity || '').toLowerCase()))) {
            if (consensusStatus === 'PASS') consensusStatus = 'PASS_WITH_WARNINGS';
        }

        const normalizedResult = {
            ...res,
            status: consensusStatus,
            ok: !isEnvFailure && !hasArtifactFailure && !hasBlockingFindings && (res.ok !== false),
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
            findings: documentFindings,
            issues: documentFindings, // Alias
            warnings: res.warnings || [],
            analyzerCoverage: res.analyzerCoverage || res.analyzer_coverage || res.analysis?.analyzerCoverage || null,
            analyzer_coverage: res.analyzer_coverage || res.analyzerCoverage || res.analysis?.analyzerCoverage || null
        };

        // Compatibility: do not delete analysis.issues or forensics.findings unless necessary
        if (normalizedResult.analysis && !normalizedResult.analysis.issues) {
            normalizedResult.analysis.issues = documentFindings;
        }
        if (normalizedResult.forensics && !normalizedResult.forensics.findings) {
            normalizedResult.forensics.findings = documentFindings;
        }

        let finalJobStatus = job?.status || 'COMPLETED';
        if (isEnvFailure) {
            finalJobStatus = 'FAILED';
        } else if (finalJobStatus === 'COMPLETED' || finalJobStatus === 'SUCCESS') {
            if (hasArtifactFailure) {
                finalJobStatus = 'PARTIAL_ARTIFACTS';
            } else if (engineClass === 'DEGRADED_ANALYSIS') {
                finalJobStatus = 'DEGRADED';
            } else if (engineClass === 'PARTIAL_ANALYSIS') {
                finalJobStatus = 'PARTIAL';
            }
        }

        let finalError = isEnvFailure
            ? (runtimeErrors[0] || 'ENGINE_ENVIRONMENT_FAILURE')
            : hasArtifactFailure
                ? (artifactErrors[0] || missingArtifacts[0] || 'ARTIFACT_INTEGRITY_FAILURE')
                : (normalizedResult.error || job?.error || null);

        if (!requiresCertifiedArtifact && finalError === 'CERTIFIED_ARTIFACT_MISSING') {
            finalError = null;
        }

        const partial = !isEnvFailure && (hasArtifactFailure || (documentFindings.length > 0 && !hasBlockingFindings) || engineClass === 'DEGRADED_ANALYSIS' || engineClass === 'PARTIAL_ANALYSIS');
        const analysis_warnings = partial ? documentFindings : [];

        const isAutofixJob = job?.job_type === 'AUTOFIX';
        const autofixRootLifts = {
            ...(res.sourceJobId ? { sourceJobId: res.sourceJobId } : {}),
            ...(res.repairs ? { repairs: res.repairs } : {}),
            ...(res.fixes ? { fixes: res.fixes } : {}),
            ...(res.requested_fixes || res.fixes ? { requested_fixes: res.requested_fixes || res.fixes } : {}),
            ...(res.skipped_fixes ? { skipped_fixes: res.skipped_fixes } : {}),
            ...(res.failed_fixes ? { failed_fixes: res.failed_fixes } : {}),
            ...(res.warnings ? { warnings: res.warnings } : {}),
            ...(res.degraded_reasons ? { degraded_reasons: res.degraded_reasons } : {}),
            ...(res.forceBleed !== undefined ? { forceBleed: res.forceBleed } : {}),
            ...(res.targetProfile ? { targetProfile: res.targetProfile } : {})
        };

        const productionCertified = res.production_certified !== false && res.productionCertified !== false && res.summary?.after?.production_certified !== false;
        const requiresReview = res.requires_human_review === true || res.requiresHumanReview === true || res.summary?.after?.requires_human_review === true || consensusStatus === "COMPLETED_WITH_REVIEW" || consensusStatus === "AUTOFIX_PARTIAL" || productionCertified === false || job?.status === "COMPLETED_WITH_REVIEW" || job?.status === "AUTOFIX_PARTIAL";

        let returnedArtifacts = isAutofixJob ? (res.artifacts || artifactList.reduce((acc, a) => ({ ...acc, [a.type]: a.name }), {})) : artifactList;
        
        if (isAutofixJob && returnedArtifacts && typeof returnedArtifacts === 'object' && !Array.isArray(returnedArtifacts)) {
             const hasFixed = returnedArtifacts.fixed_pdf || returnedArtifacts.final_fixed_pdf || artifactList.some(a => a.name === 'fixed.pdf');
             const hasNormalized = returnedArtifacts.normalized_pdf || artifactList.some(a => a.name === 'normalized.pdf');
             
             if (requiresReview && hasFixed) {
                 returnedArtifacts.review_pdf = returnedArtifacts.review_pdf || returnedArtifacts.final_fixed_pdf || returnedArtifacts.fixed_pdf || 'fixed.pdf';
                 returnedArtifacts.fixed_pdf = returnedArtifacts.fixed_pdf || 'fixed.pdf';
                 returnedArtifacts.final_fixed_pdf = returnedArtifacts.final_fixed_pdf || returnedArtifacts.fixed_pdf || 'fixed.pdf';
             } else if (requiresReview && hasNormalized) {
                 returnedArtifacts.review_pdf = returnedArtifacts.review_pdf || returnedArtifacts.final_fixed_pdf || returnedArtifacts.normalized_pdf || 'normalized.pdf';
                 returnedArtifacts.normalized_pdf = returnedArtifacts.normalized_pdf || 'normalized.pdf';
                 returnedArtifacts.final_fixed_pdf = returnedArtifacts.final_fixed_pdf || returnedArtifacts.normalized_pdf || 'normalized.pdf';
             }

             if (productionCertified === false) {
                 delete returnedArtifacts.certified_pdf;
             }
        }

        return {
            id: canonicalId,
            jobId: canonicalId,
            ok: normalizedResult.ok,
            status: finalJobStatus,
            type: job?.job_type || normalizedResult.analysis_type,
            progress: job?.progress || (['COMPLETED', 'DEGRADED', 'PARTIAL', 'PARTIAL_ARTIFACTS'].includes(finalJobStatus) ? 100 : 0),
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
            ...autofixRootLifts,
            artifacts: returnedArtifacts
        };
    }
}

module.exports = PreflightService;
