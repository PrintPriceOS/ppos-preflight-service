const { generateToken } = require('../src/auth/generateToken');

module.exports = async function (fastify, opts) {
    /**
     * POST /api/auth/token
     * Only for development and testing.
     */
    fastify.post('/token', async (request, reply) => {
        const isProd = process.env.NODE_ENV === 'production';
        if (isProd) {
             return reply.status(403).send({ error: 'FORBIDDEN', message: 'Not available in production' });
        }

        const { userId, tenantId, role, scopes } = request.body;
        
        const payload = {
            userId: userId || 'test-user-1',
            tenantId: tenantId || 'tenant-a',
            role: role || 'ADMIN',
            scopes: scopes || ['preflight:analyze']
        };

        const token = generateToken(payload);
        return { ok: true, token };
    });
};
