/**
 * Autonomy Policy Framework
 * Phase 13 — Controlled Autonomy Expansion
 */

const policyConfig = {
    globalAutonomyEnabled: true,
    allowedStrategies: [
        'CONCURRENCY_TUNE',
        'RETRY_TUNE'
    ],
    blockedStrategies: [
        'ROUTING_SHIFT',
        'COST_OPTIMIZATION'
    ],
    perTenantOverrides: {
        't_enterprise_strict': { autonomyEnabled: false }
    },
    perDeploymentOverrides: {}
};

function getPolicy(targetType, targetId) {
    let override = null;
    if (targetType === 'tenant' && policyConfig.perTenantOverrides[targetId]) {
        override = policyConfig.perTenantOverrides[targetId];
    } else if (targetType === 'deployment' && policyConfig.perDeploymentOverrides[targetId]) {
        override = policyConfig.perDeploymentOverrides[targetId];
    }
    
    return {
        enabled: override !== null ? override.autonomyEnabled : policyConfig.globalAutonomyEnabled,
        allowed: policyConfig.allowedStrategies,
        blocked: policyConfig.blockedStrategies
    };
}

module.exports = {
    config: policyConfig,
    getPolicy
};
