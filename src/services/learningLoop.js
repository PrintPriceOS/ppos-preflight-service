/**
 * Learning Loop Orchestrator
 * Phase 12 — Learning & Outcome Optimization Loop
 */

const memory = require('./optimizationMemory');
const ranker = require('./strategyRanker');
const adjuster = require('./confidenceAdjuster');

/**
 * Consumes an evaluator output and updates the memory and confidence state.
 */
function ingestEvaluatorOutcome(evaluatedOutcome) {
    // 1. Store in memory
    const record = memory.recordOutcome(evaluatedOutcome);
    
    // 2. Adjust global strategy confidence
    const updatedConfidence = adjuster.evaluateConfidenceAdjustment(record);
    
    console.log(`[LEARNING-LOOP] Ingested ${record.verdict} outcome for ${record.type}. New Confidence: ${(updatedConfidence.confidenceScore * 100).toFixed(1)}% (${updatedConfidence.trend})`);

    // In a full implementation, we would emit: 
    // auditLogger.log('OPTIMIZATION_OUTCOME_RECORDED', { record, updatedConfidence }) 
    
    return {
        record,
        updatedConfidence,
        currentRankings: ranker.rankStrategies(record.contractContext || {})
    };
}

module.exports = {
    ingestEvaluatorOutcome
};
