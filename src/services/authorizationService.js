/**
 * PrintPrice OS — Authorization Service (v1.9.6)
 *
 * Enforces permissions based on:
 * 1. User Roles & Scopes
 * 2. Deployment Contract Governance Posture
 *
 * v1.9.6 patch:
 * - Adds canonical scope aliases for Control Plane preflight flows.
 * - Allows SUPER_ADMIN/admin style roles to pass preflight job read/write routes.
 * - Keeps tenant isolation and deployment governance checks intact.
 */

const ROLE_SCOPES = {
    admin: [
        'preflight:read', 'preflight:write',
        'jobs:read', 'jobs:write', 'jobs:fix', 'jobs:delete',
        'admin:read', 'admin:write',
        'governance:read', 'governance:write'
    ],
    super_admin: [
        'preflight:read', 'preflight:write',
        'jobs:read', 'jobs:write', 'jobs:fix', 'jobs:delete',
        'admin:preflight', 'admin:read', 'admin:write',
        'governance:read', 'governance:write'
    ],
    tenant_admin: [
        'preflight:read', 'preflight:write',
        'jobs:read', 'jobs:write', 'jobs:fix', 'jobs:delete',
        'governance:read'
    ],
    member: [
        'preflight:read', 'preflight:write',
        'jobs:read', 'jobs:write', 'jobs:fix'
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

const SCOPE_ALIASES = {
    'jobs:read': ['jobs:read', 'preflight:read', 'admin:preflight'],
    'jobs:write': ['jobs:write', 'preflight:write', 'admin:preflight'],
    'jobs:fix': ['jobs:fix', 'preflight:write', 'admin:preflight'],
    'jobs:delete': ['jobs:delete', 'preflight:write', 'admin:preflight'],
    'preflight:read': ['preflight:read', 'jobs:read', 'admin:preflight'],
    'preflight:write': ['preflight:write', 'jobs:write', 'jobs:fix', 'admin:preflight']
};

const ADMIN_ROLES = new Set(['admin', 'super_admin', 'superadmin', 'system_admin', 'owner']);

function normalizeRole(role) {
    return String(role || '').trim().toLowerCase();
}

function normalizeScopes(scopes) {
    if (Array.isArray(scopes)) return scopes.map(String).filter(Boolean);
    if (typeof scopes === 'string') {
        return scopes.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    }
    return [];
}

function getAcceptedScopes(requiredScope) {
    return SCOPE_ALIASES[requiredScope] || [requiredScope];
}

class AuthorizationService {
    /**
     * Evaluates if a user is authorized for a specific scope given the deployment context.
     * @param {object} context - Normalized request context (auth, deployment)
     * @param {string} requiredScope - Scope being requested
     */
    isAuthorized(context, requiredScope) {
        const { auth } = context || {};

        if (!auth) return false;

        const traceId = context?.requestId ? `[${context.requestId}] ` : '';
        const acceptedScopes = getAcceptedScopes(requiredScope);
        const jwtScopes = normalizeScopes(auth.scopes || auth.scope);

        // 1. Direct JWT Scope Validation (Highest Precedence)
        if (jwtScopes.includes('*')) return true;

        const matchedJwtScope = acceptedScopes.find(scope => jwtScopes.includes(scope));
        if (matchedJwtScope) {
            if (matchedJwtScope !== requiredScope) {
                console.log(`${traceId}[AUTHZ][ALIAS-MATCH] required=${requiredScope} matched=${matchedJwtScope}`);
            }
            return true;
        }

        // 2. Role-based Scope Fallback
        if (!auth.role) return false;
        const normalizedRole = normalizeRole(auth.role);

        // SUPER_ADMIN style roles are allowed for preflight/job admin routes, but still pass
        // through deployment governance checks below.
        const isAdminRole = ADMIN_ROLES.has(normalizedRole);
        const isPreflightScope = acceptedScopes.some(scope =>
            scope.startsWith('preflight:') || scope.startsWith('jobs:') || scope === 'admin:preflight'
        );

        if (isAdminRole && isPreflightScope) {
            console.log(`${traceId}[AUTHZ][ROLE-FALLBACK] role=${auth.role} required=${requiredScope}`);
            return this.isPermittedByContract({ ...context, auth: { ...auth, role: normalizedRole } }, requiredScope);
        }

        const userScopes = ROLE_SCOPES[normalizedRole] || [];
        const matchedRoleScope = acceptedScopes.find(scope => userScopes.includes(scope));
        const roleHasScope = Boolean(matchedRoleScope);

        if (roleHasScope) {
            if (matchedRoleScope !== requiredScope) {
                console.log(`${traceId}[AUTHZ][ROLE-ALIAS-MATCH] required=${requiredScope} matched=${matchedRoleScope} role=${auth.role}`);
            }
            // 3. Deployment Contract-Aware Governance Logic
            return this.isPermittedByContract({ ...context, auth: { ...auth, role: normalizedRole } }, requiredScope);
        }

        // [AUTHZ-DEBUG] Log scope DENY before returning false
        console.warn(`${traceId}[AUTHZ-DEBUG] Scope match failed: required=${requiredScope}, accepted=${JSON.stringify(acceptedScopes)}, authRole=${auth.role}, authScopes=${JSON.stringify(jwtScopes)}, jwtScopeMatch=${Boolean(matchedJwtScope)}, roleFallback=${roleHasScope}`);

        return false;
    }

    /**
     * Applies governance rules derived from the deployment contract.
     * Some actions may be blocked regardless of role/scope.
     */
    isPermittedByContract(context, requiredScope) {
        const { auth, deployment = {} } = context || {};

        // RULE: customer_managed deployments restrict provider-led intervention/introspection
        if (deployment.supportModel === 'customer_managed') {
            // Support Operators (Provider side) cannot perform WRITES
            if (auth.role === 'support_operator' && requiredScope.includes(':write')) {
                console.warn(`[AUTH-GOVERNANCE] Support Operator blocked from WRITE in customer_managed deployment ${deployment.deploymentId}`);
                return false;
            }
        }

        // RULE: manual_approval_only mode blocks direct governance changes
        if (deployment.upgradeMode === 'manual_approval_only') {
            if (requiredScope === 'governance:write' && auth.role !== 'admin' && auth.role !== 'super_admin') {
                console.warn(`[AUTH-GOVERNANCE] Direct governance write blocked for role ${auth.role} in manual_approval_only deployment.`);
                return false;
            }
        }

        // RULE: multi_tenant_managed_cloud restricts destructive operations for non-admins
        if (deployment.profile === 'multi_tenant_managed_cloud') {
            if (requiredScope === 'jobs:delete' && !['admin', 'super_admin', 'tenant_admin'].includes(auth.role)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Returns the failure reason for debugging/auditing.
     */
    getReason(context, requiredScope) {
        const { auth, deployment = {} } = context || {};
        if (!auth || !auth.role) return 'Unauthenticated';

        const acceptedScopes = getAcceptedScopes(requiredScope);
        const jwtScopes = normalizeScopes(auth.scopes || auth.scope);
        const normalizedRole = normalizeRole(auth.role);
        const userScopes = ROLE_SCOPES[normalizedRole] || [];
        const isAdminRole = ADMIN_ROLES.has(normalizedRole);
        const isPreflightScope = acceptedScopes.some(scope =>
            scope.startsWith('preflight:') || scope.startsWith('jobs:') || scope === 'admin:preflight'
        );

        if (jwtScopes.includes('*') || acceptedScopes.some(scope => jwtScopes.includes(scope))) {
            return `Authorized by scope alias for ${requiredScope}`;
        }

        if ((isAdminRole && isPreflightScope) || acceptedScopes.some(scope => userScopes.includes(scope))) {
            return `Governance policy for deployment profile ${deployment.profile || 'unknown'} restricts this action.`;
        }

        return `Role ${auth.role} lacks scope ${requiredScope}; accepted scopes: ${acceptedScopes.join(', ')}`;
    }
}

module.exports = new AuthorizationService();
