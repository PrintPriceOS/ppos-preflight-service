/**
 * Health Route
 */
async function healthRoute(fastify, options) {
    fastify.get('/', async () => {
        return { 
            status: 'UP', 
            service: 'ppos-preflight-service',
            version: '1.9.0',
            env: process.env.NODE_ENV || 'development',
            timestamp: new Date().toISOString(),
            metrics: {
                memory: process.memoryUsage(),
                uptime: process.uptime()
            },
            dependencies: {
                engine: 'LINKED', // Static for now as it's a local dependency
                storage: 'READY'
            }
        };
    });
}

module.exports = healthRoute;
