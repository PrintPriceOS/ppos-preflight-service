/**
 * Global Governance Precedence
 * Evaluates overarching Global Policy intents against Local Sovereign rules.
 * Defines explicit hierarchy: Guardrails > SLAs > Global > Regional > Local Actions
 * Phase 16 — Global Control Plane & Sovereign Network Governance
 */

// We mock local state configurations for federation nodes to prove the block capability
const MOCK_LOCAL_STATE = {
    'local-ops-1': {
        guardrails: { maxConcurrencyStep: 0.5 },
        contracts: { tenantIsolationRequired: true, serviceTier: 'ENTERPRISE' }
    },
    'eu-west-1': {
        guardrails: { maxConcurrencyStep: 0.3 }, // tighter guardrail
        contracts: { tenantIsolationRequired: true, serviceTier: 'ENTERPRISE' }
    },
    'us-east-failover': {
        guardrails: { maxConcurrencyStep: 1.0 },
        contracts: { tenantIsolationRequired: false, serviceTier: 'STANDARD' } 
    }
};

class GlobalGovernancePrecedence {
    
    /**
     * Determines if a global policy can legally apply to a sovereign target region.
     */
    evaluateConflict(policy, targetInstanceId) {
        const localState = MOCK_LOCAL_STATE[targetInstanceId];
        
        if (!localState) {
            return {
                allow: false,
                reason: `UNKNOWN_SOVEREIGNTY: Instance ${targetInstanceId} not resolved.`
            };
        }

        // 1. SLA Applicability Checks
        if (policy.appliesTo?.serviceTiers && !policy.appliesTo.serviceTiers.includes(localState.contracts.serviceTier)) {
            return {
                allow: false,
                reason: `SLA_MISMATCH: Policy targets Tiers [${policy.appliesTo.serviceTiers.join(',')}] but target is ${localState.contracts.serviceTier}.`
            };
        }

        // 2. Local Guardrail Conflict Checks
        if (policy.directiveType === 'GUARDRAIL_THRESHOLD') {
            const proposedMaxStep = policy.payload.maxConcurrencyStep;
            const hardcodeLocalLimit = localState.guardrails.maxConcurrencyStep;
            
            // Global wants to LOOSEN guardrails beyond what the Local region allows. Sovereignty = BLOCKED.
            if (proposedMaxStep > hardcodeLocalLimit) {
                return {
                    allow: false,
                    reason: `GUARDRAIL_CONFLICT: Global policy requests concurrency step ${proposedMaxStep}, but local hard limit is ${hardcodeLocalLimit}. Local Sovereignty prevails.`
                };
            }
        }

        // 3. Tenant Isolation Isolation 
        if (policy.directiveType === 'FEDERATION_POLICY' || policy.directiveType === 'ROUTING_ENVELOPE') {
            if (policy.payload?.forceDataShare === true && localState.contracts.tenantIsolationRequired) {
                return {
                    allow: false,
                    reason: `FATAL_DATA_LEAK_PREVENTED: Global policy attempts forced data-share, violating strict isolation contract on local node.`
                }
            }
        }

        return { allow: true, reason: 'POLICY_ACCEPTED' };
    }
}

module.exports = new GlobalGovernancePrecedence();
