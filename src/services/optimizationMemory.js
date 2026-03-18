/**
 * Optimization Outcome Memory
 * Phase 12 — Learning & Outcome Optimization Loop
 */

// In memory DB for Phase 12, would be backed by Redis/Mongo in production
const memoryStore = [];

/**
 * Stores a historically applied optimization outcome.
 * Append-only ledger.
 */
function recordOutcome(payload) {
    const record = {
        candidateId: payload.candidateId,
        type: payload.type,
        targetType: payload.targetType,
        targetId: payload.targetId,
        contractContext: payload.contractContext || {},
        rationale: payload.rationale || {},
        expectedBenefit: payload.expectedBenefit,
        actualOutcome: payload.actualOutcome || null,
        verdict: payload.verdict, // IMPROVED, NEUTRAL, REGRESSED, UNSAFE
        metricsBefore: payload.metricsBefore || {},
        metricsAfter: payload.metricsAfter || {},
        timestamp: new Date().toISOString()
    };
    
    memoryStore.push(record);
    return record;
}

/**
 * Queries the memory base.
 */
function queryOutcomes(filters = {}) {
    return memoryStore.filter(record => {
        let match = true;
        if (filters.type && record.type !== filters.type) match = false;
        if (filters.targetId && record.targetId !== filters.targetId) match = false;
        if (filters.verdict && record.verdict !== filters.verdict) match = false;
        // Check nested contract context
        if (filters.serviceTier && record.contractContext?.serviceTier !== filters.serviceTier) match = false;
        if (filters.isolationMode && record.contractContext?.isolationMode !== filters.isolationMode) match = false;
        return match;
    });
}

function dumpMemory() {
    return memoryStore;
}

module.exports = {
    recordOutcome,
    queryOutcomes,
    dumpMemory
};
