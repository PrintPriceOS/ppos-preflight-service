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

const storage = new StorageManager(UPLOADS_DIR);
const service = new PreflightService(
    new EngineClient(engineInstance),
    new WorkerClient(redisConfig),
    storage
);

async function preflightRoutes(fastify, options) {
    /**
     * POST /api/preflight/analyze
     */
    fastify.post('/analyze', { preHandler: [requireScope('preflight:write')] }, async (request, reply) => {
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
     * POST /api/preflight/autofix
     * Handles both sync file uploads and async enqueuing.
     */
    fastify.post('/autofix', { preHandler: [requireScope('preflight:write')] }, async (request, reply) => {
        try {
            const { auth, deployment } = request.context;
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
                
                const policyStr = data.fields?.policy?.value || '{"type":"generic"}';
                const policy = JSON.parse(policyStr);

                const result = await engineInstance.autofixPdf(filePath, policy);
                
                if (result.success) {
                    const fileBuffer = await fs.readFile(result.outputPath);
                    return reply.type('application/pdf').send(fileBuffer);
                }
                return reply.status(500).send({ error: 'Autofix failed' });
            } else {
                // Async enqueue via JSON body
                const { asset_id, policy } = request.body || {};
                const result = await service.autofix(asset_id, policy, request.context, request.body);
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
     * GET /api/preflight/status/:jobId
     * Ownership-governed status check.
     */
    fastify.get('/status/:jobId', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        const { auth } = request.context;
        const { jobId } = request.params;

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
}

module.exports = preflightRoutes;
