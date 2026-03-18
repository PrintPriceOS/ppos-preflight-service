/**
 * Federation Policy Validator
 * The Sovereign Rule Enforcer. Determines if an external routing proposal
 * is theoretically permissible under cross-region tier rules.
 * Phase 15 — Distributed Regional Federation
 */

const registry = require('./instanceRegistry');

class FederationPolicyValidator {
    /**
     * Evaluates whether local instance is permitted to offload to target instance
     */
    validateRoutingIntent(targetInstanceId) {
        const local = registry.get('local-ops-1');
        const target = registry.get(targetInstanceId);

        if (!target) return { allowed: false, reason: 'UNKNOWN_TARGET_INSTANCE' };

        // Isolation Hard Gate: We cannot downgrade SLA tiers without explicit tenant contract bypass
        const tiers = { 'BASIC': 1, 'STANDARD': 2, 'ENTERPRISE': 3 };
        
        const localLevel = tiers[local.serviceTier] || 1;
        const targetLevel = tiers[target.serviceTier] || 1;

        if (targetLevel < localLevel) {
            return { allowed: false, code: 'DOWNGRADE_NOT_ALLOWED', reason: `Policy strictly forbids routing ${local.serviceTier} cluster traffic to a ${target.serviceTier} cluster.` };
        }

        if (target.status !== 'HEALTHY') {
            return { allowed: false, code: 'TARGET_DEGRADED', reason: 'Policy forbids shifting load to an already degraded region.' };
        }

        return { allowed: true, reason: 'POLICY_CONFORMS' };
    }
}

module.exports = new FederationPolicyValidator();
