/**
 * Decision Conflict Resolution Engine
 * Phase 14 — Multi-Agent Coordination
 */

// Supremacy Ranking
const ROLE_PRIORITY = {
    'CircuitBreaker': 1,
    'GuardrailAgent': 2,
    'PolicyEngine': 3,
    'ContractConstraints': 4,
    'OptimizationAgent': 5,
    'RiskAgent': 6,
    'RoutingAgent': 7
};

function resolveConflicts(proposals, evaluations) {
    // 1. Is there an active veto/block from an observing agent?
    const blocks = evaluations.filter(e => e.action === 'BLOCK');
    if (blocks.length > 0) {
        // Find highest priority blocker (lowest number)
        blocks.sort((a, b) => (ROLE_PRIORITY[a.agentType] || 99) - (ROLE_PRIORITY[b.agentType] || 99));
        const winningBlocker = blocks[0];
        
        return {
            resolution: 'BLOCKED',
            winningAgent: winningBlocker.agentType,
            reason: winningBlocker.reason
        };
    }

    if (!proposals || proposals.length === 0) {
        return { resolution: 'NO_ACTION' };
    }

    // 2. Select the most authoritative proposal if multiples exist
    proposals.sort((a, b) => (ROLE_PRIORITY[a.agentType] || 99) - (ROLE_PRIORITY[b.agentType] || 99));
    const winner = proposals[0];

    return {
        resolution: 'APPROVED',
        winningAgent: winner.agentType,
        proposal: winner
    };
}

module.exports = { resolveConflicts };
