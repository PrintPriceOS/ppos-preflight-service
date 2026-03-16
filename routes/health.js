/**
 * Health Route
 */
const { execSync } = require('child_process');

async function checkGs() {
    try {
        execSync('gs --version', { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

async function healthRoute(fastify, options) {
    fastify.get('/', async () => {
        const gsReady = await checkGs();
        return { 
            status: gsReady ? 'UP' : 'DEGRADED', 
            service: 'ppos-preflight-service',
            version: '1.9.2',
            env: process.env.NODE_ENV || 'development',
            timestamp: new Date().toISOString(),
            metrics: {
                memory: process.memoryUsage(),
                uptime: process.uptime()
            },
            dependencies: {
                engine: 'LINKED',
                ghostscript: gsReady ? 'READY' : 'MISSING',
                storage: 'READY'
            }
        };
    });
}

module.exports = healthRoute;
