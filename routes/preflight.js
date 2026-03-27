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
const { ErrorCodes, ErrorTypes, PPOSError } = require('../src/utils/errors');

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

async function preflightRoutes(fastify, options) {
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
                const jobId = `sync_fix_${Date.now()}`;

                // Initialize isolated storage using normalized context
                const storageContext = service._normalizeStorageContext(request.context);
                await storage.initializeJobStorage(storageContext, jobId);
                const { filePath } = await storage.saveInputFile(auth.tenantId, jobId, buffer, data.filename);

                // Extract Fix Plan from Fields
                const fixPlan = {
                    target: data.fields?.target?.value || 'cmyk',
                    profile: data.fields?.profile?.value || 'iso_coated_v3',
                    bleedMm: parseFloat(data.fields?.bleedMm?.value || '3'),
                    dpiPreferred: parseInt(data.fields?.dpiPreferred?.value || '300'),
                    forceBleed: data.fields?.forceBleed?.value === '1',
                    forceCmyk: data.fields?.forceCmyk?.value === '1',
                    flatten: data.fields?.flatten?.value === '1',
                    strictVector: data.fields?.strictVector?.value !== '0',
                    issues: data.fields?.issues?.value ? JSON.parse(data.fields.issues.value) : null
                };

                // Execute Engine
                const result = await engineInstance.autofixPdf(filePath, fixPlan);

                if (result.success) {
                    console.log(`[PRELIGHT][JOBS] Sync fix successful for job: ${jobId}`);
                    const fileBuffer = await fs.readFile(result.outputPath);
                    return reply.type('application/pdf').send(fileBuffer);
                }
                console.error(`[PRELIGHT][ERROR] Sync fix failed: ${result.error}`);
                return reply.status(500).send({ error: 'AUTOFIX_EXECUTION_FAILED', message: result.error });
            } else {
                // Async enqueue via JSON body
                const { policy, ...rest } = request.body || {};
                const options = rest || {};
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
     * GET /api/preflight/jobs/:id
     */
    fastify.get('/jobs/:id', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        const { id: jobId } = request.params;

        try {
            const jobStatus = await service.getJobStatus(jobId, request.context);

            if (!jobStatus) {
                return reply.status(404).send({
                    error: 'NOT_FOUND',
                    message: 'Job not found or access denied.'
                });
            }

            return jobStatus;
        } catch (err) {
            console.error(`[PRELIGHT][ERROR] GET /jobs/:id - ${err.message}`);
            throw err;
        }
    });

    /**
     * POST /api/preflight/preview/pages
     * Generates previews for the given job.
     */
    fastify.post('/preview/pages', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        const { jobId } = request.body || {};
        if (!jobId) return reply.status(400).send({ error: 'jobId is required' });

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

        const previewPath = path.join(storage.getJobSubfolder(auth.tenantId, jobId, 'previews'), `p${page}.png`);

        if (!await fs.pathExists(previewPath)) {
            return reply.status(404).send({ error: 'PREVIEW_NOT_FOUND' });
        }

        const buffer = await fs.readFile(previewPath);
        return reply.type('image/png').send(buffer);
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
