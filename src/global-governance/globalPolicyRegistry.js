/**
 * Global Policy Registry
 * The immutable ledger of all global governance policies
 * Phase 16 — Global Control Plane & Sovereign Network Governance
 */

class GlobalPolicyRegistry {
    constructor() {
        this.policies = new Map();
        
        // Seed with a mock default
        this.register({
            policyId: 'gp-guardrail-baseline',
            version: '1.0.0',
            status: 'ACTIVE',
            directiveType: 'GUARDRAIL_THRESHOLD',
            scope: 'global',
            appliesTo: {
                regions: ['*'],
                serviceTiers: ['ENTERPRISE', 'STANDARD', 'BASIC']
            },
            payload: { maxConcurrencyStep: 0.5 },
            compatibilityConstraints: { minOsVersion: 'v2.0.0' },
            createdAt: new Date().toISOString(),
            activatedAt: new Date().toISOString()
        });
    }

    register(policyDef) {
        if (!policyDef.policyId || !policyDef.version) {
            throw new Error('[POLICY-REGISTRY] Cannot register policy without ID and Version.');
        }

        const key = `${policyDef.policyId}_v${policyDef.version}`;
        if (this.policies.has(key)) {
            throw new Error(`[POLICY-REGISTRY] Policy version ${key} already exists. Policies are immutable.`);
        }

        policyDef.createdAt = policyDef.createdAt || new Date().toISOString();
        this.policies.set(key, policyDef);
        console.log(`[GLOBAL-REGISTRY] Registered Policy: ${key} [${policyDef.status}]`);
        return policyDef;
    }

    get(policyId, version) {
        return this.policies.get(`${policyId}_v${version}`);
    }

    getAll() {
        return Array.from(this.policies.values());
    }

    updateStatus(policyId, version, newStatus) {
        const key = `${policyId}_v${version}`;
        const policy = this.policies.get(key);
        if (!policy) throw new Error(`[POLICY-REGISTRY] Cannot update unknown policy ${key}`);
        
        policy.status = newStatus;
        if (newStatus === 'ACTIVE') {
            policy.activatedAt = new Date().toISOString();
        }
        
        this.policies.set(key, policy);
        console.log(`[GLOBAL-REGISTRY] Status Updated: ${key} -> ${newStatus}`);
        return policy;
    }
}

module.exports = new GlobalPolicyRegistry();
