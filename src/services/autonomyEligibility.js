/**
 * Autonomy Eligibility Engine
 * Phase 13 — Controlled Autonomy Expansion
 */

const adjuster = require('./confidenceAdjuster');
const { getPolicy } = require('./autonomyPolicy');

function determineEligibility(strategyType, contractContext, targetType, targetId) {
    const policy = getPolicy(targetType, targetId);

    const metrics = {
        confidenceScore: adjuster.getScore(strategyType) || 0.5,
        sampleSize: 0,
        successRate: 0,
        regressionRate: 0,
        unsafeRate: 0
    };

    const sysConf = adjuster.getSystemConfidence().find(s => s.strategyType === strategyType);
    if (sysConf) {
        metrics.sampleSize = sysConf.sampleSize;
        metrics.successRate = sysConf.confidenceScore > 0.5 ? 80 : 20; 
    }

    // 1. Is it globally blocked by policy?
    if (!policy.enabled) {
        return { strategyType, eligible: false, reason: 'GLOBAL_AUTONOMY_DISABLED', metrics };
    }
    
    if (policy.blocked.includes(strategyType)) {
        return { strategyType, eligible: false, reason: 'STRATEGY_BLOCKED_BY_POLICY', metrics };
    }
    
    if (!policy.allowed.includes(strategyType)) {
        return { strategyType, eligible: false, reason: 'STRATEGY_NOT_ALLOWED', metrics };
    }

    // 2. Eligibility Hardware Rules
    if (metrics.confidenceScore < 0.75) {
        return { strategyType, eligible: false, reason: `INSUFFICIENT_CONFIDENCE (${metrics.confidenceScore.toFixed(2)} < 0.75)`, metrics };
    }

    // 3. Minimum Quorum check (5 samples)
    if (metrics.sampleSize > 0 && metrics.sampleSize < 5) {
        return { strategyType, eligible: false, reason: `INSUFFICIENT_SAMPLE_SIZE (${metrics.sampleSize} < 5)`, metrics };
    }

    // 4. Contract-Aware specific thresholds
    if (contractContext?.serviceTier === 'standard') {
        if (metrics.confidenceScore < 0.85) { // Stricter threshold for standard
            return { strategyType, eligible: false, reason: `CONTRACT_STRICT_EVAL (${metrics.confidenceScore.toFixed(2)} < 0.85)`, metrics };
        }
    }

    return { strategyType, eligible: true, reason: 'ELIGIBILITY_CRITERIA_MET', metrics };
}

module.exports = {
    determineEligibility
};
