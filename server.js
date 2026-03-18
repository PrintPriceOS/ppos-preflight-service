/**
 * PrintPrice OS — Preflight Service (v1.9.0)
 * 
 * Orchestration layer for PDF analysis and fixes.
 */
require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const path = require('path');
const fs = require('fs-extra');

// Plugins
fastify.register(require('@fastify/multipart'), {
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});
fastify.register(require('@fastify/cors'));
fastify.register(require('@fastify/helmet'));

// Security: Identity Foundation (Contract-Aware Context)
const buildRequestContext = require('./src/auth/buildRequestContext');

// Add hook for all /api/* routes
fastify.addHook('onRequest', async (request, reply) => {
    // Only apply to /api/* routes, excluding health and dev token
    const isApi = request.url.startsWith('/api/');
    const isHealth = request.url.startsWith('/health');
    const isAuthToken = request.url === '/api/auth/token';

    if (isApi && !isAuthToken) {
        await buildRequestContext(request, reply);
    }
});

// Ensure uploads dir
const UPLOADS_DIR = process.env.PPOS_UPLOADS_DIR || path.join(__dirname, 'temp-staging');
fs.ensureDirSync(UPLOADS_DIR);

// Routes
fastify.register(require('./routes/preflight'), { prefix: '/api/preflight' });
fastify.register(require('./routes/auth'), { prefix: '/api/auth' });
fastify.register(require('./routes/admin'), { prefix: '/api/admin' });
fastify.register(require('./routes/me'), { prefix: '/api/me' });
fastify.register(require('./routes/health'), { prefix: '/health' });

const start = async () => {
    try {
        const PORT = process.env.PPOS_SERVICE_PORT || 8001;
        await fastify.listen({ port: parseInt(PORT), host: '0.0.0.0' });
        console.log(`[SERVICE] Preflight active on port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
