/**
 * @ppos/preflight-service
 * 
 * Industrial HTTP Entrypoint for Preflight Engine.
 * Classification: RUNTIME_SERVICE
 */
require('dotenv').config();
const fastify = require('fastify')({
    logger: {
        level: 'info',
        formatters: {
            level: (label) => { return { level: label.toUpperCase() }; }
        }
    }
});
const path = require('path');
const fs = require('fs-extra');

// Register Plugins
fastify.register(require('@fastify/multipart'), {
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB Industrial limit
    }
});

// Register Routes
fastify.register(require('./routes/health'), { prefix: '/health' });
fastify.register(require('./routes/analyze'), { prefix: '/analyze' });
fastify.register(require('./routes/autofix'), { prefix: '/autofix' });

// Global Error Handler
fastify.setErrorHandler((error, request, reply) => {
    fastify.log.error(error);
    reply.status(error.statusCode || 500).send({
        ok: false,
        error: error.code || 'INTERNAL_ERROR',
        message: error.message
    });
});

/**
 * Initialization Logic
 */
const start = async () => {
    try {
        const PORT = process.env.PPOS_PORT || 3000;
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        fastify.log.info(`[SERVICE] Preflight Engine HTTP Wrapper active on port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
