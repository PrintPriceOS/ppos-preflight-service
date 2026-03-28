const { verifyJwt } = require('./verifyJwt');
const { loadDeploymentContext } = require('./loadDeploymentContext');
const requestTracer = require('../services/requestTracer');
const auditLogger = require('../services/auditLogger');

/**
 * Fastify hook to build the normalized request context.
 * 
 * After auth, attaches a normalized object to req.context.
 */
module.exports = async (request, reply) => {
    // --- Phase 10: context normalization ---
    const safeHeaders = request?.headers || {};
    const safeRequestId = requestTracer.getOrCreateRequestId(safeHeaders);
    const safeTraceparent = safeHeaders['traceparent'] || null;

    // 1. Initialize safe request metadata
    const contextRequest = { 
        requestId: safeRequestId,
        ip: request?.ip || '127.0.0.1',
        userAgent: safeHeaders['user-agent'] || 'unknown',
        headers: {
            'idempotency-key': safeHeaders['idempotency-key'],
            'x-request-id': safeHeaders['x-request-id'] || safeRequestId,
            'x-job-id': safeHeaders['x-job-id'],
            'traceparent': safeTraceparent
        }
    };

    // 2. Build initial context envelope
    request.context = {
        requestId: safeRequestId,
        headers: contextRequest.headers,
        traceparent: safeTraceparent,
        request: contextRequest,
        auth: null,
        deployment: null
    };

    // Skip for public/auth routes
    if (request?.url?.startsWith('/health') || request?.url?.startsWith('/api/auth')) return;

    try {
        // Load deployment contract (Phase 10 Hardened Strategy)
        let deployment = null;
        try {
            const { contract } = loadDeploymentContext();
            deployment = contract;
            request.context.deployment = deployment;
        } catch (depErr) {
            request.log?.warn(`[AUTH] Failed to load deployment context: ${depErr.message}`);
        }

        // Extract and verify JWT
        const authHeader = safeHeaders['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            try {
                const decoded = verifyJwt(token);
                request.context.auth = {
                    userId: decoded.userId,
                    tenantId: decoded.tenantId || 'default',
                    role: decoded.role || 'GUEST',
                    scopes: decoded.scopes || []
                };
                
                request.log?.info({ 
                    requestId: safeRequestId, 
                    deploymentId: deployment?.deploymentId || 'unknown', 
                    tenantId: request.context.auth.tenantId,
                    authMode: 'jwt'
                }, 'Auth successful');
                
                // Trace Auth Success (Phase 7)
                await auditLogger.log(request.context, { 
                    action: 'AUTH_SUCCESS', 
                    resourceType: 'IDENTITY_SERVICE',
                    ip: request?.ip || '127.0.0.1',
                    userAgent: safeHeaders['user-agent'] || 'unknown'
                });
                
                return; // Success
            } catch (err) {
                request.log?.warn({ requestId: safeRequestId, deploymentId: deployment?.deploymentId || 'unknown' }, `[AUTH] Invalid JWT: ${err.message}`);
                
                // Trace Auth Failure
                await auditLogger.log(request.context, { 
                    action: 'AUTH_FAILURE', 
                    resourceType: 'IDENTITY_SERVICE',
                    ip: request?.ip || '127.0.0.1',
                    userAgent: safeHeaders['user-agent'] || 'unknown'
                });

                return reply.status(401).send({ error: 'INVALID_TOKEN', message: err.message });
            }
        }

        // Legacy Auth Path
        const ALLOW_LEGACY = process.env.ALLOW_LEGACY_AUTH === 'true';
        const legacyKey = safeHeaders['x-ppos-api-key'];
        if (ALLOW_LEGACY && legacyKey && legacyKey === process.env.ADMIN_API_KEY) {
            request.context.auth = {
                userId: 'legacy-api',
                tenantId: 'default',
                role: 'LEGACY_ADMIN',
                scopes: ['*']
            };
            request.log?.warn({ requestId: safeRequestId, deploymentId: deployment?.deploymentId || 'unknown', authMode: 'legacy' }, 'Legacy auth used');
            
            await auditLogger.log(request.context, { action: 'AUTH_LEGACY_SUCCESS' });
            return;
        }

        // If even health/auth check fails, log and reply
        request.log?.error({ requestId: safeRequestId, deploymentId: deployment?.deploymentId || 'unknown' }, 'Unauthorized access attempt');
        return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'JWT required' });

    } catch (err) {
        const errorRequestId = request?.context?.request?.requestId || safeRequestId || 'unknown';
        request.log?.error({ requestId: errorRequestId, error: err.message }, 'Failed to build request context');
        return reply.status(500).send({ error: 'INTERNAL_ERROR', message: `Failed to populate context: ${err.message}` });
    }
};
