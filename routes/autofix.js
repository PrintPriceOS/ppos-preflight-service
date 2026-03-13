/**
 * Route: /autofix
 * 
 * Invokes the Shared AutofixCommand.
 * Classification: RUNTIME_HTTP_ADAPTER
 */
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const AutofixCommand = require('@ppos/preflight-engine/src/runtime/commands/autofixCommand');

module.exports = async function (fastify, opts) {
    fastify.post('/', async (request, reply) => {
        const data = await request.file();
        if (!data) {
            reply.status(400).send({ error: 'INPUT_ERROR', message: 'No file uploaded' });
            return;
        }

        const inputPath = path.join(os.tmpdir(), `in_${Date.now()}_${data.filename}`);
        const outputPath = path.join(os.tmpdir(), `out_${Date.now()}_${data.filename}`);

        try {
            await fs.writeFile(inputPath, await data.toBuffer());

            const config = { minBleedMm: 3.0 };
            const fixHint = request.query.fix || null;

            const result = await AutofixCommand.run(inputPath, outputPath, config, fixHint);

            if (result.success) {
                const buffer = await fs.readFile(outputPath);
                reply
                    .header('Content-Type', 'application/pdf')
                    .header('X-PPOS-RESULT-STATUS', 'SUCCESS')
                    .header('X-PPOS-FINDINGS', JSON.stringify(result.findings))
                    .send(buffer);
            } else {
                reply
                    .header('X-PPOS-RESULT-STATUS', 'NO_ACTION_TAKEN')
                    .send({ ok: true, status: 'NO_ACTION_TAKEN', reason: 'ALREADY_COMPLIANT' });
            }
        } catch (err) {
            fastify.log.error(`[HTTP][AUTOFIX] Error: ${err.message}`);
            throw err;
        } finally {
            await fs.remove(inputPath);
            await fs.remove(outputPath);
        }
    });
};
