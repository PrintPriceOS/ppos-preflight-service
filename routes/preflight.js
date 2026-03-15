/**
 * Preflight Routes
 */
const PreflightService = require('../services/PreflightService');
const EngineClient = require('../clients/EngineClient');
const WorkerClient = require('../clients/WorkerClient');
const FileStorage = require('../utils/fileStorage');
const path = require('path');

const storage = new FileStorage(path.join(__dirname, '../temp-staging'));
const service = new PreflightService(
    new EngineClient(),
    new WorkerClient(),
    storage
);

async function preflightRoutes(fastify, options) {
    /**
     * POST /preflight/analyze
     */
    fastify.post('/analyze', async (request, reply) => {
        const data = await request.file();
        if (!data) return reply.status(400).send({ error: 'No file' });

        const result = await service.analyze(
            await data.toBuffer(), 
            data.filename, 
            request.body?.tenant_id
        );
        return { ok: true, data: result };
    });

    /**
     * POST /preflight/autofix
     */
    fastify.post('/autofix', async (request, reply) => {
        const { asset_id, policy, tenant_id } = request.body || {};
        const result = await service.autofix(asset_id, policy, tenant_id);
        return { ok: true, data: result };
    });

    /**
     * GET /preflight/status/:jobId
     */
    fastify.get('/status/:jobId', async (request, reply) => {
        return { jobId: request.params.jobId, status: 'PROCESSING' };
    });
}

module.exports = preflightRoutes;
