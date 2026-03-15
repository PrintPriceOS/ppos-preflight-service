/**
 * Health Route
 */
async function healthRoute(fastify, options) {
    fastify.get('/', async () => {
        return { 
            status: 'UP', 
            service: 'ppos-preflight-service',
            timestamp: new Date().toISOString()
        };
    });
}

module.exports = healthRoute;
