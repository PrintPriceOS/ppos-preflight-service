const authorizationService = require('../services/authorizationService');

/**
 * Fastify hook for scope-based authorization.
 * Wraps the authorization service into a reusable middleware-like function.
 * Use it in route-specific hooks or globally for a group.
 */
module.exports = (requiredScope) => {
    return async (request, reply) => {
        const context = request.context;
        const requestId = context?.request?.requestId || 'unknown';

        if (!context || !context.auth) {
            request.log.warn({ requestId }, `Access Denied: Unauthenticated for scope ${requiredScope}`);
            return reply.status(401).send({ 
                error: 'UNAUTHORIZED', 
                message: 'No authenticated context found.',
                requestId
            });
        }

        // Evaluate Permission
        const authorized = authorizationService.isAuthorized(context, requiredScope);

        if (!authorized) {
            const reason = authorizationService.getReason(context, requiredScope);
            
            request.log.warn({ 
                requestId, 
                tenantId: context.auth.tenantId, 
                role: context.auth.role,
                scope: requiredScope,
                reason 
            }, 'Access Denied: Forbidden');

            return reply.status(403).send({
                error: 'FORBIDDEN',
                scope: requiredScope,
                message: 'You do not have the required permissions or governance posture for this action.',
                reason,
                requestId
            });
        }

        request.log.info({ 
            requestId, 
            scope: requiredScope, 
            role: context.auth.role 
        }, 'Authorization successful');
        
        // Scope authorized, continue.
    };
};
