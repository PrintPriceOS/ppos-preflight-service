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
        return { ok: true, token, refreshToken: 'mock-refresh-token-' + Date.now() };
    });

    /**
     * GET /api/auth/me
     * Returns current user identity from JWT.
     */
    fastify.get('/me', async (request, reply) => {
        const { auth } = request.context;
        if (!auth) return reply.status(401).send({ error: 'UNAUTHORIZED' });
        return { ok: true, user: auth };
    });

    /**
     * POST /api/auth/refresh
     * Mocks a token refresh cycle.
     */
    fastify.post('/refresh', async (request, reply) => {
        const { refreshToken } = request.body || {};
        if (!refreshToken) return reply.status(400).send({ error: 'REFRESH_TOKEN_REQUIRED' });
        
        // MOCK Refresh: Always succeed if token provided
        const newToken = generateToken({
            userId: 'refreshed-user',
            tenantId: 'tenant-a',
            role: 'ADMIN',
            scopes: ['*']
        });

        return { ok: true, token: newToken };
    });
};
