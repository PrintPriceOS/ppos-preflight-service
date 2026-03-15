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

// Ensure uploads dir
const UPLOADS_DIR = process.env.PPOS_UPLOADS_DIR || path.join(__dirname, 'temp-staging');
fs.ensureDirSync(UPLOADS_DIR);

// Routes
fastify.register(require('./routes/preflight'), { prefix: '/preflight' });
fastify.register(require('./routes/health'), { prefix: '/health' });

const start = async () => {
    try {
        const PORT = process.env.PPOS_SERVICE_PORT || 3000;
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`[SERVICE] Preflight active on port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
