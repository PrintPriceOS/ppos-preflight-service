/**
 * Agent Policy & Permissions Matrix
 * Phase 14 — Multi-Agent Coordination
 */
const policies = {
    'RiskAgent': { autonomyLevel: 'ADVISORY', allowedActions: ['MITIGATE_RISK'], blockedActions: [] },
    'GuardrailAgent': { autonomyLevel: 'BOUNDED_AUTO', allowedActions: ['BLOCK'], blockedActions: [] },
    'OptimizationAgent': { autonomyLevel: 'BOUNDED_AUTO', allowedActions: ['CONCURRENCY_TUNE', 'RETRY_TUNE'], blockedActions: ['ROUTING_SHIFT'] },
    'RoutingAgent': { autonomyLevel: 'SHADOW', allowedActions: ['ROUTING_SHIFT'], blockedActions: [] },
    'LearningAgent': { autonomyLevel: 'ADVISORY', allowedActions: [], blockedActions: ['EXECUTE'] }
};

function getAgentPolicy(agentType) {
    return policies[agentType] || { autonomyLevel: 'SHADOW', allowedActions: [], blockedActions: [] };
}

module.exports = { getAgentPolicy };
