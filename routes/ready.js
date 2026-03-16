/**
 * Route: /ready
 * 
 * Validates external dependencies and system readiness.
 */
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs-extra');

module.exports = async function (fastify, opts) {
    fastify.get('/', async (request, reply) => {
        const checks = {
            engine: true,
            ghostscript: false,
            temp_dir: false
        };

        try {
            // GS Check
            try {
                execSync('gs --version', { stdio: 'ignore' });
                checks.ghostscript = true;
            } catch (e) {
                checks.ghostscript = false;
            }

            // Temp Dir Check
            const tempDir = process.env.PPOS_TEMP_DIR || os.tmpdir();
            await fs.ensureDir(tempDir);
            const testFile = `${tempDir}/ready_test_${Date.now()}`;
            await fs.writeFile(testFile, 'test');
            await fs.remove(testFile);
            checks.temp_dir = true;

            const ready = Object.values(checks).every(v => v === true);

            if (!ready) {
                reply.status(503);
            }

            return {
                ready,
                checks
            };
        } catch (err) {
            reply.status(503);
            return {
                ready: false,
                error: err.message,
                checks
            };
        }
    });
};
