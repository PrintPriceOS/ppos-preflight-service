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
            const fileData = await request.file();
            if (!fileData) return reply.status(400).send({ error: 'No file' });

            const { auth } = request.context;
            if (!auth) return reply.status(401).send({ error: 'UNAUTHORIZED' });

            const result = await service.analyze(
                await fileData.toBuffer(), 
                fileData.filename, 
                request.context
            );
            return { ok: true, data: result };
        } catch (err) {
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
     * POST /analyze (Alias for /jobs)
     */
    fastify.post('/analyze', { 
        preHandler: [requireScope('preflight:write')],
        bodyLimit: MAX_FILE_SIZE
    }, async (request, reply) => {
        try {
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
     * POST /jobs/:id/actions/fix
     */
    fastify.post('/jobs/:id/actions/fix', { 
        preHandler: [requireScope('preflight:write')],
        bodyLimit: MAX_FILE_SIZE
    }, async (request, reply) => {
        try {
            const { id } = request.params;
            const { auth } = request.context;
            if (!auth) return reply.status(401).send({ error: 'UNAUTHORIZED' });

            if (request.isMultipart()) {
                const parts = request.file();
                const data = await parts;
                if (!data) return reply.status(400).send({ error: 'No file' });

                const buffer = await data.toBuffer();
                const jobId = `sync_fix_${Date.now()}`;
                
                // Initialize isolated storage
                await storage.initializeJobStorage(request.context, jobId);
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
                    const fileBuffer = await fs.readFile(result.outputPath);
                    return reply.type('application/pdf').send(fileBuffer);
                }
                return reply.status(500).send({ error: 'AUTOFIX_EXECUTION_FAILED', message: result.error });
            } else {
                // Async enqueue via JSON body
                const { asset_id, policy, ...rest } = request.body || {};
                const fixPlan = { ...(policy || {}), ...rest };
                const result = await service.autofix(asset_id, fixPlan, request.context, request.body);
                return { ok: true, ...result };
            }
        } catch (err) {
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
     * POST /autofix
     */
    fastify.post('/autofix', { 
        preHandler: [requireScope('preflight:write')],
        bodyLimit: MAX_FILE_SIZE
    }, async (request, reply) => {
        try {
            const { auth } = request.context;
            if (!auth) return reply.status(401).send({ error: 'UNAUTHORIZED' });

            const { asset_id, policy, ...rest } = request.body || {};
            const fixPlan = { ...(policy || {}), ...rest };
            const result = await service.autofix(asset_id, fixPlan, request.context, request.body);
            return { ok: true, ...result };
        } catch (err) {
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
        const { auth } = request.context;
        const { id: jobId } = request.params;

        const jobPath = storage.getJobPath(auth.tenantId, jobId);
        const exists = await fs.pathExists(jobPath);

        if (!exists) {
            return reply.status(404).send({ error: 'NOT_FOUND', message: 'Job not found or access denied.' });
        }

        return { 
            jobId, 
            status: 'PROCESSING', 
            tenantId: auth.tenantId,
            deploymentId: request.context.deployment.deploymentId
        };
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
}

module.exports = preflightRoutes;
