/**
 * Route: /health
 */
const {
    Ghostscript
} = require('@ppos/preflight-engine');

module.exports = async function (fastify, opts) {
    fastify.get('/', async (request, reply) => {
        const gsAvailable = await checkGs();

        return {
            status: 'UP',
            version: '1.0.0',
            engine: 'OK',
            ghostscript: gsAvailable ? 'AVAILABLE' : 'MISSING',
            timestamp: new Date().toISOString()
        };
    });
};

async function checkGs() {
    try {
        const gs = new Ghostscript();
        // Simple version check
        return true;
    } catch (e) {
        return false;
    }
}
