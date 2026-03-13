/**
 * Route: /analyze
 * 
 * Invokes the Shared AnalyzeCommand.
 */
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const AnalyzeCommand = require('@ppos/preflight-engine/src/runtime/commands/analyzeCommand');

module.exports = async function (fastify, opts) {
    fastify.post('/', async (request, reply) => {
        const data = await request.file();
        if (!data) {
            reply.status(400).send({ error: 'INPUT_ERROR', message: 'No file uploaded' });
            return;
        }

        const tempId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const tempPath = path.join(os.tmpdir(), `${tempId}_${data.filename}`);

        try {
            await fs.writeFile(tempPath, await data.toBuffer());

            // Industrial config resolution (defaults)
            const config = {
                minBleedMm: 3.0,
                safeAreaMm: 5.0
            };

            const result = await AnalyzeCommand.run(tempPath, config);

            return {
                ok: true,
                data: result
            };
        } catch (err) {
            fastify.log.error(`[HTTP][ANALYZE] Error: ${err.message}`);
            throw err;
        } finally {
            if (await fs.pathExists(tempPath)) {
                await fs.remove(tempPath);
            }
        }
    });
};
