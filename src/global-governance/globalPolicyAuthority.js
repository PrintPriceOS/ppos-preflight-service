/**
 * Global Policy Authority
 * The central interface for defining new Global Governance Directives.
 * Validates schema and coordinates hand-offs to rollout engines.
 * Phase 16 — Global Control Plane & Sovereign Network Governance
 */

const registry = require('./globalPolicyRegistry');

class GlobalPolicyAuthority {
    /**
     * Proposes a new Global Governance Directive intent.
     * Starts in DRAFT or DRY_RUN status.
     */
    draftPolicy(definition) {
        // Validate schema
        if (!['global', 'regional', 'instance-group'].includes(definition.scope)) {
            throw new Error('[GLOBAL-AUTHORITY] Invalid scope context.');
        }

        const validDirectives = ['GUARDRAIL_THRESHOLD', 'ROUTING_ENVELOPE', 'AUTONOMY_MODE', 'FEDERATION_POLICY', 'KILLSWITCH'];
        if (!validDirectives.includes(definition.directiveType)) {
            throw new Error(`[GLOBAL-AUTHORITY] Unknown directive Type: ${definition.directiveType}`);
        }

        // Must inject metadata and default to DRAFT
        const policy = {
            ...definition,
            status: 'DRAFT',
            createdAt: new Date().toISOString(),
            createdBy: 'GLOBAL_ADMIN_SYSTEM'
        };

        return registry.register(policy);
    }

    /**
     * Supersedes an existing policy with a newly drafted version.
     */
    supersede(oldPolicyId, oldVersion, newDefinition) {
        const oldPolicy = registry.get(oldPolicyId, oldVersion);
        if (!oldPolicy) throw new Error('[GLOBAL-AUTHORITY] Origin policy not found for superseding.');
        
        registry.updateStatus(oldPolicyId, oldVersion, 'SUPERSEDED');
        
        return this.draftPolicy({
            ...newDefinition,
            policyId: oldPolicyId, // keep same canonical ID
            compatibilityConstraints: { ...oldPolicy.compatibilityConstraints, ...newDefinition.compatibilityConstraints }
        });
    }

    getActivePolicies() {
        return registry.getAll().filter(p => p.status === 'ACTIVE');
    }
}

module.exports = new GlobalPolicyAuthority();
