/**
 * PrintPrice OS — Authorization Service (v1.9.5)
 * 
 * Enforces permissions based on:
 * 1. User Roles & Scopes
 * 2. Deployment Contract Governance Posture
 */

const ROLE_SCOPES = {
    admin: [
        'preflight:read', 'preflight:write', 
        'jobs:read', 'jobs:delete', 
        'admin:read', 'admin:write', 
        'governance:read', 'governance:write'
    ],
    tenant_admin: [
        'preflight:read', 'preflight:write', 
        'jobs:read', 'jobs:delete', 
        'governance:read'
    ],
    member: [
        'preflight:read', 'preflight:write', 
        'jobs:read'
    ],
    viewer: [
        'preflight:read', 
        'jobs:read'
    ],
    support_operator: [
        'preflight:read', 
        'jobs:read', 
        'admin:read'
    ]
};

class AuthorizationService {
    /**
     * Evaluates if a user is authorized for a specific scope given the deployment context.
     * @param {object} context - Normalized request context (auth, deployment)
     * @param {string} requiredScope - Scope being requested
     */
    isAuthorized(context, requiredScope) {
        const { auth, deployment } = context;
        
        if (!auth || !auth.role) return false;

        // Normalize role to lowercase for lookup
        const normalizedRole = auth.role.toLowerCase();

        // Wildcard scopes (e.g. ['*'] from admin JWT)
        if (Array.isArray(auth.scopes) && auth.scopes.includes('*')) return true;

        // 1. Role-based Scope Validation
        const userScopes = ROLE_SCOPES[normalizedRole] || [];
        if (!userScopes.includes(requiredScope)) {
            return false;
        }

        // 2. Deployment Contract-Aware Governance Logic
        return this.isPermittedByContract({ ...context, auth: { ...auth, role: normalizedRole } }, requiredScope);
    }

    /**
     * Applies governance rules derived from the deployment contract.
     * Some actions may be blocked regardless of role/scope.
     */
    isPermittedByContract(context, requiredScope) {
        const { auth, deployment } = context;

        // RULE: customer_managed deployments restrict provider-led intervention/introspection
        if (deployment.supportModel === 'customer_managed') {
            // Support Operators (Provider side) cannot perform WRITES
            if (auth.role === 'support_operator' && requiredScope.includes(':write')) {
                console.warn(`[AUTH-GOVERNANCE] Support Operator blocked from WRITE in customer_managed deployment ${deployment.deploymentId}`);
                return false;
            }
            
            // Global Admin READS might still be allowed if it's the provider's platform, 
            // BUT "introspection" (seeing specific tenant data) from the provider side should be limited 
            // if the policy dictates "perimeter only".
            if (auth.role === 'support_operator' && requiredScope === 'admin:read' && request.url?.includes('/tenants/')) {
                 // In a real scenario, we'd check if they are trying to drill down into a tenant they don't own.
            }
        }

        // RULE: provider_managed deployments allow broader intervention
        if (deployment.supportModel === 'provider_managed') {
             // Broader system state visibility is typically allowed here.
        }

        // RULE: manual_approval_only mode blocks direct governance changes
        if (deployment.upgradeMode === 'manual_approval_only') {
            if (requiredScope === 'governance:write' && auth.role !== 'admin') {
                console.warn(`[AUTH-GOVERNANCE] Direct governance write blocked for role ${auth.role} in manual_approval_only deployment.`);
                return false;
            }
        }

        // RULE: multi_tenant_managed_cloud restricts destructive operations for non-admins
        if (deployment.profile === 'multi_tenant_managed_cloud') {
            if (requiredScope === 'jobs:delete' && !['admin', 'tenant_admin'].includes(auth.role)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Returns the failure reason for debugging/auditing.
     */
    getReason(context, requiredScope) {
        const { auth, deployment } = context;
        if (!auth || !auth.role) return 'Unauthenticated';
        
        const userScopes = ROLE_SCOPES[auth.role] || [];
        if (!userScopes.includes(requiredScope)) {
            return `Role ${auth.role} lacks scope ${requiredScope}`;
        }

        return `Governance policy for deployment profile ${deployment.profile} restricts this action.`;
    }
}

module.exports = new AuthorizationService();
