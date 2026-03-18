/**
 * Strategy Promotion / Demotion System
 * Phase 13 — Controlled Autonomy Expansion
 */

const eligibility = require('./autonomyEligibility');

// State map tracking lifecycle strings per strategy
// Defaults to SHADOW before eligibility gates
const lifecycleStates = {};

function getLifecycleState(strategyType) {
    return lifecycleStates[strategyType] || 'SHADOW';
}

function evaluateLifecycle(strategyType, contractContext, targetType, targetId) {
    const currentState = getLifecycleState(strategyType);
    const evalResult = eligibility.determineEligibility(strategyType, contractContext, targetType, targetId);

    const output = {
        strategyType,
        currentState,
        previousState: currentState,
        reason: evalResult.reason,
        timestamp: new Date().toISOString()
    };

    if (evalResult.eligible) {
        if (currentState === 'SHADOW' || currentState === 'ADVISORY') {
            // Promote to autonomous execution!
            lifecycleStates[strategyType] = 'BOUNDED_AUTO';
            output.currentState = 'BOUNDED_AUTO';
            console.log(`[LIFECYCLE] Promoted ${strategyType} to BOUNDED_AUTO.`);
        }
    } else {
        if (currentState === 'BOUNDED_AUTO') {
            // Confidence collapsed, policy blocked it, or requirements changed. Safely demote.
            lifecycleStates[strategyType] = 'ADVISORY';
            output.currentState = 'ADVISORY';
            console.log(`[LIFECYCLE] Demoted ${strategyType} to ADVISORY. Reason: ${evalResult.reason}`);
        } else if (currentState === 'SHADOW' && evalResult.reason.includes('STRATEGY_BLOCKED_BY_POLICY')) {
            // Remains purely shadow/stagnant
        }
    }

    return output;
}

function demoteToSuppressed(strategyType, reason) {
    const previousState = getLifecycleState(strategyType);
    lifecycleStates[strategyType] = 'SUPPRESSED';
    console.log(`[LIFECYCLE-EMERGENCY] Suppressed ${strategyType}. Reason: ${reason}`);
    
    return {
        strategyType,
        currentState: 'SUPPRESSED',
        previousState,
        reason: `EMERGENCY_DEMOTION: ${reason}`,
        timestamp: new Date().toISOString()
    };
}

module.exports = {
    getLifecycleState,
    evaluateLifecycle,
    demoteToSuppressed
};
