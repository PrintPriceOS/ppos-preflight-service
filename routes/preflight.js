/**
 * Preflight Routes
 */
const PreflightService = require('../services/PreflightService');
const EngineClient = require('../clients/EngineClient');
const WorkerClient = require('../clients/WorkerClient');
const FileStorage = require('../utils/fileStorage');
const path = require('path');
const fs = require('fs-extra');

const engineModule = require('@ppos/preflight-engine');
const engineInstance = engineModule.createStandardEngine();

const redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD
};

const UPLOADS_DIR = process.env.PPOS_UPLOADS_DIR || path.join(__dirname, '../temp-staging');
fs.ensureDirSync(UPLOADS_DIR);

const storage = new FileStorage(UPLOADS_DIR);
const service = new PreflightService(
    new EngineClient(engineInstance),
    new WorkerClient(redisConfig),
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
     * Handles both sync file uploads (for small tasks) and async enqueuing (for large jobs).
     */
    fastify.post('/autofix', async (request, reply) => {
        if (request.isMultipart()) {
            const parts = request.file();
            const data = await parts;
            if (!data) return reply.status(400).send({ error: 'No file' });

            const buffer = await data.toBuffer();
            const { filePath, id: assetId } = await storage.save(buffer, data.filename);
            
            // Extract policy from fields if present
            const policyStr = data.fields?.policy?.value || '{"type":"generic"}';
            const policy = JSON.parse(policyStr);
            const tenantId = data.fields?.tenant_id?.value;

            // Maintain synchronous behavior for direct uploads to avoid breaking product compatibility
            const fixPlan = policy;
            const result = await engineInstance.autofixPdf(filePath, fixPlan);
            
            if (result.success) {
                const fileBuffer = await fs.readFile(result.outputPath);
                return reply.type('application/pdf').send(fileBuffer);
            }
            return reply.status(500).send({ error: 'Autofix failed' });
        } else {
            // Async enqueue via JSON body
            const { asset_id, policy, tenant_id } = request.body || {};
            const result = await service.autofix(asset_id, policy, tenant_id, request.body);
            // Return result directly (flattened) for product compatibility
            return { ok: true, ...result };
        }
    });

    /**
     * GET /preflight/status/:jobId
     */
    fastify.get('/status/:jobId', async (request, reply) => {
        return { jobId: request.params.jobId, status: 'PROCESSING' };
    });
}

module.exports = preflightRoutes;
