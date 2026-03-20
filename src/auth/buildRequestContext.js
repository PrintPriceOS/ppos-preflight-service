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
    const requestId = requestTracer.getOrCreateRequestId(request.headers);
    request.context = {
        request: { 
            requestId,
            ip: request.ip,
            userAgent: request.headers['user-agent'],
            headers: {
                'idempotency-key': request.headers['idempotency-key'],
                'x-request-id': request.headers['x-request-id'] || requestId,
                'x-job-id': request.headers['x-job-id']
            }
        }
    };

    // Skip for public/auth routes
    if (request.url.startsWith('/health') || request.url.startsWith('/api/auth')) return;

    try {
        // Load deployment context (cached after first call)
        const deployment = await loadDeploymentContext();
        request.context.deployment = deployment;

        // Extract and verify JWT
        const authHeader = request.headers['authorization'];
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
                
                request.log.info({ 
                    requestId, 
                    deploymentId: deployment.deploymentId, 
                    tenantId: request.context.auth.tenantId,
                    authMode: 'jwt'
                }, 'Auth successful');
                
                // Trace Auth Success (Phase 7)
                auditLogger.log(request.context, { 
                    action: 'AUTH_SUCCESS', 
                    resourceType: 'IDENTITY_SERVICE',
                    ip: request.ip,
                    userAgent: request.headers['user-agent']
                });
                
                return; // Success
            } catch (err) {
                request.log.warn({ requestId, deploymentId: deployment.deploymentId }, `[AUTH] Invalid JWT: ${err.message}`);
                
                // Trace Auth Failure
                auditLogger.log(request.context, { 
                    action: 'AUTH_FAILURE', 
                    resourceType: 'IDENTITY_SERVICE',
                    ip: request.ip,
                    userAgent: request.headers['user-agent']
                });

                return reply.status(401).send({ error: 'INVALID_TOKEN', message: err.message });
            }
        }

        // Legacy Auth Path
        const ALLOW_LEGACY = process.env.ALLOW_LEGACY_AUTH === 'true';
        const legacyKey = request.headers['x-ppos-api-key'];
        if (ALLOW_LEGACY && legacyKey && legacyKey === process.env.ADMIN_API_KEY) {
            request.context.auth = {
                userId: 'legacy-api',
                tenantId: 'default',
                role: 'LEGACY_ADMIN',
                scopes: ['*']
            };
            request.log.warn({ requestId, deploymentId: deployment.deploymentId, authMode: 'legacy' }, 'Legacy auth used');
            
            auditLogger.log(request.context, { action: 'AUTH_LEGACY_SUCCESS' });
            return;
        }

        request.log.error({ requestId, deploymentId: deployment.deploymentId }, 'Unauthorized access attempt');
        return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'JWT required' });

    } catch (err) {
        request.log.error({ requestId, error: err.message }, 'Failed to build request context');
        return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to populate context' });
    }
};
