/**
 * Preflight Routes (Phase 4 - Governance Enforced)
 */
const PreflightService = require('../services/PreflightService');
const EngineClient = require('../clients/EngineClient');
const WorkerClient = require('../clients/WorkerClient');
const StorageManager = require('../utils/StorageManager');
const path = require('path');
const fs = require('fs-extra');
const OwnershipValidator = require('../src/auth/ownershipValidator');
const requireScope = require('../src/middleware/requireScope');
const IdentityValidator = require('../src/utils/identityValidator');
const { ErrorCodes, ErrorTypes, PPOSError } = require('../src/utils/errors');
const db = require('../src/services/db');
const FixCapabilityContract = require('../src/services/FixCapabilityContract');

const engineModule = require('@ppos/preflight-engine');
const engineInstance = engineModule.createStandardEngine();

const redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD
};

const UPLOADS_DIR = process.env.PPOS_UPLOADS_DIR || path.join(__dirname, '../temp-staging');
fs.ensureDirSync(UPLOADS_DIR);

// PRODUCTION LIMITS (Phase 5)
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB

const storage = new StorageManager(UPLOADS_DIR);
const service = new PreflightService(
    new EngineClient(engineInstance),
    new WorkerClient(redisConfig),
    storage
);

function resolveArtifactByAlias({ artifacts, artifactList, requestedKey, requiresReview, productionCertified }) {
    const candidateTypes = {
        review_pdf: ['review_pdf', 'final_fixed_pdf', 'fixed_pdf', 'normalized_pdf'],
        final_fixed_pdf: ['final_fixed_pdf', 'fixed_pdf', 'normalized_pdf', 'certified_pdf'],
        fixed_pdf: ['fixed_pdf', 'final_fixed_pdf'],
        normalized_pdf: ['normalized_pdf', 'fixed_pdf', 'final_fixed_pdf'],
        certified_pdf: ['certified_pdf'],
        fix_audit: ['fix_audit'],
        analysis_report: ['analysis_report', 'report_json'],
        report_json: ['analysis_report', 'report_json']
    };

    const candidateFilenames = {
        review_pdf: ['fixed.pdf', 'normalized.pdf'],
        final_fixed_pdf: ['fixed.pdf', 'normalized.pdf', 'certified.pdf'],
        fixed_pdf: ['fixed.pdf', 'normalized.pdf'],
        normalized_pdf: ['normalized.pdf', 'fixed.pdf'],
        certified_pdf: ['certified.pdf'],
        fix_audit: ['fix_audit.json'],
        analysis_report: ['report.json'],
        report_json: ['report.json']
    };

    let resolvedType = null;
    let resolvedFilename = null;

    const types = candidateTypes[requestedKey];
    const filenames = candidateFilenames[requestedKey];

    if (types && filenames) {
        // A. Look in artifacts object by candidate key
        if (artifacts && typeof artifacts === 'object') {
            for (const t of types) {
                if (artifacts[t]) {
                    resolvedType = t;
                    resolvedFilename = artifacts[t];
                    break;
                }
            }
        }

        // B. Look in artifactList by candidate type
        if (!resolvedFilename && artifactList && Array.isArray(artifactList)) {
            for (const t of types) {
                const found = artifactList.find(a => a.type === t);
                if (found) {
                    resolvedType = t;
                    resolvedFilename = found.name;
                    break;
                }
            }
        }

        // C & D. Look in artifactList by candidate filename
        if (!resolvedFilename && artifactList && Array.isArray(artifactList)) {
            for (const f of filenames) {
                const found = artifactList.find(a => a.name === f);
                if (found) {
                    resolvedType = found.type;
                    resolvedFilename = f;
                    break;
                }
            }
        }
    }

    // E. Exact id/name/type match as final fallback
    if (!resolvedFilename && artifactList && Array.isArray(artifactList)) {
        const found = artifactList.find(a => a.id === requestedKey || a.name === requestedKey || a.type === requestedKey);
        if (found) {
            resolvedType = found.type;
            resolvedFilename = found.name;
        }
    }

    // Specific constraints
    if (requestedKey === 'review_pdf' && requiresReview && resolvedFilename === 'certified.pdf') {
        resolvedFilename = null;
        resolvedType = null;
    }
    if (requestedKey === 'review_pdf' && productionCertified === false && resolvedFilename === 'certified.pdf') {
        resolvedFilename = null;
        resolvedType = null;
    }
    if (requestedKey === 'certified_pdf' && requiresReview && resolvedFilename === 'fixed.pdf') {
        resolvedFilename = null;
        resolvedType = null;
    }

    if (resolvedFilename) {
        return {
            requestedKey,
            resolvedKey: resolvedType || requestedKey,
            filename: resolvedFilename,
            name: resolvedFilename,
            type: resolvedType || requestedKey,
            source: 'artifacts'
        };
    }

    return null;
}

async function preflightRoutes(fastify, options) {
    /**
     * GET /api/preflight/capabilities
     */
    fastify.get('/capabilities', async (request, reply) => {
        return FixCapabilityContract.getCapabilities();
    });

    /**
     * POST /api/preflight/jobs
     * Entry point for new analysis jobs.
     */
    fastify.post('/jobs', {
        preHandler: [requireScope('preflight:write')],
        bodyLimit: MAX_FILE_SIZE
    }, async (request, reply) => {
        try {
            console.log(`[PRELIGHT][JOBS] POST /jobs - Request received`);
            const fileData = await request.file();
            if (!fileData) return reply.status(400).send({ error: 'No file' });

            const { auth } = request.context;
            if (!auth) return reply.status(401).send({ error: 'UNAUTHORIZED' });

            const result = await service.analyze(
                await fileData.toBuffer(),
                fileData.filename,
                request.context
            );
            return { ok: true, ...result };
        } catch (err) {
            console.error(`[PRELIGHT][ERROR] POST /jobs - ${err.message}`);
            if (err.isPolicyViolation) {
                return reply.status(err.code === 'DEPLOYMENT_CONSTRAINT_BLOCKED' ? 429 : 403).send({
                    error: err.code,
                    message: err.message
                });
            }
            throw err;
        }
    });

    /**
     * GET /api/preflight/jobs/policies
     * RETURNS the active preflight policies.
     */
    fastify.get('/jobs/policies', {
        preHandler: [requireScope('preflight:read')]
    }, async (request, reply) => {
        try {
            const policies = await service.getPolicies(request.context);
            return policies;
        } catch (err) {
            console.error(`[PRELIGHT][ERROR] GET /jobs/policies - ${err.message}`);
            throw err;
        }
    });

    /**
     * POST /jobs/:id/actions/fix
     */
    fastify.post('/jobs/:id/actions/fix', {
        preHandler: [requireScope('preflight:write')],
        bodyLimit: MAX_FILE_SIZE
    }, async (request, reply) => {
        try {
            const routeId = request.params?.id;
            const bodyAssetId = (!request.isMultipart() && request.body) ? request.body.asset_id : null;

            // Resolve targetId with deterministic fallback and mismatch detection
            const targetId = routeId || bodyAssetId;

            if (!targetId) {
                throw new PPOSError(ErrorCodes.BAD_REQUEST, 'Missing target job/asset identifier.', ErrorTypes.USER_ERROR);
            }

            // Phase 10: Strict canonical identity enforcement
            IdentityValidator.validate(targetId, 'AutofixTarget');

            if (routeId && bodyAssetId && routeId !== bodyAssetId) {
                throw new PPOSError(ErrorCodes.BAD_REQUEST, 'Route id and body asset_id do not match. Identity ambiguity rejected.', ErrorTypes.USER_ERROR);
            }

            const { auth } = request.context;
            if (!auth) return reply.status(401).send({ error: 'UNAUTHORIZED' });

            console.log(`[PRELIGHT][JOBS] POST /jobs/${targetId}/actions/fix - Payload received`);

            if (request.isMultipart()) {
                const parts = request.file();
                const data = await parts;
                if (!data) return reply.status(400).send({ error: 'No file' });

                const buffer = await data.toBuffer();
                const jobId = `fix_multipart_${Date.now()}`;

                // Initialize isolated storage using normalized context
                const storageContext = service._normalizeStorageContext(request.context);
                await storage.initializeJobStorage(storageContext, jobId);
                const { filePath } = await storage.saveInputFile(auth.tenantId, jobId, buffer, data.filename);

                // Extract Fix Plan from Fields
                const rawIssues = data.fields?.issues?.value ? JSON.parse(data.fields.issues.value) : null;
                const policyMode = data.fields?.policy_mode?.value || 'SAFE';

                // Derive repair type from issues when client doesn't specify explicitly
                let derivedType = data.fields?.target?.value || null;
                if (!derivedType && rawIssues) {
                    const hasBleed = rawIssues.some(i => i.fix_method === 'APPLY_BLEED');
                    const hasGeom = rawIssues.some(i => i.fix_method === 'REBUILD_TRIMBOX');
                    if (hasBleed) derivedType = 'bleed';
                    else if (hasGeom) derivedType = 'geometry';
                }
                derivedType = derivedType || 'cmyk';

                const fixPlan = {
                    type: derivedType,
                    target: derivedType,
                    profile: data.fields?.profile?.value || 'iso_coated_v3',
                    bleedMm: parseFloat(data.fields?.bleedMm?.value || '3'),
                    dpiPreferred: parseInt(data.fields?.dpiPreferred?.value || '300'),
                    forceBleed: derivedType === 'bleed' || data.fields?.forceBleed?.value === '1',
                    forceCmyk: data.fields?.forceCmyk?.value === '1',
                    flatten: data.fields?.flatten?.value === '1',
                    strictVector: data.fields?.strictVector?.value !== '0',
                    issues: rawIssues,
                    policy_mode: policyMode
                };

                // PERSIST INITIAL STATE
                await db.execute(
                    `INSERT INTO jobs (id, tenant_id, deployment_id, user_id, job_type, status, idempotency_key, result)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        jobId,
                        auth.tenantId,
                        'unknown',
                        auth.userId || 'SYSTEM',
                        'AUTOFIX',
                        'PROCESSING',
                        null,
                        JSON.stringify({
                            sourceJobId: 'multipart_upload',
                            targetJobId: jobId,
                            requested_fixes: rawIssues ? rawIssues.map(i => i.fix_method) : [],
                            fixes: [derivedType],
                            forceBleed: fixPlan.forceBleed,
                            targetProfile: fixPlan.profile,
                            policy_mode: policyMode
                        })
                    ],
                    { tenantId: auth.tenantId }
                );

                // Execute Engine
                const outputDir = storage.getJobSubfolder(auth.tenantId, jobId, 'output');
                await fs.ensureDir(outputDir);
                const result = await engineInstance.autofixPdf(filePath, fixPlan, { outputDir });

                const fixedPath = path.join(outputDir, 'fixed.pdf');
                if (result.ok && result.fixedPath) {
                    await fs.copy(result.fixedPath, fixedPath);
                }

                const resultPayload = {
                    sourceJobId: 'multipart_upload',
                    targetJobId: jobId,
                    ok: result.ok,
                    repairs: result.repairs || [],
                    fixes: [derivedType],
                    requested_fixes: rawIssues ? rawIssues.map(i => i.fix_method) : [],
                    forceBleed: fixPlan.forceBleed,
                    targetProfile: fixPlan.profile,
                    policy_mode: policyMode,
                    autofix_attempted: true,
                    outcome_category: result.ok ? 'SUCCESS' : 'ENVIRONMENT_FAILURE',
                    analysis_status: result.ok ? 'COMPLETED' : 'FAILED',
                    artifacts: result.ok ? { final_fixed_pdf: 'fixed.pdf' } : {},
                    primary_artifact_type: 'final_fixed_pdf',
                    primary_artifact_name: 'fixed.pdf'
                };

                // UPDATE DATABASE
                await db.execute(
                    "UPDATE jobs SET status = ?, result = ? WHERE id = ?",
                    [result.ok ? 'COMPLETED' : 'FAILED', JSON.stringify(resultPayload), jobId],
                    { tenantId: auth.tenantId }
                );

                if (result.ok) {
                    console.log(`[PRELIGHT][JOBS] Sync multipart fix successful for job: ${jobId}`);
                    const fileBuffer = await fs.readFile(fixedPath);
                    return reply.type('application/pdf').send(fileBuffer);
                }
                console.error(`[PRELIGHT][ERROR] Sync multipart fix failed: ${result.error}`);
                return reply.status(500).send({ error: 'AUTOFIX_EXECUTION_FAILED', message: result.error });
            } else {
                // Async enqueue via JSON body
                const body = request.body || {};
                const policy = body.policy || body.policyId;
                const policyMode = body.policy_mode || 'SAFE';
                
                const fixes = Array.isArray(body.fixes) ? body.fixes : (typeof body.fixes === 'string' ? [body.fixes] : undefined);
                const requested_fixes = Array.isArray(body.requested_fixes) ? body.requested_fixes : (typeof body.requested_fixes === 'string' ? [body.requested_fixes] : fixes);

                // Validate strategies are strings and log unsupported downstream
                if (fixes) {
                    fixes.forEach(strategy => {
                        if (typeof strategy !== 'string') {
                            console.warn(`[SERVICE][FIX-ACTION][VALIDATION] Non-string repair strategy received:`, strategy);
                        }
                    });
                }

                const options = {
                    ...body,
                    ...(body.options || {}),
                    ...(fixes ? { fixes } : {}),
                    ...(requested_fixes ? { requested_fixes } : {}),
                    ...(body.forceBleed !== undefined ? { forceBleed: body.forceBleed } : {}),
                    ...(body.targetProfile ? { targetProfile: body.targetProfile } : {}),
                    ...(body.magicFixProfile ? { magicFixProfile: body.magicFixProfile } : {}),
                    policy_mode: policyMode
                };
                delete options.policy;
                delete options.policyId;
                delete options.options;

                const result = await service.autofix(
                    targetId,
                    policy,
                    { ...request.context, request },
                    options
                );
                return { ok: true, ...result };
            }
        } catch (err) {
            console.error(`[PRELIGHT][ERROR] POST /jobs/:targetId/actions/fix - ${err.message}`);
            if (err.isPolicyViolation) {
                return reply.status(err.code === 'DEPLOYMENT_CONSTRAINT_BLOCKED' ? 429 : 403).send({
                    error: err.code,
                    message: err.message
                });
            }
            throw err;
        }
    });


    /**
     * GET /api/preflight/jobs
     * Lists preflight jobs with pagination, filtering, and tenant isolation.
     */
    fastify.get('/jobs', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        try {
            const result = await service.listJobs(request.context, request.query);
            return result;
        } catch (err) {
            console.error(`[PRELIGHT][ERROR] GET /jobs - ${err.message}`);
            throw err;
        }
    });

    /**
     * GET /api/preflight/jobs/:id
     */
    fastify.get('/jobs/:id', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        const { id: jobId } = request.params;

        // Phase 10: Strict canonical identity enforcement
        IdentityValidator.validate(jobId, 'JobFetch');

        try {
            const jobStatus = await service.getJobStatus(jobId, request.context);

            if (!jobStatus) {
                return reply.status(404).send({
                    ok: false,
                    error: 'JOB_NOT_FOUND',
                    message: 'Job not found or access denied.'
                });
            }

            // Phase 42B: Attach artifacts and artifact_summary
            const artifacts = await service.getJobArtifacts(jobId, request.context.auth.tenantId);
            const artifact_count = artifacts.length;
            const downloadable_artifact_count = artifacts.filter(a => a.downloadable).length;
            const zero_byte_artifact_count = artifacts.filter(a => !a.downloadable).length;
            const has_fixed_pdf_bytes = artifacts.some(a => ['fixed_pdf', 'final_fixed_pdf'].includes(a.type) && a.downloadable);
            
            let physical_artifacts_ready = false;
            let artifact_error = undefined;

            if (artifact_count > 0 && downloadable_artifact_count > 0) {
                physical_artifacts_ready = true;
            } else if (jobStatus.type === 'AUTOFIX' && (jobStatus.status === 'COMPLETED' || jobStatus.status === 'AUTOFIX_REVIEW_REQUIRED' || jobStatus.status === 'COMPLETED_WITH_REVIEW')) {
                if (!has_fixed_pdf_bytes) {
                    physical_artifacts_ready = false;
                    artifact_error = "NO_FIXED_PDF_BYTES_PRODUCED";
                }
            }

            const response = {
                ok: true,
                job: {
                    ...jobStatus,
                    artifacts: artifacts,
                    artifact_summary: {
                        artifact_count,
                        downloadable_artifact_count,
                        zero_byte_artifact_count,
                        physical_artifacts_ready,
                        certified_pdf_available: artifacts.some(a => a.type === 'certified_pdf' && a.downloadable),
                        fixed_pdf_available: artifacts.some(a => (a.type === 'fixed_pdf' || a.type === 'final_fixed_pdf') && a.downloadable),
                        review_pdf_available: artifacts.some(a => a.type === 'review_pdf' && a.downloadable),
                        report_available: artifacts.some(a => ['analysis_report', 'report_json'].includes(a.type) && a.downloadable),
                        fix_audit_available: artifacts.some(a => a.type === 'fix_audit' && a.downloadable),
                        delta_report_available: artifacts.some(a => a.type === 'delta_report' && a.downloadable),
                        production_ready_artifact_available: artifacts.some(a => a.artifact_role === 'PRODUCTION_READY' && a.downloadable),
                        review_required_artifact_available: artifacts.some(a => a.artifact_role === 'REVIEW_REQUIRED' && a.downloadable),
                        ...(artifact_error ? { artifact_error } : {})
                    }
                }
            };

            return response;
        } catch (err) {
            console.error(`[PRELIGHT][ERROR] GET /jobs/:id - ${err.message}`);
            throw err;
        }
    });

    /**
     * GET /api/preflight/jobs/:id/artifacts
     */
    fastify.get('/jobs/:id/artifacts', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        const { id: jobId } = request.params;

        IdentityValidator.validate(jobId, 'ArtifactList');

        try {
            const artifacts = await service.getJobArtifacts(jobId, request.context.auth.tenantId);
            const jobStatus = await service.getJobStatus(jobId, request.context);

            const artifact_count = artifacts.length;
            const downloadable_artifact_count = artifacts.filter(a => a.downloadable).length;
            const zero_byte_artifact_count = artifacts.filter(a => !a.downloadable).length;
            const has_fixed_pdf_bytes = artifacts.some(a => ['fixed_pdf', 'final_fixed_pdf'].includes(a.type) && a.downloadable);
            
            let physical_artifacts_ready = false;
            let artifact_error = undefined;
            let message = undefined;

            if (artifact_count > 0 && downloadable_artifact_count > 0) {
                physical_artifacts_ready = true;
            } else if (jobStatus && jobStatus.type === 'AUTOFIX' && (jobStatus.status === 'COMPLETED' || jobStatus.status === 'AUTOFIX_REVIEW_REQUIRED' || jobStatus.status === 'COMPLETED_WITH_REVIEW')) {
                if (!has_fixed_pdf_bytes) {
                    physical_artifacts_ready = false;
                    artifact_error = "NO_FIXED_PDF_BYTES_PRODUCED";
                    message = "No fixed PDF bytes were produced for this job.";
                }
            }

            return {
                ok: true,
                job_id: jobId,
                artifacts: artifacts,
                artifact_summary: {
                    artifact_count,
                    downloadable_artifact_count,
                    zero_byte_artifact_count,
                    physical_artifacts_ready,
                    certified_pdf_available: artifacts.some(a => a.type === 'certified_pdf' && a.downloadable),
                    fixed_pdf_available: artifacts.some(a => (a.type === 'fixed_pdf' || a.type === 'final_fixed_pdf') && a.downloadable),
                    review_pdf_available: artifacts.some(a => a.type === 'review_pdf' && a.downloadable),
                    report_available: artifacts.some(a => ['analysis_report', 'report_json'].includes(a.type) && a.downloadable),
                    fix_audit_available: artifacts.some(a => a.type === 'fix_audit' && a.downloadable),
                    delta_report_available: artifacts.some(a => a.type === 'delta_report' && a.downloadable),
                    production_ready_artifact_available: artifacts.some(a => a.artifact_role === 'PRODUCTION_READY' && a.downloadable),
                    review_required_artifact_available: artifacts.some(a => a.artifact_role === 'REVIEW_REQUIRED' && a.downloadable),
                    ...(artifact_error ? { artifact_error } : {})
                },
                downloadable_artifact_count,
                zero_byte_artifact_count,
                physical_artifacts_ready,
                ...(artifact_error ? { artifact_error } : {}),
                ...(message ? { message } : {})
            };
        } catch (err) {
            console.error(`[PRELIGHT][ERROR] GET /jobs/:id/artifacts - ${err.message}`);
            throw err;
        }
    });

    /**
     * GET /api/preflight/jobs/:id/artifacts/:artifactId
     * ALIGNED WITH APP/BFF CONTRACT
     */
    fastify.get('/jobs/:id/artifacts/:artifactId', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        const { id: jobId, artifactId } = request.params;

        // Phase 10: Identity validation
        IdentityValidator.validate(jobId, 'ArtifactJob');
        const { auth } = request.context;

        try {
            // Get all known artifacts for the job
            const artifacts = await service.getJobArtifacts(jobId, auth.tenantId);
            const jobStatus = await service.getJobStatus(jobId, request.context);

            const requiresReview = jobStatus?.result?.requires_human_review === true || jobStatus?.result?.requiresHumanReview === true || jobStatus?.result?.summary?.after?.requires_human_review === true || jobStatus?.status === 'COMPLETED_WITH_REVIEW' || jobStatus?.status === 'AUTOFIX_PARTIAL';
            const productionCertified = jobStatus?.result?.production_certified !== false && jobStatus?.result?.productionCertified !== false && jobStatus?.result?.summary?.after?.production_certified !== false;
            
            const resolvedArtifact = resolveArtifactByAlias({
                artifacts: jobStatus?.result?.artifacts || {},
                artifactList: artifacts,
                requestedKey: artifactId,
                requiresReview,
                productionCertified
            });

            console.log(`[SERVICE][ARTIFACT-RESOLVE]`, {
                jobId,
                tenantId: auth.tenantId,
                requestedKey: artifactId,
                resolvedKey: resolvedArtifact?.resolvedKey || null,
                filename: resolvedArtifact?.filename || null,
                source: resolvedArtifact?.source || null,
                requiresReview,
                productionCertified
            });

            const targetFileName = resolvedArtifact ? resolvedArtifact.filename : artifactId;

            if (!resolvedArtifact && !artifacts.some(a => a.id === artifactId || a.name === artifactId || a.type === artifactId)) {
                return reply.status(404).send({
                    ok: false,
                    error: 'ARTIFACT_NOT_FOUND'
                });
            }

            // Priority search across standard isolation subfolders
            const subfolders = ['output', 'reports', 'input'];
            let finalPath = null;

            for (const sub of subfolders) {
                const potential = path.join(storage.getJobSubfolder(auth.tenantId, jobId, sub), targetFileName);
                if (await fs.pathExists(potential)) {
                    finalPath = potential;
                    break;
                }
            }

            if (!finalPath) {
                return reply.status(409).send({
                    ok: false,
                    error: 'ARTIFACT_STORAGE_MISSING',
                    reason: 'PHYSICAL_FILE_NOT_FOUND'
                });
            }
            
            // Phase 10: isolation breach verification
            storage.verifyPathIsolation(auth.tenantId, finalPath);

            const stats = await fs.stat(finalPath);
            if (stats.size === 0) {
                return reply.status(409).send({
                    ok: false,
                    error: 'ARTIFACT_NOT_DOWNLOADABLE',
                    reason: 'ZERO_BYTE_ARTIFACT_OR_MISSING_STORAGE_REF'
                });
            }

            const ext = path.extname(targetFileName).toLowerCase();
            const mimeTypes = {
                '.pdf': 'application/pdf',
                '.json': 'application/json',
                '.xml': 'application/xml',
                '.txt': 'text/plain',
                '.png': 'image/png',
                '.jpg': 'image/jpeg'
            };

            const contentType = mimeTypes[ext] || 'application/octet-stream';
            reply.type(contentType);

            // Enforce attachment for binaries or PDFs to ensure browser safety
            if (contentType === 'application/octet-stream' || ext === '.pdf') {
                reply.header('Content-Disposition', `attachment; filename="${targetFileName}"`);
            } else if (ext === '.json') {
                reply.header('Content-Disposition', `attachment; filename="${targetFileName}"`);
            }

            return fs.createReadStream(finalPath);

        } catch (err) {
            console.error(`[PRELIGHT][ERROR] GET /artifacts - ${err.message}`);
            return reply.status(500).send({ error: 'INTERNAL_ERROR', message: err.message });
        }
    });

    /**
     * POST /api/preflight/preview/pages
     * Generates previews for the given job.
     */
    fastify.post('/preview/pages', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        const { jobId } = request.body || {};
        if (!jobId) return reply.status(400).send({ error: 'jobId is required' });

        // Phase 10: Identity validation
        IdentityValidator.validate(jobId, 'PreviewJob');

        const result = await service.generatePreviews(jobId, request.context);
        return result;
    });

    /**
     * GET /api/preflight/preview/:jobId/:page
     * Serves a rendered page image.
     */
    fastify.get('/preview/:jobId/:page', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        const { auth } = request.context;
        const { jobId, page } = request.params;

        // Phase 10: Identity validation
        IdentityValidator.validate(jobId, 'PreviewPage');

        const previewPath = path.join(storage.getJobSubfolder(auth.tenantId, jobId, 'previews'), `p${page}.png`);

        if (!await fs.pathExists(previewPath)) {
            return reply.status(404).send({ error: 'PREVIEW_NOT_FOUND' });
        }

        const buffer = await fs.readFile(previewPath);
        return reply.type('image/png').send(buffer);
    });


    /**
     * GET /api/preflight/batches
     * Compatibility endpoint for Control Plane batch polling.
     * Batch orchestration is optional in this service build; return a controlled
     * empty registry instead of Fastify route-not-found so clients can degrade cleanly.
     */
    fastify.get('/batches', { preHandler: [requireScope('preflight:read')] }, async (request, reply) => {
        return {
            ok: true,
            batches: [],
            total: 0,
            status: 'BATCH_REGISTRY_EMPTY',
            message: 'Batch registry is available, but no batches are currently registered.'
        };
    });

    /**
     * POST /api/preflight/batches
     * Controlled compatibility endpoint. Full multi-file batch creation may be
     * implemented by a dedicated orchestration module; until then, fail with a
     * precise 501 rather than an ambiguous 404.
     */
    fastify.post('/batches', { preHandler: [requireScope('preflight:write')] }, async (request, reply) => {
        return reply.status(501).send({
            ok: false,
            error: 'BATCH_CREATE_NOT_IMPLEMENTED',
            message: 'Batch creation is not enabled in this preflight-service build.'
        });
    });

    /**
     * GET /api/preflight/batches/:batchId
     * Controlled compatibility endpoint for batch details.
     */
    fastify.get('/batches/:batchId', { preHandler: [requireScope('preflight:read')] }, async (request, reply) => {
        return reply.status(404).send({
            ok: false,
            error: 'BATCH_NOT_FOUND',
            batchId: request.params.batchId,
            message: 'Batch not found or batch registry is empty.'
        });
    });

    /**
     * GET /api/preflight/batches/:batchId/jobs
     * Controlled compatibility endpoint for batch job listing.
     */
    fastify.get('/batches/:batchId/jobs', { preHandler: [requireScope('preflight:read')] }, async (request, reply) => {
        return {
            ok: true,
            batchId: request.params.batchId,
            jobs: [],
            total: 0,
            status: 'BATCH_REGISTRY_EMPTY'
        };
    });

    /**
     * LEGACY ENDPOINTS (Isolated/Deprecated)
     */
    fastify.post('/analyze', { preHandler: [requireScope('preflight:write')] }, async (request, reply) => {
        console.warn(`[PRELIGHT][DEPRECATED] POST /analyze used. Redirecting to /jobs.`);
        return reply.status(308).header('Location', '/api/preflight/jobs').send({
            error: 'DEPRECATED', message: 'Use /api/preflight/jobs instead.'
        });
    });

    fastify.post('/autofix', { preHandler: [requireScope('preflight:write')] }, async (request, reply) => {
        console.warn(`[PRELIGHT][DEPRECATED] POST /autofix used. Redirecting to /jobs/:id/actions/fix.`);
        return reply.status(308).header('Location', '/api/preflight/jobs/:id/actions/fix').send({
            error: 'DEPRECATED', message: 'Use /api/preflight/jobs/:id/actions/fix instead.'
        });
    });

}

module.exports = preflightRoutes;
