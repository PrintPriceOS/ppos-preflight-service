const db = require('../src/services/db');
const policyEngine = require('../src/services/policyEngine');
const auditLogger = require('../src/services/auditLogger');
const { ErrorCodes, ErrorTypes, PPOSError } = require('../src/utils/errors');
const path = require('path');
const fs = require('fs-extra');
const IdentityValidator = require('../src/utils/identityValidator');
const HashUtility = require('../src/utils/hashUtility');
const FixAuditNormalizer = require('./FixAuditNormalizer');


/**
 * PreflightService
 * 
 * Orchestrates the analysis and autofix lifecycle with governance persistence.
 */
const policyCatalog = require('./policyCatalog');
const syncClient = require('./ControlPlaneJobSyncClient');

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

                const artifactsPayload = await this.getJobArtifacts(jobId, tenantId);
                const artifacts = Array.isArray(artifactsPayload)
                    ? artifactsPayload
                    : (artifactsPayload?.artifacts || []);

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

                const finalAnalyzeResult = {
                    ...normalizedPayload,
                    ...normalizedPayload.result,
                    id: jobId,
                    jobId,
                    ok: normalizedPayload.ok,
                    status: normalizedPayload.status
                };

                // Push to Control Plane sync
                syncClient.syncJob({
                    jobId,
                    tenantId,
                    type: 'ANALYZE',
                    status: jobObjForNorm.status,
                    source_status: finalAnalyzeResult.analysis_status || finalAnalyzeResult.status,
                    final_status: finalAnalyzeResult.status,
                    findings: finalAnalyzeResult.findings,
                    findingsCount: finalAnalyzeResult.findings?.length || 0,
                    issuesCount: finalAnalyzeResult.summary?.issue_count || finalAnalyzeResult.findings?.length || 0,
                    productionCertified: finalAnalyzeResult.productionCertified !== false && finalAnalyzeResult.analysisIntegrity?.certifiable !== false,
                    requiresHumanReview: finalAnalyzeResult.requiresHumanReview || finalAnalyzeResult.summary?.after?.requires_human_review || false,
                    reviewReasons: finalAnalyzeResult.reviewReasons || [],
                    artifacts: finalAnalyzeResult.artifacts || {},
                    analysisIntegrity: finalAnalyzeResult.analysisIntegrity,
                    updatedAt: new Date().toISOString()
                }).catch(err => {
                    console.warn(`[SERVICE][CONTROL-PLANE-JOB-SYNC][WARN] Unhandled promise rejection: ${err.message}`);
                });

                return finalAnalyzeResult;
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
        const magicFixProfileStr = options.magicFixProfile ?? null;

        if (magicFixProfileStr) {
            options.magicFixProfile = magicFixProfileStr;
        }

        console.log(`[SERVICE][FIX-ACTION][REQUEST] Received fix action request. SourceJobId: ${assetId}, FixJobId: ${jobId}, RequestedFixes: ${JSON.stringify(requestedFixesArray)}, ForceBleed: ${forceBleedFlag}, TargetProfile: ${targetProfileStr}, MagicFixProfile: ${magicFixProfileStr}`);

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
                    targetProfile: targetProfileStr,
                    magicFixProfile: magicFixProfileStr
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

                const artifactsPayload = await this.getJobArtifacts(jobId, tenantId);
                const artifacts = Array.isArray(artifactsPayload)
                    ? artifactsPayload
                    : (artifactsPayload?.artifacts || []);

                const resultPayload = {
                    sourceJobId: assetId,
                    targetJobId: jobId,
                    ok: fixResult.ok,
                    repairs: fixResult.repairs || [],
                    fixes: fixesArray,
                    requested_fixes: requestedFixesArray,
                    forceBleed: forceBleedFlag,
                    targetProfile: targetProfileStr,
                    magicFixProfile: magicFixProfileStr,
                    autofix_attempted: true,
                    type: 'AUTOFIX'
                };

                const jobObjForNorm = {
                    id: jobId,
                    status: fixResult.ok ? 'COMPLETED' : 'FAILED',
                    job_type: 'AUTOFIX'
                };

                const syncSourceFindings = sourceResultObj
                    ? (Array.isArray(sourceResultObj.findings) && sourceResultObj.findings.length > 0
                        ? sourceResultObj.findings
                        : (Array.isArray(sourceResultObj.issues) ? sourceResultObj.issues : []))
                    : [];

                const normalizedPayload = this._normalizeJobPayload(jobObjForNorm, artifacts, resultPayload, syncSourceFindings);

                await db.execute(
                    "UPDATE jobs SET status = ?, result = ? WHERE id = ?",
                    [normalizedPayload.status, JSON.stringify(normalizedPayload), jobId],
                    { tenantId, requestId: safeRequestId }
                );

                const syncResponse = {
                    id: jobId,
                    jobId,
                    sourceJobId: assetId,
                    targetJobId: jobId,
                    type: 'AUTOFIX',
                    ...normalizedPayload
                };

                // Push to Control Plane sync
                syncClient.syncJob({
                    jobId: syncResponse.jobId,
                    sourceJobId: syncResponse.sourceJobId,
                    tenantId,
                    type: 'AUTOFIX',
                    status: jobObjForNorm.status,
                    source_status: syncResponse.status,
                    final_status: syncResponse.status,
                    requestedFixes: syncResponse.requested_fixes,
                    repairs: syncResponse.repairs,
                    appliedFixes: syncResponse.applied_fixes,
                    skippedFixes: syncResponse.skipped_fixes,
                    failedFixes: syncResponse.failed_fixes,
                    requestedFixesCount: syncResponse.requestedFixesCount || 0,
                    repairsCount: syncResponse.repairsCount || 0,
                    appliedFixesCount: syncResponse.appliedFixesCount || 0,
                    skippedFixesCount: syncResponse.skippedFixesCount || 0,
                    failedFixesCount: syncResponse.failedFixesCount || 0,
                    productionCertified: syncResponse.productionCertified !== false,
                    requiresHumanReview: syncResponse.requiresHumanReview === true,
                    reviewReasons: syncResponse.reviewReasons || [],
                    artifacts: syncResponse.artifacts || {},
                    artifact_delta: syncResponse.artifact_delta || {},
                    analysisIntegrity: syncResponse.analysisIntegrity,
                    updatedAt: new Date().toISOString()
                }).catch(err => {
                    console.warn(`[SERVICE][CONTROL-PLANE-JOB-SYNC][WARN] Unhandled promise rejection: ${err.message}`);
                });

                console.log(`[SERVICE][FIX-ACTION][RESPONSE] Returning immediate inline response. SourceJobId: ${assetId}, FixJobId: ${jobId}, RepairsCount: ${syncResponse.repairsCount}, SkippedCount: ${syncResponse.skippedFixesCount}, FailedCount: ${syncResponse.failedFixesCount}`);
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
            magicFixProfile: magicFixProfileStr,
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

        console.log(`[SERVICE][FIX-ACTION][QUEUE-PAYLOAD] Enqueueing worker payload. SourceJobId: ${assetId}, FixJobId: ${jobId}, QueuedFixesCount: ${fixesArray.length}, ForceBleed: ${forceBleedFlag}, TargetProfile: ${targetProfileStr}, MagicFixProfile: ${magicFixProfileStr}`);
        console.log(`[PRELIGHT][JOBS] Emitting V2 AUTOFIX contract for job: ${jobId} (Tenant: ${tenantId}, Profile: ${magicFixProfileStr || resolvedPolicyProfile})`);

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
            targetProfile: targetProfileStr,
            magicFixProfile: magicFixProfileStr
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
                const artifactsPayload = await this.getJobArtifacts(canonicalId, row.tenant_id);
                const artifacts = Array.isArray(artifactsPayload)
                    ? artifactsPayload
                    : (artifactsPayload?.artifacts || []);

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

        let job = null;
        let dbRows = [];
        try {
            const jobRows = await db.query(
                "SELECT id, status, job_type, progress, result, error, created_at FROM jobs WHERE id = ? AND tenant_id = ?",
                [jobId, auth.tenantId]
            );
            dbRows = jobRows;
            job = jobRows[0];
        } catch(e) {}

        let source_status = "SERVICE_RUNTIME";
        let isSynthetic = false;
        const physicalOutputDir = await this._resolvePhysicalOutputDir(jobId, auth.tenantId);

        if (!job) {
            if (physicalOutputDir) {
                console.log(`[PREFLIGHT-SERVICE][PHYSICAL_OUTPUT_FALLBACK_START] Synthesizing job ${jobId}`);
                isSynthetic = true;
                source_status = "PHYSICAL_OUTPUT_FALLBACK";
                job = {
                    id: jobId,
                    job_type: jobId.startsWith('fix_') ? 'AUTOFIX' : 'ANALYZE',
                    status: 'COMPLETED', // will be refined later
                    progress: 100,
                    result: {},
                    created_at: new Date()
                };
            } else {
                return null;
            }
        }

        const canonicalId = job.id;
        console.log(`[SERVICE][JOB][PUBLIC-ID-NORMALIZED] Mapping data for ${canonicalId} (Type: ${job.job_type})`);

        // Map internal result string to object if necessary
        let result = job.result || {};
        if (typeof result === 'string') {
            try { result = JSON.parse(result); } catch (e) { }
        }

        const artifactsPayload = await this.getJobArtifacts(canonicalId, auth.tenantId);
        const artifactList = artifactsPayload?.artifacts || artifactsPayload || [];
        const artifacts = Array.isArray(artifactList) ? artifactList : [];
        
        // Determine hydration source_status
        if (!isSynthetic && physicalOutputDir && (!artifacts.length || !result.fix_summary || !result.fix_summary.available)) {
            source_status = "PHYSICAL_OUTPUT_HYDRATED";
            console.log(`[PREFLIGHT-SERVICE][PHYSICAL_OUTPUT_JOB_HYDRATED] jobId=${jobId}`);
        }
        
        let dbHasUpdates = false;

        // Read fix_audit.json if we don't have fix_summary or if we want to ensure it's normalized
        if (!result.fix_summary || !result.delta_summary) {
            const outputDir = await this._resolvePhysicalOutputDir(canonicalId, auth.tenantId);
            if (outputDir) {
                if (!result.fix_summary || !result.fix_summary.available) {
                    let fixAuditData = null;
                    try {
                        const fixAuditPath = path.join(outputDir, 'fix_audit.json');
                        if (await fs.pathExists(fixAuditPath)) {
                            fixAuditData = await fs.readJson(fixAuditPath);
                        }
                    } catch(e) {}
                    if (fixAuditData) {
                        result.fix_summary = FixAuditNormalizer.normalize(fixAuditData);
                        dbHasUpdates = true;
                    }
                }

                // Read delta_report.json
                if (!result.delta_summary || !result.delta_summary.available) {
                    let deltaReportData = null;
                    try {
                        const deltaPath = path.join(outputDir, 'delta_report.json');
                        if (await fs.pathExists(deltaPath)) {
                            deltaReportData = await fs.readJson(deltaPath);
                        }
                    } catch(e) {}
                    
                    if (deltaReportData) {
                        result.delta_summary = {
                            available: true,
                            changed: deltaReportData.changed || false,
                            changes: deltaReportData.changes || [],
                            operator_summary: deltaReportData.operator_summary || null,
                            customer_safe_summary: deltaReportData.customer_safe_summary || null,
                            requires_human_review: deltaReportData.requires_human_review || false,
                            recommended_operator_action: deltaReportData.recommended_operator_action || null
                        };
                        dbHasUpdates = true;
                    }
                }
            }
        }
        
        if (dbHasUpdates && job.id) {
            await db.execute(
                "UPDATE jobs SET result = ? WHERE id = ?",
                [JSON.stringify(result), canonicalId],
                { tenantId: auth.tenantId }
            );
        }

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

        let sourceFindings = [];
        if (isAutofix) {
            const sourceJobId = safeResult?.sourceJobId || safeResult?.source_job_id;
            if (sourceJobId) {
                try {
                    const [sourceRow] = await db.query(
                        'SELECT result FROM jobs WHERE id = ? AND tenant_id = ?',
                        [sourceJobId, auth.tenantId]
                    );
                    if (sourceRow?.result) {
                        const sourceRes = typeof sourceRow.result === 'string'
                            ? JSON.parse(sourceRow.result)
                            : sourceRow.result;
                        sourceFindings = Array.isArray(sourceRes.findings) && sourceRes.findings.length > 0
                            ? sourceRes.findings
                            : (Array.isArray(sourceRes.issues) ? sourceRes.issues : []);
                    }
                } catch (_) {}
            }
        }

        // Set root flags for UI and downstream
        if (safeResult.fix_summary) {
            if (safeResult.fix_summary.artifact_trust) {
                safeResult.production_certified = safeResult.fix_summary.artifact_trust.production_certified === true;
                safeResult.review_required = safeResult.fix_summary.artifact_trust.review_required === true;
                safeResult.standard_certified = safeResult.fix_summary.artifact_trust.standard_certified === true;
            } else {
                safeResult.production_certified = safeResult.fix_summary.production_certified === true;
                safeResult.review_required = safeResult.fix_summary.review_required === true;
                safeResult.standard_certified = safeResult.fix_summary.standards_certification_governance?.standard_certified === true || 
                                                safeResult.fix_summary.standard_certified === true;
            }
        } else if (safeResult.artifact_trust) {
            safeResult.production_certified = safeResult.artifact_trust.production_certified === true;
            safeResult.review_required = safeResult.artifact_trust.review_required === true;
            safeResult.standard_certified = safeResult.artifact_trust.standard_certified === true;
        } else {
            safeResult.production_certified = safeResult.production_certified === true;
            safeResult.review_required = safeResult.review_required === true;
            // standard_certified might be directly on result from older engines
        }

        let normPayload = this._normalizeJobPayload(job, artifacts, safeResult, sourceFindings);
        normPayload.source_status = source_status;
        
        // Re-assign status if synthetic and we have a review required
        if (isSynthetic) {
            normPayload.status = normPayload.review_required ? "REVIEW_REQUIRED" : "COMPLETED";
            normPayload.display_status = normPayload.status;
        }
        
        return normPayload;
    }

    async _resolvePhysicalOutputDir(jobId, tenantId) {
        const candidates = [
            this.storage ? this.storage.getJobSubfolder(tenantId, jobId, 'output') : null,
            path.join(process.env.PPOS_STORAGE_BASE || (this.storage ? this.storage.getBaseDir() : '/tmp'), 'tenants', tenantId, 'jobs', jobId, 'output'),
            path.join(process.env.PPOS_UPLOADS_DIR || '/tmp/ppos-uploads', 'tenants', tenantId, 'jobs', jobId, 'output'),
            path.join(process.env.PPOS_TEMP_DIR || '/tmp/ppos-preflight', 'tenants', tenantId, 'jobs', jobId, 'output'),
            `/tmp/ppos-preflight/tenants/${tenantId}/jobs/${jobId}/output`
        ].filter(Boolean);

        for (const dir of candidates) {
            try {
                if (await fs.pathExists(dir)) {
                    console.log(`[PREFLIGHT-SERVICE][PHYSICAL_OUTPUT_DIR_FOUND] jobId=${jobId} dir=${dir}`);
                    return dir;
                }
            } catch(e) {}
        }
        console.log(`[PREFLIGHT-SERVICE][PHYSICAL_OUTPUT_FALLBACK_EMPTY] jobId=${jobId}`);
        return null;
    }

    async getJobArtifacts(jobId, tenantId) {
        const artifacts = [];
        const outputDir = await this._resolvePhysicalOutputDir(jobId, tenantId);

        let requiresReview = false;
        let productionCertified = true;
        let isAutofix = false;
        let status = '';
        let res = {};
        let dbHasUpdates = false;

        try {
            const jobRows = await db.query("SELECT * FROM jobs WHERE id = ? AND tenant_id = ?", [jobId, tenantId]);
            if (jobRows && jobRows.length > 0) {
                const job = jobRows[0];
                isAutofix = job.job_type === 'AUTOFIX';
                status = job.status;
                if (typeof job.result === 'string') {
                    try { res = JSON.parse(job.result); } catch(e) {}
                } else if (job.result && typeof job.result === 'object') {
                    res = job.result;
                }
            } else {
                isAutofix = jobId.startsWith('fix_');
                status = 'COMPLETED'; // optimistic fallback
            }
            
            productionCertified = res.production_certified !== false && res.productionCertified !== false && res.summary?.after?.production_certified !== false;
            requiresReview = res.requires_human_review === true || res.requiresHumanReview === true || res.summary?.after?.requires_human_review === true || status === "COMPLETED_WITH_REVIEW" || status === "AUTOFIX_PARTIAL" || productionCertified === false;
            
        } catch(e) {
            console.warn(`[ARTIFACT-DISCOVERY-WARN] Could not fetch job ${jobId} for review status check: ${e.message}`);
        }

        let artifactPolicy = {};
        let fixAuditData = null;

        if (outputDir) {
            try {
                const auditPath = path.join(outputDir, 'fix_audit.json');
                if (await fs.pathExists(auditPath)) {
                    fixAuditData = await fs.readJson(auditPath);
                    console.log(`[PREFLIGHT-SERVICE][PHYSICAL_ARTIFACT_HYDRATED] Hydrated fix_audit.json for ${jobId}`);
                }
            } catch(e) {}
        }

        const fixSummary = FixAuditNormalizer.normalize(fixAuditData || res.fix_summary);
        if (fixSummary && fixSummary.available) {
            productionCertified = fixSummary.production_certified;
            requiresReview = fixSummary.review_required;
            if (fixAuditData && fixAuditData.artifact_policy) {
                artifactPolicy = fixAuditData.artifact_policy;
            } else if (res.fix_summary && res.fix_summary.artifact_policy) {
                artifactPolicy = res.fix_summary.artifact_policy;
            }
        }

        let deltaReportData = null;
        if (outputDir) {
            try {
                const deltaPath = path.join(outputDir, 'delta_report.json');
                if (await fs.pathExists(deltaPath)) {
                    deltaReportData = await fs.readJson(deltaPath);
                }
            } catch(e) {}
        }

        const colorGovSources = [
            fixAuditData?.color_governance,
            fixAuditData?.delta_report?.color_governance,
            res.fix_summary?.color_governance,
            deltaReportData?.color_governance,
            res.delta_report?.color_governance,
            res.delta_summary?.color_governance,
            fixAuditData,
            deltaReportData
        ];

        let colorGovActive = false;
        let colorCertPdfAllowed = true;
        for (const src of colorGovSources) {
            if (src) {
                if (src.destructive_color_fix_applied === true) colorGovActive = true;
                if (src.review_required_color_reasons && src.review_required_color_reasons.length > 0) colorGovActive = true;
                if (src.certified_pdf_allowed === false) colorCertPdfAllowed = false;
                if (src.production_certified === false) colorGovActive = true;
            }
        }

        if (colorGovActive || colorCertPdfAllowed === false) {
            productionCertified = false;
            if (colorGovActive) {
                requiresReview = true;
            }
        }

        const transparencyGovSources = [
            fixAuditData?.transparency_overprint_governance,
            fixAuditData?.delta_report?.transparency_overprint_governance,
            res.fix_summary?.transparency_overprint_governance,
            deltaReportData?.transparency_overprint_governance,
            res.delta_report?.transparency_overprint_governance,
            res.delta_summary?.transparency_overprint_governance,
            fixAuditData,
            deltaReportData,
            res
        ];

        let transparencyGovActive = false;
        let transparencyCertPdfAllowed = true;
        for (const src of transparencyGovSources) {
            if (src) {
                if (src.review_required === true) transparencyGovActive = true;
                if (src.certified_pdf_allowed === false) transparencyCertPdfAllowed = false;
                if (src.production_certified === false) transparencyGovActive = true;
                if (src.visual_rewrite_fix_applied === true) transparencyGovActive = true;
                if (src.review_required_reasons && src.review_required_reasons.length > 0) transparencyGovActive = true;
            }
        }

        if (transparencyGovActive || transparencyCertPdfAllowed === false) {
            productionCertified = false;
            if (transparencyGovActive) {
                requiresReview = true;
            }
        }

        const imageGovSources = [
            fixAuditData?.image_quality_governance,
            fixAuditData?.delta_report?.image_quality_governance,
            res.fix_summary?.image_quality_governance,
            deltaReportData?.image_quality_governance,
            res.delta_report?.image_quality_governance,
            res.delta_summary?.image_quality_governance,
            fixAuditData,
            deltaReportData,
            res
        ];

        let imageGovActive = false;
        let imageCertPdfAllowed = true;
        for (const src of imageGovSources) {
            if (src) {
                if (src.review_required === true) imageGovActive = true;
                if (src.certified_pdf_allowed === false) imageCertPdfAllowed = false;
                if (src.production_certified === false) imageGovActive = true;
                if (src.visual_image_rewrite_applied === true) imageGovActive = true;
                if (src.review_required_reasons && src.review_required_reasons.length > 0) imageGovActive = true;
                if (src.low_res_images_present === true) imageGovActive = true;
                if (src.excessive_resolution_present === true) imageGovActive = true;
                if (src.jpeg_artifacts_present === true) imageGovActive = true;
                if (src.image_replacement_required === true) imageGovActive = true;
                if (src.bitmap_text_risk === true) imageGovActive = true;
                if (src.rasterized_vector_risk === true) imageGovActive = true;
                if (src.image_object_damaged === true) imageGovActive = true;
            }
        }

        if (imageGovActive || imageCertPdfAllowed === false) {
            productionCertified = false;
            if (imageGovActive) {
                requiresReview = true;
            }
        }

        const standardsGovSources = [
            fixAuditData?.standards_certification_governance,
            fixAuditData?.delta_report?.standards_certification_governance,
            res.fix_summary?.standards_certification_governance,
            deltaReportData?.standards_certification_governance,
            res.delta_report?.standards_certification_governance,
            res.delta_summary?.standards_certification_governance,
            fixAuditData,
            deltaReportData,
            res
        ];

        let standardsGovActive = false;
        let standardsCertPdfAllowed = true;
        for (const src of standardsGovSources) {
            if (src) {
                if (src.review_required === true) standardsGovActive = true;
                if (src.certified_pdf_allowed === false) standardsCertPdfAllowed = false;
                if (src.production_certified === false) standardsGovActive = true;
                if (src.review_required_reasons && src.review_required_reasons.length > 0) standardsGovActive = true;
                if (src.review_required_standards_reasons && src.review_required_standards_reasons.length > 0) standardsGovActive = true;
                if (src.validation_required === true && src.validation_performed === false) standardsGovActive = true;
                if (src.standard_certified === false) standardsGovActive = true;
            }
        }

        if (standardsGovActive || standardsCertPdfAllowed === false) {
            productionCertified = false;
            if (standardsGovActive) {
                requiresReview = true;
            }
        }

        const pageMarksGovSources = [
            fixAuditData?.page_marks_governance,
            fixAuditData?.delta_report?.page_marks_governance,
            res.fix_summary?.page_marks_governance,
            deltaReportData?.page_marks_governance,
            res.delta_report?.page_marks_governance,
            res.delta_summary?.page_marks_governance,
            fixAuditData,
            deltaReportData,
            res
        ];

        let pageMarksGovActive = false;
        let pageMarksCertPdfAllowed = true;
        for (const src of pageMarksGovSources) {
            if (src) {
                if (src.review_required === true) pageMarksGovActive = true;
                if (src.certified_pdf_allowed === false) pageMarksCertPdfAllowed = false;
                if (src.production_certified === false) pageMarksGovActive = true;
                if (src.page_marks_fix_applied === true) pageMarksGovActive = true;
                if (src.crop_marks_added === true) pageMarksGovActive = true;
                if (src.removal_not_safe === true) pageMarksGovActive = true;
                if (src.marks_inside_trim === true) pageMarksGovActive = true;
                if (src.review_required_reasons && src.review_required_reasons.length > 0) pageMarksGovActive = true;
            }
        }

        if (pageMarksGovActive || pageMarksCertPdfAllowed === false) {
            productionCertified = false;
            if (pageMarksGovActive) {
                requiresReview = true;
            }
        }

        const securityInteractivityGovSources = [
            fixAuditData?.security_interactivity_governance,
            fixAuditData?.delta_report?.security_interactivity_governance,
            res.fix_summary?.security_interactivity_governance,
            deltaReportData?.security_interactivity_governance,
            res.delta_report?.security_interactivity_governance,
            res.delta_summary?.security_interactivity_governance,
            fixAuditData,
            deltaReportData,
            res
        ];

        let securityInteractivityGovActive = false;
        let securityInteractivityCertPdfAllowed = true;
        for (const src of securityInteractivityGovSources) {
            if (src) {
                if (src.review_required === true) securityInteractivityGovActive = true;
                if (src.certified_pdf_allowed === false) securityInteractivityCertPdfAllowed = false;
                if (src.production_certified === false) securityInteractivityGovActive = true;
                if (src.security_interactivity_fix_applied === true) securityInteractivityGovActive = true;
                if (src.active_content_removed === true) securityInteractivityGovActive = true;
                if (src.annotation_flatten_skipped === true) securityInteractivityGovActive = true;
                if (src.form_flatten_skipped === true) securityInteractivityGovActive = true;
                if (src.unresolved_interactive_content === true) securityInteractivityGovActive = true;
                if (src.review_required_reasons && src.review_required_reasons.length > 0) securityInteractivityGovActive = true;
            }
        }

        if (securityInteractivityGovActive || securityInteractivityCertPdfAllowed === false) {
            productionCertified = false;
            if (securityInteractivityGovActive) {
                requiresReview = true;
            }
        }

        const inkGovSources = [
            fixAuditData?.ink_governance,
            fixAuditData?.delta_report?.ink_governance,
            res.fix_summary?.ink_governance,
            deltaReportData?.ink_governance,
            res.delta_report?.ink_governance,
            res.delta_summary?.ink_governance,
            fixAuditData,
            deltaReportData,
            res
        ];

        let inkGovActive = false;
        let inkCertPdfAllowed = true;
        for (const src of inkGovSources) {
            if (src) {
                if (src.review_required === true) inkGovActive = true;
                if (src.certified_pdf_allowed === false) inkCertPdfAllowed = false;
                if (src.production_certified === false) inkGovActive = true;
                if (src.ink_fix_applied === true) inkGovActive = true;
                if (src.tac_reduction_attempted === true) inkGovActive = true;
                if (src.tac_reduction_applied === true) inkGovActive = true;
                if (src.rich_black_text_mapped === true) inkGovActive = true;
                if (src.registration_color_mapped === true) inkGovActive = true;
                if (src.visual_change_expected === true) inkGovActive = true;
                if (src.review_required_reasons && src.review_required_reasons.length > 0) inkGovActive = true;
            }
        }

        if (inkGovActive || inkCertPdfAllowed === false) {
            productionCertified = false;
            if (inkGovActive) {
                requiresReview = true;
            }
        }

        const selectiveImageGovSources = [
            fixAuditData?.selective_image_governance,
            fixAuditData?.delta_report?.selective_image_governance,
            res.fix_summary?.selective_image_governance,
            deltaReportData?.selective_image_governance,
            res.delta_report?.selective_image_governance,
            res.delta_summary?.selective_image_governance,
            fixAuditData,
            deltaReportData,
            res
        ];

        let selectiveImageGovActive = false;
        let selectiveImageCertPdfAllowed = true;
        for (const src of selectiveImageGovSources) {
            if (src) {
                if (src.review_required === true) selectiveImageGovActive = true;
                if (src.certified_pdf_allowed === false) selectiveImageCertPdfAllowed = false;
                if (src.production_certified === false) selectiveImageGovActive = true;
                if (src.image_fix_applied === true) selectiveImageGovActive = true;
                if (src.rgb_images_converted === true) selectiveImageGovActive = true;
                if (src.image_profiles_normalized === true) selectiveImageGovActive = true;
                if (src.excessive_resolution_downsampled === true) selectiveImageGovActive = true;
                if (src.low_res_unfixable === true) selectiveImageGovActive = true;
                if (src.visual_change_expected === true) selectiveImageGovActive = true;
                if (src.review_required_reasons && src.review_required_reasons.length > 0) selectiveImageGovActive = true;
            }
        }

        if (selectiveImageGovActive || selectiveImageCertPdfAllowed === false) {
            productionCertified = false;
            if (selectiveImageGovActive) {
                requiresReview = true;
            }
        }

        const fontGovSources = [
            fixAuditData?.font_governance,
            fixAuditData?.delta_report?.font_governance,
            res.fix_summary?.font_governance,
            deltaReportData?.font_governance,
            res.delta_report?.font_governance,
            res.delta_summary?.font_governance,
            fixAuditData,
            deltaReportData,
            res
        ];

        let fontGovActive = false;
        let fontCertPdfAllowed = true;
        for (const src of fontGovSources) {
            if (src) {
                if (src.review_required === true) fontGovActive = true;
                if (src.certified_pdf_allowed === false) fontCertPdfAllowed = false;
                if (src.production_certified === false) fontGovActive = true;
                if (src.font_fix_applied === true) fontGovActive = true;
                if (src.fonts_embedded === true) fontGovActive = true;
                if (src.font_embedding_skipped === true) fontGovActive = true;
                if (src.type3_fonts_detected === true) fontGovActive = true;
                if (src.glyphs_missing_unfixable === true) fontGovActive = true;
                if (src.font_source_available === false) fontGovActive = true;
                if (src.review_required_reasons && src.review_required_reasons.length > 0) fontGovActive = true;
            }
        }

        if (fontGovActive || fontCertPdfAllowed === false) {
            productionCertified = false;
            if (fontGovActive) {
                requiresReview = true;
            }
        }

        const transparencyOverprintPhysicalGovSources = [
            fixAuditData?.transparency_overprint_physical_governance,
            fixAuditData?.delta_report?.transparency_overprint_physical_governance,
            res.fix_summary?.transparency_overprint_physical_governance,
            deltaReportData?.transparency_overprint_physical_governance,
            res.delta_report?.transparency_overprint_physical_governance,
            res.delta_summary?.transparency_overprint_physical_governance,
        ];

        let transparencyOverprintPhysicalGovActive = false;
        let transparencyOverprintPhysicalCertPdfAllowed = true;
        for (const src of transparencyOverprintPhysicalGovSources) {
            if (src) {
                if (src.review_required === true) transparencyOverprintPhysicalGovActive = true;
                if (src.certified_pdf_allowed === false) transparencyOverprintPhysicalCertPdfAllowed = false;
                if (src.production_certified === false) transparencyOverprintPhysicalGovActive = true;
                if (src.physical_flatten_applied === true) transparencyOverprintPhysicalGovActive = true;
                if (src.visual_change_expected === true) transparencyOverprintPhysicalGovActive = true;
                if (src.review_required_reasons && src.review_required_reasons.length > 0) transparencyOverprintPhysicalGovActive = true;
            }
        }

        if (transparencyOverprintPhysicalGovActive || transparencyOverprintPhysicalCertPdfAllowed === false) {
            productionCertified = false;
            if (transparencyOverprintPhysicalGovActive) {
                requiresReview = true;
            }
        }

        // Visual Diff Governance (Phase 69)
        const visualDiffGovSources = [
            fixAuditData?.visual_diff_governance,
            fixAuditData?.delta_report?.visual_diff_governance,
            res.fix_summary?.visual_diff_governance,
            deltaReportData?.visual_diff_governance,
            res.delta_report?.visual_diff_governance,
            res.delta_summary?.visual_diff_governance,
        ];

        let visualDiffGovActive = false;
        let visualDiffCertPdfAllowed = true;
        let resolvedVisualDiffGov = null;
        for (const src of visualDiffGovSources) {
            if (src) {
                if (!resolvedVisualDiffGov) resolvedVisualDiffGov = src;
                if (src.visual_review_required === true) { visualDiffGovActive = true; visualDiffCertPdfAllowed = false; }
                if (src.visual_change_detected === true) visualDiffGovActive = true;
                if (src.production_certified === false) visualDiffGovActive = true;
                if (src.render_tool_gap === true) visualDiffGovActive = true;
            }
        }

        if (visualDiffGovActive || visualDiffCertPdfAllowed === false) {
            productionCertified = false;
            if (visualDiffGovActive) {
                requiresReview = true;
            }
        }

        // Proof Approval Governance (Phase 70)
        const proofApprovalGovSourcesArtifacts = [
            fixAuditData?.proof_approval_governance,
            fixAuditData?.delta_report?.proof_approval_governance,
            res.fix_summary?.proof_approval_governance,
            deltaReportData?.proof_approval_governance,
            res.delta_report?.proof_approval_governance,
            res.delta_summary?.proof_approval_governance,
        ];

        let proofApprovalGovActiveArtifacts = false;
        let resolvedProofApprovalGov = null;
        for (const src of proofApprovalGovSourcesArtifacts) {
            if (src) {
                if (!resolvedProofApprovalGov) resolvedProofApprovalGov = src;
                if (src.review_required === true) proofApprovalGovActiveArtifacts = true;
                if (src.proof_required === true && src.proof_status !== 'APPROVED') proofApprovalGovActiveArtifacts = true;
                if (src.visual_change_detected === true && src.proof_status !== 'APPROVED') proofApprovalGovActiveArtifacts = true;
            }
        }

        if (proofApprovalGovActiveArtifacts) {
            productionCertified = false;
            requiresReview = true;
        }

        // Heavy PDF Probe Governance (Phase 62F)
        const heavyPdfProbeGovSources = [
            fixAuditData?.heavy_pdf_probe_governance,
            fixAuditData?.delta_report?.heavy_pdf_probe_governance,
            res.fix_summary?.heavy_pdf_probe_governance,
            deltaReportData?.heavy_pdf_probe_governance,
            res.delta_report?.heavy_pdf_probe_governance,
            res.delta_summary?.heavy_pdf_probe_governance,
            res.heavy_pdf_probe_governance,
        ];

        let resolvedHeavyPdfProbeGov = null;
        for (const src of heavyPdfProbeGovSources) {
            if (src && Object.keys(src).length > 0) {
                resolvedHeavyPdfProbeGov = src;
                break;
            }
        }

        if (resolvedHeavyPdfProbeGov) {
            if (resolvedHeavyPdfProbeGov.review_required === true || resolvedHeavyPdfProbeGov.fatal_document_failure === true) {
                requiresReview = true;
            }
            if (resolvedHeavyPdfProbeGov.production_certified === false || resolvedHeavyPdfProbeGov.fatal_document_failure === true) {
                productionCertified = false;
            }
        }

        // Production Package Governance (Phase 71)
        const productionPackageGovSources = [
            fixAuditData?.production_package_governance,
            fixAuditData?.delta_report?.production_package_governance,
            res.fix_summary?.production_package_governance,
            deltaReportData?.production_package_governance,
            res.delta_report?.production_package_governance,
            res.delta_summary?.production_package_governance,
            res.production_package_governance,
        ];

        let resolvedProductionPackageGov = null;
        for (const src of productionPackageGovSources) {
            if (src && Object.keys(src).length > 0) {
                resolvedProductionPackageGov = src;
                break;
            }
        }

        // Machine Readiness Governance (Phase 73)
        const machineReadinessGovSources = [
            fixAuditData?.machine_readiness_governance,
            fixAuditData?.delta_report?.machine_readiness_governance,
            res.fix_summary?.machine_readiness_governance,
            deltaReportData?.machine_readiness_governance,
            res.delta_report?.machine_readiness_governance,
            res.delta_summary?.machine_readiness_governance,
            res.machine_readiness_governance,
        ];

        let resolvedMachineReadinessGov = null;
        for (const src of machineReadinessGovSources) {
            if (src && Object.keys(src).length > 0) {
                resolvedMachineReadinessGov = src;
                break;
            }
        }

        const artifactTrustSources = [
            fixAuditData?.artifact_trust,
            fixAuditData?.delta_report?.artifact_trust,
            res.fix_summary?.artifact_trust,
            deltaReportData?.artifact_trust,
            res.delta_report?.artifact_trust,
            res.delta_summary?.artifact_trust,
            res.artifact_trust
        ];

        let resolvedArtifactTrust = null;
        for (const src of artifactTrustSources) {
            if (src && Object.keys(src).length > 0) {
                resolvedArtifactTrust = src;
                break;
            }
        }

        if (resolvedArtifactTrust) {
            if (resolvedArtifactTrust.production_certified === false) {
                productionCertified = false;
            } else if (resolvedArtifactTrust.production_certified === true) {
                productionCertified = true;
            }
            if (resolvedArtifactTrust.review_required === true) {
                requiresReview = true;
            } else if (resolvedArtifactTrust.review_required === false) {
                requiresReview = false;
            }
        }

        try {
            if (outputDir && await fs.pathExists(outputDir)) {
                const files = await fs.readdir(outputDir);
                
                res.artifacts_metadata = res.artifacts_metadata || {}; 

                for (const file of files) {
                    const filePath = path.join(outputDir, file);
                    const stats = await fs.stat(filePath);
                    
                    let checksum_sha256 = null;
                    let checksum_status = null;
                    let checksum_error = null;
                    
                    // Worker might have provided metadata
                    let workerMeta = null;
                    if (Array.isArray(res.artifacts)) {
                        workerMeta = res.artifacts.find(a => a.name === file || a.filename === file);
                    }
                    
                    if (workerMeta && workerMeta.checksum_sha256 && (workerMeta.size_bytes === undefined || workerMeta.size_bytes === stats.size)) {
                        checksum_sha256 = workerMeta.checksum_sha256;
                    } else if (res.artifacts_metadata[file] && res.artifacts_metadata[file].checksum_sha256 && res.artifacts_metadata[file].size_bytes === stats.size) {
                        checksum_sha256 = res.artifacts_metadata[file].checksum_sha256;
                    } else if (stats.size > 0) {
                        try {
                            checksum_sha256 = await HashUtility.computeFileHash(filePath);
                            res.artifacts_metadata[file] = res.artifacts_metadata[file] || {};
                            res.artifacts_metadata[file].checksum_sha256 = checksum_sha256;
                            res.artifacts_metadata[file].size_bytes = stats.size;
                            dbHasUpdates = true;
                        } catch (hashErr) {
                            checksum_status = 'UNAVAILABLE';
                            checksum_error = hashErr.message;
                        }
                    }

                    const pushArtifact = (type) => {
                        const artifact = {
                            id: Buffer.from(`${jobId}:${type}:${file}`).toString('base64').replace(/=/g, ''),
                            jobId,
                            type,
                            name: file,
                            filename: file,
                            path: `/jobs/${jobId}/output/${file}`,
                            mimeType: this._getMimeByExt(path.extname(file)),
                            mime_type: this._getMimeByExt(path.extname(file)),
                            size: stats.size, // fallback
                            size_bytes: stats.size,
                            storage_key: filePath,
                            checksum_sha256,
                            ...(checksum_status ? { checksum_status } : {}),
                            ...(checksum_error ? { checksum_error } : {}),
                            downloadable: stats.size > 0,
                            requires_review: false,
                            production_certified: false,
                            customer_visible: false,
                            artifact_role: 'INTERMEDIATE_OUTPUT',
                            createdAt: stats.birthtime,
                            created_at: stats.birthtime,
                            status: 'READY'
                        };
                        artifacts.push(artifact);
                        return artifact;
                    };

                    const blocked = ['FAILED', 'PARTIAL_ARTIFACTS', 'DEGRADED'].includes(status);
                    
                    if (file === 'report.json') {
                        const a1 = pushArtifact('analysis_report');
                        const a2 = pushArtifact('report_json');
                        a1.artifact_role = a2.artifact_role = 'TECHNICAL_REPORT';
                    } else if (file === 'fix_audit.json') {
                        const a1 = pushArtifact('fix_audit');
                        a1.artifact_role = 'FORENSIC_AUDIT';
                    } else if (file === 'delta_report.json') {
                        const a1 = pushArtifact('delta_report');
                        a1.artifact_role = 'TECHNICAL_REPORT';
                        a1.recommended_use = "Technical change summary";
                    } else if (file === 'certified.pdf') {
                        const a1 = pushArtifact('certified_pdf');
                        const isCertPolicyTrue = artifactPolicy.certified_pdf !== false;
                        const trustAllowed = resolvedArtifactTrust ? resolvedArtifactTrust.certified_pdf_allowed !== false : true;
                        
                        if (productionCertified && isCertPolicyTrue && !requiresReview && trustAllowed) {
                            a1.artifact_role = 'PRODUCTION_READY';
                            a1.customer_visible = resolvedArtifactTrust ? (resolvedArtifactTrust.customer_visible === true) : true;
                            a1.production_certified = resolvedArtifactTrust ? (resolvedArtifactTrust.production_certified === true) : true;
                            a1.recommended_use = "Use as certified production artifact";
                        } else {
                            a1.artifact_role = 'REVIEW_REQUIRED';
                            a1.customer_visible = false;
                            a1.production_certified = false;
                            a1.recommended_use = "Do not use as production-certified output; review required.";
                            console.log(`[PREFLIGHT-SERVICE][CERTIFIED_ARTIFACT_POLICY_DOWNGRADED] jobId=${jobId}`);
                        }
                    } else if (file === 'fixed.pdf') {
                        const a1 = pushArtifact('fixed_pdf');
                        const a2 = pushArtifact('final_fixed_pdf');
                        a1.artifact_role = a2.artifact_role = requiresReview ? 'REVIEW_REQUIRED' : 'PRODUCTION_READY';
                        a1.customer_visible = a2.customer_visible = !blocked;
                        if (requiresReview || (isAutofix && ['AUTOFIX_PARTIAL', 'COMPLETED_WITH_REVIEW'].includes(status))) {
                            const a3 = pushArtifact('review_pdf');
                            a3.artifact_role = 'REVIEW_REQUIRED';
                            a3.requires_review = true;
                            a3.customer_visible = false;
                        }
                    } else if (file === 'normalized.pdf') {
                        const a1 = pushArtifact('normalized_pdf');
                        if (!files.includes('fixed.pdf')) {
                            const a2 = pushArtifact('final_fixed_pdf');
                            a1.artifact_role = a2.artifact_role = requiresReview ? 'REVIEW_REQUIRED' : 'PRODUCTION_READY';
                            a1.customer_visible = a2.customer_visible = !blocked;
                            if (requiresReview || (isAutofix && ['AUTOFIX_PARTIAL', 'COMPLETED_WITH_REVIEW'].includes(status))) {
                                const a3 = pushArtifact('review_pdf');
                                a3.artifact_role = 'REVIEW_REQUIRED';
                                a3.requires_review = true;
                                a3.customer_visible = false;
                            }
                        } else {
                            a1.artifact_role = 'INTERMEDIATE_OUTPUT';
                            a1.customer_visible = false;
                            a1.recommended_use = "Internal intermediate output";
                        }
                    } else if (file.endsWith('.png')) {
                        const a1 = pushArtifact('page_preview');
                        a1.recommended_use = "Page preview image";
                    } else {
                        const a1 = pushArtifact('output_file');
                        a1.recommended_use = "Internal intermediate output";
                    }
                }
                
                if (dbHasUpdates && status && res && Object.keys(res).length > 0) {
                    try {
                        const [check] = await db.query("SELECT id FROM jobs WHERE id = ? AND tenant_id = ?", [jobId, tenantId]);
                        if (check && check.length > 0) {
                            await db.execute("UPDATE jobs SET result = ? WHERE id = ? AND tenant_id = ?", [JSON.stringify(res), jobId, tenantId]);
                        }
                    } catch(e) {}
                }
            }
        } catch (err) {
            console.error(`[ARTIFACT-DISCOVERY-ERROR] jobId=${jobId}:`, err.message);
        }

        const primaryType = resolvedArtifactTrust && resolvedArtifactTrust.primary_artifact_type 
            ? resolvedArtifactTrust.primary_artifact_type 
            : (res?.primary_artifact_type || 'certified_pdf');
            
        for (const a of artifacts) {
            a.is_primary = (a.type === primaryType);
        }

        if (artifacts.length > 0) {
            const artifactListArray = artifacts;
            const artifact_summary = {
                artifact_count: artifactListArray.length,
                downloadable_artifact_count: artifactListArray.filter(a => a.downloadable).length,
                zero_byte_artifact_count: artifactListArray.filter(a => !a.downloadable && a.size === 0).length,
                physical_artifacts_ready: artifactListArray.length > 0,
                certified_pdf_available: artifactListArray.some(a => a.type === 'certified_pdf' && a.downloadable),
                fixed_pdf_available: artifactListArray.some(a => (a.type === 'fixed_pdf' || a.type === 'final_fixed_pdf') && a.downloadable),
                review_pdf_available: artifactListArray.some(a => a.type === 'review_pdf' && a.downloadable),
                report_available: artifactListArray.some(a => ['analysis_report', 'report_json'].includes(a.type) && a.downloadable),
                fix_audit_available: artifactListArray.some(a => a.type === 'fix_audit' && a.downloadable),
                delta_report_available: artifactListArray.some(a => a.type === 'delta_report' && a.downloadable),
                production_ready_artifact_available: artifactListArray.some(a => a.artifact_role === 'PRODUCTION_READY' && a.downloadable),
                review_required_artifact_available: artifactListArray.some(a => a.artifact_role === 'REVIEW_REQUIRED' && a.downloadable)
            };

            if (resolvedVisualDiffGov) {
                artifact_summary.visual_diff_governance = {
                    visual_diff_required: resolvedVisualDiffGov.visual_diff_required ?? false,
                    visual_diff_performed: resolvedVisualDiffGov.visual_diff_performed ?? false,
                    visual_change_detected: resolvedVisualDiffGov.visual_change_detected ?? false,
                    visual_review_required: resolvedVisualDiffGov.visual_review_required ?? false,
                    render_tool_gap: resolvedVisualDiffGov.render_tool_gap ?? false,
                    max_changed_pixel_ratio: resolvedVisualDiffGov.max_changed_pixel_ratio ?? 0,
                    proof_artifacts_available: resolvedVisualDiffGov.proof_artifacts_available ?? false,
                    production_certified: false,
                    standard_certified: false,
                    warnings: resolvedVisualDiffGov.warnings || [],
                    evidence: resolvedVisualDiffGov.evidence || {}
                };
            }

            if (resolvedProofApprovalGov) {
                artifact_summary.proof_approval_governance = {
                    proof_required: resolvedProofApprovalGov.proof_required ?? false,
                    proof_available: resolvedProofApprovalGov.proof_available ?? false,
                    proof_id: resolvedProofApprovalGov.proof_id ?? null,
                    proof_status: resolvedProofApprovalGov.proof_status ?? 'NOT_REQUIRED',
                    visual_change_detected: resolvedProofApprovalGov.visual_change_detected ?? false,
                    review_required: resolvedProofApprovalGov.review_required ?? false,
                    production_certified: false,
                    evidence: resolvedProofApprovalGov.evidence || {}
                };
            }

            if (resolvedHeavyPdfProbeGov) {
                artifact_summary.heavy_pdf_probe_governance = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(resolvedHeavyPdfProbeGov, 'customer');
                if (artifact_summary.heavy_pdf_probe_governance.review_required) {
                    artifact_summary.production_ready_artifact_available = false;
                }
            }

            if (resolvedProductionPackageGov) {
                // Service is the final authority: package_ready can never be true if Service-level
                // production/review gates are not satisfied, regardless of upstream evidence.
                const packageReady = resolvedProductionPackageGov.package_ready === true && productionCertified === true && requiresReview === false;
                artifact_summary.production_package_governance = {
                    package_ready: packageReady,
                    approved_artifact_type: packageReady ? (resolvedProductionPackageGov.approved_artifact_type ?? null) : null,
                    approved_artifact_hash: packageReady ? (resolvedProductionPackageGov.approved_artifact_hash ?? null) : null,
                    included_reports: resolvedProductionPackageGov.included_reports || [],
                    blocked_by_governance_domains: resolvedProductionPackageGov.blocked_by_governance_domains || [],
                    warnings: resolvedProductionPackageGov.warnings || [],
                    evidence: resolvedProductionPackageGov.evidence || {}
                };
            }

            if (resolvedMachineReadinessGov) {
                // Phase 73C: machine_readiness_governance is an advisory signal set for
                // machine assignment (Phase 73D) only. It is never a certification authority.
                artifact_summary.machine_readiness_governance = {
                    machine_capability_signals: resolvedMachineReadinessGov.machine_capability_signals || {},
                    machine_match_required: resolvedMachineReadinessGov.machine_match_required ?? false,
                    incompatible_machine_reasons: resolvedMachineReadinessGov.incompatible_machine_reasons || [],
                    warnings: resolvedMachineReadinessGov.warnings || [],
                    machine_match_authority: false,
                    production_certified: false,
                    standard_certified: false,
                    evidence: resolvedMachineReadinessGov.evidence || {}
                };
            }

            return {
                ok: true,
                job_id: jobId,
                artifacts: artifactListArray,
                artifact_summary: artifact_summary,
                downloadable_artifact_count: artifact_summary.downloadable_artifact_count,
                zero_byte_artifact_count: artifact_summary.zero_byte_artifact_count,
                physical_artifacts_ready: artifact_summary.physical_artifacts_ready,
                source_status: "PHYSICAL_OUTPUT_FALLBACK"
            };
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

    _buildFixCoverage(findings, repairs) {
        const repairByCode = {};
        for (const r of repairs) {
            if (r?.code) repairByCode[r.code] = r;
        }

        const fixed = [], skipped = [], failed = [], not_attempted = [];

        for (const f of findings) {
            const strategy = f?.fix_method || f?.repairStrategy || f?.recommended_fix || null;
            const entry = {
                issue_code: f?.code || f?.type || null,
                severity: f?.severity || null,
                message: f?.message || f?.description || null,
                fix_method: strategy
            };

            if (!strategy) {
                not_attempted.push(entry);
                continue;
            }

            const repair = repairByCode[strategy];
            if (!repair) {
                not_attempted.push(entry);
                continue;
            }

            const repairEntry = {
                ...entry,
                repair_code: repair.code,
                repair_status: repair.status,
                repair_reason: repair.reason || repair.message || null
            };

            if (repair.status === 'APPLIED') fixed.push(repairEntry);
            else if (repair.status === 'FAILED') failed.push(repairEntry);
            // Engine emits several "not applied" status variants (SKIPPED,
            // SKIPPED_UNSUPPORTED, UNSUPPORTED, UNSUPPORTED_FIX, NO_CHANGE, ...) —
            // classify by exclusion so a matched repair is never silently dropped.
            else skipped.push(repairEntry);
        }

        return {
            total_issues: findings.length,
            fixed_count: fixed.length,
            skipped_count: skipped.length,
            failed_count: failed.length,
            not_attempted_count: not_attempted.length,
            fixed,
            skipped,
            failed,
            not_attempted
        };
    }

    /**
     * _normalizeJobPayload
     * Enforces strict API normalization for job payloads and Control Plane compatibility adapters.
     * Prevents contradictory invariant states, deduplicates findings, and implements separate counters.
     */
    _normalizeJobPayload(job, artifacts, rawResult, sourceFindings = []) {
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
        const isAutofixJob = job?.job_type === 'AUTOFIX' || res?.type === 'AUTOFIX';

        if (isAutofixJob) {
            const allRepairs = res.repairs || res.fixes || [];
            let skippedFixes = Array.isArray(res.skipped_fixes) ? res.skipped_fixes : [];
            let appliedFixes = Array.isArray(res.applied_fixes) ? res.applied_fixes : [];
            let failedFixes = Array.isArray(res.failed_fixes) ? res.failed_fixes : [];

            // Extract from repairs if not explicitly provided
            if (skippedFixes.length === 0 && appliedFixes.length === 0 && failedFixes.length === 0 && allRepairs.length > 0) {
                appliedFixes = allRepairs.filter(r => r.status === 'APPLIED');
                failedFixes = allRepairs.filter(r => r.status === 'FAILED');
                // The engine emits several "not applied" status variants (SKIPPED,
                // SKIPPED_UNSUPPORTED, UNSUPPORTED, UNSUPPORTED_FIX, NO_CHANGE, ...).
                // Classify by exclusion so repairsCount always equals applied+skipped+failed.
                skippedFixes = allRepairs.filter(r => r.status !== 'APPLIED' && r.status !== 'FAILED');
            }
            
            const fixRequiresHumanReview = (fix) => {
                return Boolean(
                    fix?.requires_human_review === true ||
                    fix?.requiresHumanReview === true ||
                    fix?.destructiveFixRisk === "HIGH" ||
                    String(fix?.code || "").toUpperCase() === "CONVERT_CMYK" ||
                    /destructive|explicit review|human review/i.test(String(fix?.reason || ""))
                );
            };
            
            const appliedRequiresReview = appliedFixes.filter(fixRequiresHumanReview);
            const hasSkipped = skippedFixes.length > 0;
            const requiresReview = hasSkipped || appliedRequiresReview.length > 0;
            
            normalizedResult.skipped_fixes = skippedFixes;
            normalizedResult.applied_fixes = appliedFixes;
            normalizedResult.failed_fixes = failedFixes;
            normalizedResult.skippedFixesCount = skippedFixes.length;
            normalizedResult.appliedFixesCount = appliedFixes.length;
            normalizedResult.failedFixesCount = failedFixes.length;
            normalizedResult.repairs = allRepairs;
            normalizedResult.repairsCount = allRepairs.length;
            normalizedResult.requested_fixes = res.requested_fixes || [];
            normalizedResult.requestedFixesCount = normalizedResult.requested_fixes.length;

            const pdfxUnsupported = skippedFixes.some(f => ['CONVERT_TO_PDFX_TRANSPARENCY_SAFE', 'CONVERT_TO_PDFX', 'GENERATE_PDFX'].includes(String(f.code || '').toUpperCase())) ||
                                    failedFixes.some(f => ['CONVERT_TO_PDFX_TRANSPARENCY_SAFE', 'CONVERT_TO_PDFX', 'GENERATE_PDFX'].includes(String(f.code || '').toUpperCase()));
            if (pdfxUnsupported) {
                normalizedResult.pdfx_compliance_claimed = false;
                normalizedResult.pdfx_generation_performed = false;
                if (normalizedResult.transparency_overprint_governance) {
                    normalizedResult.transparency_overprint_governance.pdfx_compliance_claimed = false;
                    normalizedResult.transparency_overprint_governance.pdfx_generation_performed = false;
                }
            }

            const coverageFindings = sourceFindings.length > 0
                ? sourceFindings
                : (normalizedResult.findings || []);
            if (coverageFindings.length > 0 || allRepairs.length > 0) {
                normalizedResult.fix_coverage = this._buildFixCoverage(coverageFindings, allRepairs);
            }

            if (requiresReview) {
                finalJobStatus = 'AUTOFIX_REVIEW_REQUIRED';
                normalizedResult.status = 'AUTOFIX_REVIEW_REQUIRED';
                normalizedResult.final_status = 'AUTOFIX_REVIEW_REQUIRED';
                normalizedResult.technicallyFixed = false;
                normalizedResult.productionCertified = false;
                normalizedResult.requiresHumanReview = true;
                normalizedResult.reviewReasons = normalizedResult.reviewReasons || [];
                
                if (hasSkipped) {
                    normalizedResult.reviewReasons.push("Some fixes were skipped and require review.");
                } else if (appliedRequiresReview.length > 0) {
                    if (appliedRequiresReview.some(f => String(f.code || "").toUpperCase() === "CONVERT_CMYK")) {
                        normalizedResult.reviewReasons.push("CMYK conversion was applied and requires human visual review.");
                    } else {
                        normalizedResult.reviewReasons.push("One or more applied fixes require human review before production certification.");
                    }
                }
            }
        }

        // Standards Overclaim Protection & Artifact Trust Override
        const standardsGov = res?.standards_certification_governance || res?.fix_summary?.standards_certification_governance || {};
        const rootArtifactTrust = res?.artifact_trust || res?.fix_summary?.artifact_trust || {};
        const structuralGov = res?.structural_metadata_governance || res?.fix_summary?.structural_metadata_governance || {};
        
        // Extract evidence fields considering artifact_trust.evidence
        const evidenceSrc = rootArtifactTrust.evidence || {};
        
        let validation_performed = evidenceSrc.validation_performed ?? res.validation_performed ?? standardsGov.validation_performed ?? false;
        let validation_passed = evidenceSrc.validation_passed ?? res.validation_passed ?? standardsGov.validation_passed ?? false;
        let compliance_claim_allowed = evidenceSrc.compliance_claim_allowed ?? rootArtifactTrust.compliance_claim_allowed ?? res.compliance_claim_allowed ?? standardsGov.compliance_claim_allowed ?? false;
        let validator_available = evidenceSrc.validator_available ?? res.validator_available ?? standardsGov.validator_available ?? false;

        if (structuralGov.internal_standard_report_generated === true) {
            validation_performed = false;
            validation_passed = false;
            validator_available = false;
        }

        // Phase 68C: validation_report_hash is the canonical 7th evidence field.
        // compliance_claim_allowed=true requires all 7 fields present (Phase 68B policy).
        const hasValidEvidence = validation_performed && validation_passed &&
                                 (evidenceSrc.validator_name || res.validator_name || standardsGov.validator_name) &&
                                 (evidenceSrc.validator_version || res.validator_version || standardsGov.validator_version) &&
                                 (evidenceSrc.standard_detected || res.standard_detected || standardsGov.standard_detected) &&
                                 (evidenceSrc.validation_report_hash || res.validation_report_hash || standardsGov.validation_report_hash);

        const isClaimingCompliance = rootArtifactTrust.standard_certified || rootArtifactTrust.pdfx_compliance_claimed || res.pdfx_compliance_claimed || res.pdfa_compliance_claimed || res.standard_certified || compliance_claim_allowed || res.standard_claimed || standardsGov.pdfx_compliance_claimed || standardsGov.standard_certified;

        if ((isClaimingCompliance && (!hasValidEvidence || !compliance_claim_allowed)) || structuralGov.metadata_cleanup_applied === true) {
            normalizedResult.pdfx_compliance_claimed = false;
            normalizedResult.pdfa_compliance_claimed = false;
            normalizedResult.standard_certified = false;
            normalizedResult.compliance_claim_allowed = false;
            normalizedResult.standard_claimed = null;
            normalizedResult.requiresHumanReview = true;
            normalizedResult.productionCertified = false;
            
            if (rootArtifactTrust && Object.keys(rootArtifactTrust).length > 0) {
                rootArtifactTrust.standard_certified = false;
                rootArtifactTrust.pdfx_compliance_claimed = false;
                rootArtifactTrust.pdfa_compliance_claimed = false;
                rootArtifactTrust.compliance_claim_allowed = false;
            }
            
            normalizedResult.reviewReasons = normalizedResult.reviewReasons || [];
            if (!normalizedResult.reviewReasons.includes('STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE')) {
                normalizedResult.reviewReasons.push('STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE');
            }
            
            if (!normalizedResult.warnings) normalizedResult.warnings = [];
            if (!normalizedResult.warnings.includes('STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE')) {
                normalizedResult.warnings.push('STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE');
            }
            
            if (normalizedResult.standards_certification_governance) {
                normalizedResult.standards_certification_governance.pdfx_compliance_claimed = false;
                normalizedResult.standards_certification_governance.pdfa_compliance_claimed = false;
                normalizedResult.standards_certification_governance.standard_certified = false;
                normalizedResult.standards_certification_governance.compliance_claim_allowed = false;
                normalizedResult.standards_certification_governance.standard_claimed = null;
                normalizedResult.standards_certification_governance.review_required = true;
                
                normalizedResult.standards_certification_governance.review_required_reasons = normalizedResult.standards_certification_governance.review_required_reasons || [];
                if (!normalizedResult.standards_certification_governance.review_required_reasons.includes('STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE')) {
                    normalizedResult.standards_certification_governance.review_required_reasons.push('STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE');
                }
            }
        }

        // Apply standards governance to root
        let standardsGovActive = false;
        let standardsCertPdfAllowed = true;
        let standardsReviewRequired = false;
        
        if (standardsGov.review_required === true) standardsReviewRequired = true;
        if (standardsGov.certified_pdf_allowed === false) standardsCertPdfAllowed = false;
        if (standardsGov.production_certified === false) standardsGovActive = true;
        if (standardsGov.review_required_reasons && standardsGov.review_required_reasons.length > 0) standardsReviewRequired = true;
        if (standardsGov.review_required_standards_reasons && standardsGov.review_required_standards_reasons.length > 0) standardsReviewRequired = true;
        
        if (standardsGovActive || standardsCertPdfAllowed === false || standardsReviewRequired) {
            normalizedResult.productionCertified = false;
            if (standardsReviewRequired) {
                normalizedResult.requiresHumanReview = true;
            }
        }

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

        const autofixRootLifts = {
            ...(res.sourceJobId ? { sourceJobId: res.sourceJobId } : {}),
            ...(normalizedResult.repairs ? { repairs: normalizedResult.repairs } : {}),
            ...(normalizedResult.fixes ? { fixes: normalizedResult.fixes } : {}),
            ...(normalizedResult.requested_fixes || normalizedResult.fixes ? { requested_fixes: normalizedResult.requested_fixes || normalizedResult.fixes } : {}),
            ...(normalizedResult.skipped_fixes ? { skipped_fixes: normalizedResult.skipped_fixes } : {}),
            ...(normalizedResult.applied_fixes ? { applied_fixes: normalizedResult.applied_fixes } : {}),
            ...(normalizedResult.failed_fixes ? { failed_fixes: normalizedResult.failed_fixes } : {}),
            ...(normalizedResult.repairsCount !== undefined ? { repairsCount: normalizedResult.repairsCount } : {}),
            ...(normalizedResult.requestedFixesCount !== undefined ? { requestedFixesCount: normalizedResult.requestedFixesCount } : {}),
            ...(normalizedResult.skippedFixesCount !== undefined ? { skippedFixesCount: normalizedResult.skippedFixesCount } : {}),
            ...(normalizedResult.appliedFixesCount !== undefined ? { appliedFixesCount: normalizedResult.appliedFixesCount } : {}),
            ...(normalizedResult.failedFixesCount !== undefined ? { failedFixesCount: normalizedResult.failedFixesCount } : {}),
            ...(normalizedResult.productionCertified !== undefined ? { productionCertified: normalizedResult.productionCertified } : {}),
            ...(normalizedResult.requiresHumanReview !== undefined ? { requiresHumanReview: normalizedResult.requiresHumanReview } : {}),
            ...(normalizedResult.reviewReasons ? { reviewReasons: normalizedResult.reviewReasons } : {}),
            ...(normalizedResult.fix_coverage ? { fix_coverage: normalizedResult.fix_coverage } : {}),
            ...(res.warnings ? { warnings: res.warnings } : {}),
            ...(res.degraded_reasons ? { degraded_reasons: res.degraded_reasons } : {}),
            ...(res.forceBleed !== undefined ? { forceBleed: res.forceBleed } : {}),
            ...(res.targetProfile ? { targetProfile: res.targetProfile } : {}),
            ...(res.qpdf_warnings ? { qpdf_warnings: res.qpdf_warnings } : {}),
            ...(res.metadata_cleanup_warnings ? { metadata_cleanup_warnings: res.metadata_cleanup_warnings } : {}),
            ...(res.internal_report_markers ? { internal_report_markers: res.internal_report_markers } : {})
        };

        let productionCertified = rootArtifactTrust.production_certified !== undefined ? rootArtifactTrust.production_certified : (normalizedResult.productionCertified !== undefined ? normalizedResult.productionCertified : (res.production_certified !== false && res.productionCertified !== false && res.summary?.after?.production_certified !== false));
        let requiresReview = rootArtifactTrust.review_required !== undefined ? rootArtifactTrust.review_required : (normalizedResult.requiresHumanReview !== undefined ? normalizedResult.requiresHumanReview : (res.requires_human_review === true || res.requiresHumanReview === true || res.summary?.after?.requires_human_review === true || consensusStatus === "COMPLETED_WITH_REVIEW" || consensusStatus === "AUTOFIX_PARTIAL" || productionCertified === false || job?.status === "COMPLETED_WITH_REVIEW" || job?.status === "AUTOFIX_PARTIAL"));

        if (structuralGov.production_certified === false) {
            productionCertified = false;
            normalizedResult.productionCertified = false;
        }
        if (structuralGov.review_required === true) {
            requiresReview = true;
            normalizedResult.requiresHumanReview = true;
        }

        // Phase 62C: Page Marks Governance Enforcement
        // artifact_trust is the final authority — page_marks_governance informs/degrades but does not
        // override explicit artifact_trust allowances.
        const pageMarksGov = res?.page_marks_governance || res?.fix_summary?.page_marks_governance || {};
        const atExplicitlyAllowsProduction = rootArtifactTrust.production_certified === true;
        const atExplicitlyNoReview = rootArtifactTrust.review_required === false;

        const pageMarksRequiresBlock = Object.keys(pageMarksGov).length > 0 && (
            pageMarksGov.production_certified === false ||
            pageMarksGov.certified_pdf_allowed === false ||
            pageMarksGov.page_marks_fix_applied === true ||
            pageMarksGov.crop_marks_added === true ||
            pageMarksGov.removal_not_safe === true ||
            pageMarksGov.marks_inside_trim === true
        );

        if (!atExplicitlyAllowsProduction && pageMarksRequiresBlock) {
            productionCertified = false;
            normalizedResult.productionCertified = false;
        }
        if (!atExplicitlyNoReview && pageMarksGov.review_required === true) {
            requiresReview = true;
            normalizedResult.requiresHumanReview = true;
        }
        if (pageMarksGov.page_marks_fix_applied === true && !atExplicitlyAllowsProduction) {
            normalizedResult.standard_certified = false;
            normalizedResult.pdfx_compliance_claimed = false;
            normalizedResult.pdfa_compliance_claimed = false;
            normalizedResult.compliance_claim_allowed = false;
            if (rootArtifactTrust && Object.keys(rootArtifactTrust).length > 0) {
                rootArtifactTrust.standard_certified = false;
                rootArtifactTrust.pdfx_compliance_claimed = false;
                rootArtifactTrust.pdfa_compliance_claimed = false;
                rootArtifactTrust.compliance_claim_allowed = false;
            }
        }

        // Phase 63C: Security / Interactivity Governance Enforcement
        // artifact_trust is the final authority — security_interactivity_governance informs/degrades but does not
        // override explicit artifact_trust allowances.
        const securityInteractivityGov = res?.security_interactivity_governance || res?.fix_summary?.security_interactivity_governance || {};

        const securityInteractivityRequiresBlock = Object.keys(securityInteractivityGov).length > 0 && (
            securityInteractivityGov.production_certified === false ||
            securityInteractivityGov.certified_pdf_allowed === false ||
            securityInteractivityGov.security_interactivity_fix_applied === true ||
            securityInteractivityGov.active_content_removed === true ||
            securityInteractivityGov.annotation_flatten_skipped === true ||
            securityInteractivityGov.form_flatten_skipped === true ||
            securityInteractivityGov.unresolved_interactive_content === true
        );

        if (!atExplicitlyAllowsProduction && securityInteractivityRequiresBlock) {
            productionCertified = false;
            normalizedResult.productionCertified = false;
        }
        if (!atExplicitlyNoReview && securityInteractivityGov.review_required === true) {
            requiresReview = true;
            normalizedResult.requiresHumanReview = true;
        }
        if (securityInteractivityGov.security_interactivity_fix_applied === true && !atExplicitlyAllowsProduction) {
            normalizedResult.standard_certified = false;
            normalizedResult.pdfx_compliance_claimed = false;
            normalizedResult.pdfa_compliance_claimed = false;
            normalizedResult.compliance_claim_allowed = false;
            if (rootArtifactTrust && Object.keys(rootArtifactTrust).length > 0) {
                rootArtifactTrust.standard_certified = false;
                rootArtifactTrust.pdfx_compliance_claimed = false;
                rootArtifactTrust.pdfa_compliance_claimed = false;
                rootArtifactTrust.compliance_claim_allowed = false;
            }
        }

        // Phase 64C: Ink Governance Enforcement
        // artifact_trust is the final authority — ink_governance informs/degrades but does not
        // override explicit artifact_trust allowances.
        const inkGov = res?.ink_governance || res?.fix_summary?.ink_governance || {};

        const inkGovRequiresBlock = Object.keys(inkGov).length > 0 && (
            inkGov.production_certified === false ||
            inkGov.certified_pdf_allowed === false ||
            inkGov.ink_fix_applied === true ||
            inkGov.tac_reduction_attempted === true ||
            inkGov.tac_reduction_applied === true ||
            inkGov.rich_black_text_mapped === true ||
            inkGov.registration_color_mapped === true ||
            inkGov.visual_change_expected === true
        );

        if (!atExplicitlyAllowsProduction && inkGovRequiresBlock) {
            productionCertified = false;
            normalizedResult.productionCertified = false;
        }
        if (!atExplicitlyNoReview && inkGov.review_required === true) {
            requiresReview = true;
            normalizedResult.requiresHumanReview = true;
        }
        if (inkGov.ink_fix_applied === true && !atExplicitlyAllowsProduction) {
            normalizedResult.standard_certified = false;
            normalizedResult.pdfx_compliance_claimed = false;
            normalizedResult.pdfa_compliance_claimed = false;
            normalizedResult.compliance_claim_allowed = false;
            if (rootArtifactTrust && Object.keys(rootArtifactTrust).length > 0) {
                rootArtifactTrust.standard_certified = false;
                rootArtifactTrust.pdfx_compliance_claimed = false;
                rootArtifactTrust.pdfa_compliance_claimed = false;
                rootArtifactTrust.compliance_claim_allowed = false;
            }
        }

        // Phase 65C: Selective Image Governance Enforcement
        // artifact_trust is the final authority — selective_image_governance informs/degrades but does not
        // override explicit artifact_trust allowances.
        const selectiveImageGov = res?.selective_image_governance || res?.fix_summary?.selective_image_governance || {};

        const selectiveImageGovRequiresBlock = Object.keys(selectiveImageGov).length > 0 && (
            selectiveImageGov.production_certified === false ||
            selectiveImageGov.certified_pdf_allowed === false ||
            selectiveImageGov.image_fix_applied === true ||
            selectiveImageGov.rgb_images_converted === true ||
            selectiveImageGov.image_profiles_normalized === true ||
            selectiveImageGov.excessive_resolution_downsampled === true ||
            selectiveImageGov.low_res_unfixable === true ||
            selectiveImageGov.visual_change_expected === true
        );

        if (!atExplicitlyAllowsProduction && selectiveImageGovRequiresBlock) {
            productionCertified = false;
            normalizedResult.productionCertified = false;
        }
        if (!atExplicitlyNoReview && selectiveImageGov.review_required === true) {
            requiresReview = true;
            normalizedResult.requiresHumanReview = true;
        }
        if (selectiveImageGov.image_fix_applied === true && !atExplicitlyAllowsProduction) {
            normalizedResult.standard_certified = false;
            normalizedResult.pdfx_compliance_claimed = false;
            normalizedResult.pdfa_compliance_claimed = false;
            normalizedResult.compliance_claim_allowed = false;
            if (rootArtifactTrust && Object.keys(rootArtifactTrust).length > 0) {
                rootArtifactTrust.standard_certified = false;
                rootArtifactTrust.pdfx_compliance_claimed = false;
                rootArtifactTrust.pdfa_compliance_claimed = false;
                rootArtifactTrust.compliance_claim_allowed = false;
            }
        }

        // Phase 67C: Transparency / Overprint Physical Governance Enforcement
        // Physical flattens (transparency, overprint, blend modes) are always review-required.
        // artifact_trust is the final authority but physical governance always degrades.
        const transparencyOverprintPhysicalGov = res?.transparency_overprint_physical_governance || res?.fix_summary?.transparency_overprint_physical_governance || {};

        const topPhysicalGovRequiresBlock = Object.keys(transparencyOverprintPhysicalGov).length > 0 && (
            transparencyOverprintPhysicalGov.production_certified === false ||
            transparencyOverprintPhysicalGov.certified_pdf_allowed === false ||
            transparencyOverprintPhysicalGov.physical_flatten_applied === true ||
            transparencyOverprintPhysicalGov.visual_change_expected === true
        );

        if (!atExplicitlyAllowsProduction && topPhysicalGovRequiresBlock) {
            productionCertified = false;
            normalizedResult.productionCertified = false;
        }
        if (!atExplicitlyNoReview && transparencyOverprintPhysicalGov.review_required === true) {
            requiresReview = true;
            normalizedResult.requiresHumanReview = true;
        }
        if (topPhysicalGovRequiresBlock && !atExplicitlyAllowsProduction) {
            normalizedResult.standard_certified = false;
            normalizedResult.pdfx_compliance_claimed = false;
            normalizedResult.pdfa_compliance_claimed = false;
            normalizedResult.compliance_claim_allowed = false;
            if (rootArtifactTrust && Object.keys(rootArtifactTrust).length > 0) {
                rootArtifactTrust.standard_certified = false;
                rootArtifactTrust.pdfx_compliance_claimed = false;
                rootArtifactTrust.pdfa_compliance_claimed = false;
                rootArtifactTrust.compliance_claim_allowed = false;
            }
        }

        // Phase 69C: Visual Diff Governance Enforcement
        // visual_diff_governance signals that a visually sensitive fix was applied.
        // visual_review_required=true or visual_change_detected=true blocks certified.pdf.
        const visualDiffGovNorm = res?.visual_diff_governance || res?.fix_summary?.visual_diff_governance || {};

        const visualDiffGovRequiresBlock = Object.keys(visualDiffGovNorm).length > 0 && (
            visualDiffGovNorm.production_certified === false ||
            visualDiffGovNorm.visual_review_required === true ||
            visualDiffGovNorm.visual_change_detected === true
        );

        if (!atExplicitlyAllowsProduction && visualDiffGovRequiresBlock) {
            productionCertified = false;
            normalizedResult.productionCertified = false;
        }
        if (!atExplicitlyNoReview && (visualDiffGovNorm.visual_review_required === true || visualDiffGovNorm.visual_change_detected === true)) {
            requiresReview = true;
            normalizedResult.requiresHumanReview = true;
        }
        if (visualDiffGovRequiresBlock && !atExplicitlyAllowsProduction) {
            normalizedResult.standard_certified = false;
            normalizedResult.compliance_claim_allowed = false;
            if (rootArtifactTrust && Object.keys(rootArtifactTrust).length > 0) {
                rootArtifactTrust.standard_certified = false;
                rootArtifactTrust.compliance_claim_allowed = false;
            }
        }

        // Phase 70C: Proof Approval Governance Enforcement
        // proof_required=true and proof_status!=APPROVED blocks production.
        // visual_change_detected=true and proof_status!=APPROVED blocks production.
        const proofApprovalGovNorm = res?.proof_approval_governance || res?.fix_summary?.proof_approval_governance || {};

        const proofApprovalRequiresBlock = Object.keys(proofApprovalGovNorm).length > 0 && (
            (proofApprovalGovNorm.proof_required === true && proofApprovalGovNorm.proof_status !== 'APPROVED') ||
            (proofApprovalGovNorm.visual_change_detected === true && proofApprovalGovNorm.proof_status !== 'APPROVED')
        );

        if (!atExplicitlyAllowsProduction && proofApprovalRequiresBlock) {
            productionCertified = false;
            normalizedResult.productionCertified = false;
        }
        if (!atExplicitlyNoReview && proofApprovalGovNorm.review_required === true) {
            requiresReview = true;
            normalizedResult.requiresHumanReview = true;
        }
        if (proofApprovalRequiresBlock && !atExplicitlyAllowsProduction) {
            normalizedResult.standard_certified = false;
            normalizedResult.compliance_claim_allowed = false;
            if (rootArtifactTrust && Object.keys(rootArtifactTrust).length > 0) {
                rootArtifactTrust.standard_certified = false;
                rootArtifactTrust.compliance_claim_allowed = false;
            }
        }

        // Phase 62F-C: Heavy PDF Probe Governance Enforcement
        // heavy_pdf_probe_governance explains analysis quality. It does not certify the
        // PDF and never overrides artifact_trust in the "allow" direction — it can only
        // degrade. fatal_document_failure=true wins over degraded_but_usable.
        const heavyPdfProbeGovNorm = res?.heavy_pdf_probe_governance
            || res?.fix_summary?.heavy_pdf_probe_governance
            || res?.delta_report?.heavy_pdf_probe_governance
            || {};

        const heavyPdfProbeGovRequiresBlock = Object.keys(heavyPdfProbeGovNorm).length > 0 && (
            heavyPdfProbeGovNorm.production_certified === false ||
            heavyPdfProbeGovNorm.fatal_document_failure === true ||
            heavyPdfProbeGovNorm.review_required === true ||
            heavyPdfProbeGovNorm.analysis_degraded === true
        );

        if (!atExplicitlyAllowsProduction && heavyPdfProbeGovRequiresBlock) {
            productionCertified = false;
            normalizedResult.productionCertified = false;
        }
        if (!atExplicitlyNoReview && (heavyPdfProbeGovNorm.review_required === true || heavyPdfProbeGovNorm.fatal_document_failure === true)) {
            requiresReview = true;
            normalizedResult.requiresHumanReview = true;
        }
        if (heavyPdfProbeGovRequiresBlock && !atExplicitlyAllowsProduction) {
            normalizedResult.standard_certified = false;
            normalizedResult.pdfx_compliance_claimed = false;
            normalizedResult.pdfa_compliance_claimed = false;
            normalizedResult.compliance_claim_allowed = false;
            if (rootArtifactTrust && Object.keys(rootArtifactTrust).length > 0) {
                rootArtifactTrust.standard_certified = false;
                rootArtifactTrust.pdfx_compliance_claimed = false;
                rootArtifactTrust.pdfa_compliance_claimed = false;
                rootArtifactTrust.compliance_claim_allowed = false;
            }
        }

        const heavyPdfProbeGovCustomer = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(heavyPdfProbeGovNorm, 'customer');
        const heavyPdfProbeGovOperator = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(heavyPdfProbeGovNorm, 'operator');

        // Phase 66C: Font Governance Enforcement
        // artifact_trust is the final authority — font_governance informs/degrades but does not
        // override explicit artifact_trust allowances.
        const fontGov = res?.font_governance || res?.fix_summary?.font_governance || {};

        const fontGovRequiresBlock = Object.keys(fontGov).length > 0 && (
            fontGov.production_certified === false ||
            fontGov.certified_pdf_allowed === false ||
            fontGov.font_fix_applied === true ||
            fontGov.fonts_embedded === true ||
            fontGov.font_embedding_skipped === true ||
            fontGov.type3_fonts_detected === true ||
            fontGov.glyphs_missing_unfixable === true ||
            fontGov.font_source_available === false
        );

        if (!atExplicitlyAllowsProduction && fontGovRequiresBlock) {
            productionCertified = false;
            normalizedResult.productionCertified = false;
        }
        if (!atExplicitlyNoReview && fontGov.review_required === true) {
            requiresReview = true;
            normalizedResult.requiresHumanReview = true;
        }
        if (fontGov.font_fix_applied === true && !atExplicitlyAllowsProduction) {
            normalizedResult.standard_certified = false;
            normalizedResult.pdfx_compliance_claimed = false;
            normalizedResult.pdfa_compliance_claimed = false;
            normalizedResult.compliance_claim_allowed = false;
            if (rootArtifactTrust && Object.keys(rootArtifactTrust).length > 0) {
                rootArtifactTrust.standard_certified = false;
                rootArtifactTrust.pdfx_compliance_claimed = false;
                rootArtifactTrust.pdfa_compliance_claimed = false;
                rootArtifactTrust.compliance_claim_allowed = false;
            }
        }

        let returnedArtifacts = isAutofixJob ? (res.artifacts || artifactList.reduce((acc, a) => ({ ...acc, [a.type]: a.name }), {})) : artifactList;
        
        let certification_level = 'UNKNOWN';
        const isBlocked = finalJobStatus === 'FAILED' || finalJobStatus === 'PARTIAL_ARTIFACTS' || finalJobStatus === 'DEGRADED';
        const hasFixedPdf = artifactList.some(a => (a.type === 'fixed_pdf' || a.type === 'final_fixed_pdf') && a.downloadable);
        const hasReviewPdf = artifactList.some(a => a.type === 'review_pdf' && a.downloadable);
        const hasCertifiedPdf = artifactList.some(a => a.type === 'certified_pdf' && a.downloadable);
        const hasReport = artifactList.some(a => ['analysis_report', 'report_json'].includes(a.type) && a.downloadable);

        if (finalJobStatus === 'PROCESSING' || finalJobStatus === 'QUEUED') {
            certification_level = 'PROCESSING';
        } else if (isBlocked) {
            certification_level = 'BLOCKED';
        } else if ((productionCertified && hasCertifiedPdf && !requiresReview) || (!isAutofixJob && hasCertifiedPdf && !isBlocked)) {
            certification_level = 'CERTIFIED_READY';
        } else if (requiresReview && (hasFixedPdf || hasReviewPdf)) {
            certification_level = 'FIXED_REVIEW_REQUIRED';
        } else if (hasFixedPdf && !requiresReview) {
            certification_level = 'FIXED_READY';
        } else if (hasReport && !hasFixedPdf && !hasCertifiedPdf) {
            certification_level = 'ANALYSIS_ONLY';
        }
        
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
             
             if (finalJobStatus === 'AUTOFIX_REVIEW_REQUIRED') {
                 const af = res.applied_fixes || res.fixes || res.repairs || [];
                 if (af.length === 0) {
                     delete returnedArtifacts.review_pdf;
                     delete returnedArtifacts.fixed_pdf;
                     delete returnedArtifacts.final_fixed_pdf;
                     delete returnedArtifacts.certified_pdf;
                 }
             }
        }

        // Phase 71C: Production Package Governance Exposure
        // production_package_governance is a packaging/handoff manifest derived from upstream
        // gates (artifact_trust, proof_approval_governance, payment). Service is the final
        // authority: package_ready and the approved artifact manifest are only exposed when
        // the Service's own production/review gates are also satisfied.
        const productionPackageGovNorm = res?.production_package_governance
            || res?.fix_summary?.production_package_governance
            || res?.delta_report?.production_package_governance
            || {};

        // Phase 73C: Machine Readiness Governance Exposure
        // machine_readiness_governance is an advisory signal set for machine assignment
        // (Phase 73D) only. It is never a certification authority — machine_match_authority,
        // production_certified, and standard_certified are always forced to false here
        // regardless of upstream values.
        const machineReadinessGovNorm = res?.machine_readiness_governance
            || res?.fix_summary?.machine_readiness_governance
            || res?.delta_report?.machine_readiness_governance
            || {};

        const machineReadinessGovExposed = Object.keys(machineReadinessGovNorm).length > 0 ? {
            machine_capability_signals: machineReadinessGovNorm.machine_capability_signals || {},
            machine_match_required: machineReadinessGovNorm.machine_match_required ?? false,
            incompatible_machine_reasons: machineReadinessGovNorm.incompatible_machine_reasons || [],
            warnings: machineReadinessGovNorm.warnings || [],
            machine_match_authority: false,
            production_certified: false,
            standard_certified: false,
            evidence: machineReadinessGovNorm.evidence || {}
        } : undefined;

        const productionPackageGovExposed = Object.keys(productionPackageGovNorm).length > 0 ? (() => {
            const packageReady = productionPackageGovNorm.package_ready === true && productionCertified === true && requiresReview === false;
            return {
                package_ready: packageReady,
                approved_artifact_type: packageReady ? (productionPackageGovNorm.approved_artifact_type ?? null) : null,
                approved_artifact_hash: packageReady ? (productionPackageGovNorm.approved_artifact_hash ?? null) : null,
                included_reports: productionPackageGovNorm.included_reports || [],
                blocked_by_governance_domains: productionPackageGovNorm.blocked_by_governance_domains || [],
                warnings: productionPackageGovNorm.warnings || [],
                evidence: productionPackageGovNorm.evidence || {}
            };
        })() : undefined;

        const artifactListArray = Array.isArray(artifactList) ? artifactList : [];
        const artifact_summary = {
            artifact_count: artifactListArray.length,
            downloadable_artifact_count: artifactListArray.filter(a => a.downloadable).length,
            zero_byte_artifact_count: artifactListArray.filter(a => !a.downloadable && a.size === 0).length,
            physical_artifacts_ready: artifactListArray.length > 0,
            certified_pdf_available: artifactListArray.some(a => a.type === 'certified_pdf' && a.downloadable),
            fixed_pdf_available: artifactListArray.some(a => (a.type === 'fixed_pdf' || a.type === 'final_fixed_pdf') && a.downloadable),
            review_pdf_available: artifactListArray.some(a => a.type === 'review_pdf' && a.downloadable),
            report_available: artifactListArray.some(a => ['analysis_report', 'report_json'].includes(a.type) && a.downloadable),
            fix_audit_available: artifactListArray.some(a => a.type === 'fix_audit' && a.downloadable),
            delta_report_available: artifactListArray.some(a => a.type === 'delta_report' && a.downloadable),
            production_ready_artifact_available: artifactListArray.some(a => a.artifact_role === 'PRODUCTION_READY' && a.downloadable),
            review_required_artifact_available: artifactListArray.some(a => a.artifact_role === 'REVIEW_REQUIRED' && a.downloadable),
            artifact_trust: Object.keys(rootArtifactTrust).length > 0 ? rootArtifactTrust : undefined,
            structural_metadata_governance: Object.keys(structuralGov).length > 0 ? structuralGov : undefined,
            page_marks_governance: Object.keys(pageMarksGov).length > 0 ? pageMarksGov : undefined,
            security_interactivity_governance: Object.keys(securityInteractivityGov).length > 0 ? securityInteractivityGov : undefined,
            ink_governance: Object.keys(inkGov).length > 0 ? inkGov : undefined,
            selective_image_governance: Object.keys(selectiveImageGov).length > 0 ? selectiveImageGov : undefined,
            font_governance: Object.keys(fontGov).length > 0 ? fontGov : undefined,
            transparency_overprint_physical_governance: Object.keys(transparencyOverprintPhysicalGov).length > 0 ? transparencyOverprintPhysicalGov : undefined,
            standards_certification_governance: Object.keys(standardsGov).length > 0 ? standardsGov : undefined,
            visual_diff_governance: Object.keys(visualDiffGovNorm).length > 0 ? {
                ...visualDiffGovNorm,
                production_certified: false,
                standard_certified: false
            } : undefined,
            proof_approval_governance: Object.keys(proofApprovalGovNorm).length > 0 ? {
                ...proofApprovalGovNorm,
                production_certified: false
            } : undefined,
            heavy_pdf_probe_governance: heavyPdfProbeGovCustomer || undefined,
            production_package_governance: productionPackageGovExposed,
            machine_readiness_governance: machineReadinessGovExposed
        };

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
            artifacts: returnedArtifacts,
            artifact_summary,
            certification_level,
            production_certified: productionCertified,
            review_required: requiresReview,
            standard_certified: rootArtifactTrust.standard_certified !== undefined ? rootArtifactTrust.standard_certified : (normalizedResult.standard_certified !== undefined ? normalizedResult.standard_certified : standardsGov.standard_certified),
            pdfx_compliance_claimed: rootArtifactTrust.pdfx_compliance_claimed !== undefined ? rootArtifactTrust.pdfx_compliance_claimed : (normalizedResult.pdfx_compliance_claimed !== undefined ? normalizedResult.pdfx_compliance_claimed : standardsGov.pdfx_compliance_claimed),
            pdfa_compliance_claimed: rootArtifactTrust.pdfa_compliance_claimed !== undefined ? rootArtifactTrust.pdfa_compliance_claimed : (normalizedResult.pdfa_compliance_claimed !== undefined ? normalizedResult.pdfa_compliance_claimed : standardsGov.pdfa_compliance_claimed),
            compliance_claim_allowed: rootArtifactTrust.compliance_claim_allowed !== undefined ? rootArtifactTrust.compliance_claim_allowed : (normalizedResult.compliance_claim_allowed !== undefined ? normalizedResult.compliance_claim_allowed : standardsGov.compliance_claim_allowed),
            standards_certification_governance: normalizedResult.standards_certification_governance || standardsGov,
            // Phase 68C: expose sanitized validation_report artifact (hash/name/version/standard_detected only — no local paths)
            validation_report: (() => {
                const scg = normalizedResult.standards_certification_governance || standardsGov || {};
                const hash = scg.validation_report_hash || res.validation_report_hash;
                const name = scg.validator_name || res.validator_name;
                const version = scg.validator_version || res.validator_version;
                const detected = scg.standard_detected || res.standard_detected;
                if (!hash && !name && !version && !detected) return undefined;
                return {
                    validation_report_hash: hash || null,
                    validator_name: name || null,
                    validator_version: version || null,
                    standard_detected: detected || null,
                    available: !!(hash && name && version && detected)
                };
            })(),
            policy_mode: res.policy_mode || 'SAFE',
            fix_summary: res.fix_summary || null,
            delta_summary: res.delta_summary || null,
            artifact_trust: Object.keys(rootArtifactTrust).length > 0 ? rootArtifactTrust : undefined,
            primary_artifact_type: rootArtifactTrust.primary_artifact_type || res.primary_artifact_type || undefined,
            customer_visible: rootArtifactTrust.customer_visible !== undefined ? rootArtifactTrust.customer_visible : undefined,
            blocked_by_governance_domains: rootArtifactTrust.blocked_by_governance_domains || [],
            certification_labels: rootArtifactTrust.certification_labels || [],
            structural_metadata_governance: Object.keys(structuralGov).length > 0 ? structuralGov : undefined,
            page_marks_governance: Object.keys(pageMarksGov).length > 0 ? pageMarksGov : undefined,
            security_interactivity_governance: Object.keys(securityInteractivityGov).length > 0 ? securityInteractivityGov : undefined,
            ink_governance: Object.keys(inkGov).length > 0 ? inkGov : undefined,
            selective_image_governance: Object.keys(selectiveImageGov).length > 0 ? selectiveImageGov : undefined,
            font_governance: Object.keys(fontGov).length > 0 ? fontGov : undefined,
            transparency_overprint_physical_governance: Object.keys(transparencyOverprintPhysicalGov).length > 0 ? transparencyOverprintPhysicalGov : undefined,
            visual_diff_governance: Object.keys(visualDiffGovNorm).length > 0 ? {
                ...visualDiffGovNorm,
                production_certified: false,
                standard_certified: false
            } : undefined,
            proof_approval_governance: Object.keys(proofApprovalGovNorm).length > 0 ? {
                ...proofApprovalGovNorm,
                production_certified: false
            } : undefined,
            heavy_pdf_probe_governance: heavyPdfProbeGovCustomer || undefined,
            heavy_pdf_probe_governance_operator: heavyPdfProbeGovOperator || undefined,
            production_package_governance: productionPackageGovExposed,
            machine_readiness_governance: machineReadinessGovExposed,
            requiresHumanReview: requiresReview,
            productionCertified: productionCertified
        };
    }
}

module.exports = PreflightService;
