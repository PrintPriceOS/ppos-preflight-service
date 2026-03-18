/**
 * Confidence Evolution System
 * Phase 12 — Learning & Outcome Optimization Loop
 */

const strategyScores = {}; // In-memory

/**
 * Evolves the confidence of a strategy organically based on a new outcome.
 */
function evaluateConfidenceAdjustment(outcomePayload) {
    const { type, verdict } = outcomePayload;

    if (!strategyScores[type]) {
        strategyScores[type] = {
            strategyType: type,
            confidenceScore: 0.5, // Start at 50%
            sampleSize: 0,
            lastUpdated: new Date().toISOString(),
            trend: 'STABLE'
        };
    }

    const state = strategyScores[type];
    const oldScore = state.confidenceScore;

    if (verdict === 'IMPROVED') {
        state.confidenceScore += 0.05;
    } else if (verdict === 'NEUTRAL') {
        state.confidenceScore -= 0.01;
    } else if (verdict === 'REGRESSED') {
        state.confidenceScore -= 0.10;
    } else if (verdict === 'UNSAFE') {
        state.confidenceScore -= 0.25; 
    }

    // Clamp
    if (state.confidenceScore > 1.0) state.confidenceScore = 1.0;
    if (state.confidenceScore < 0.0) state.confidenceScore = 0.0;

    // Trend assessment
    if (state.confidenceScore > oldScore + 0.02) state.trend = 'UP';
    else if (state.confidenceScore < oldScore - 0.02) state.trend = 'DOWN';
    else state.trend = 'STABLE';

    state.sampleSize += 1;
    state.lastUpdated = new Date().toISOString();

    return state;
}

function getSystemConfidence() {
    return Object.values(strategyScores);
}

function getScore(type) {
    return strategyScores[type] ? strategyScores[type].confidenceScore : 0.5;
}

module.exports = {
    evaluateConfidenceAdjustment,
    getSystemConfidence,
    getScore
};
