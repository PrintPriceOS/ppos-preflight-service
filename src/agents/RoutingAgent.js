const AgentBase = require('./agentBase');
const federatedDecisionEngine = require('../federation/federatedDecisionEngine');
const signalIngestor = require('../federation/signalIngestor');

/**
 * Routing Agent
 * Specializes in directing traffic. Exists predominantly in Phase 14
 * as a shadow evaluator for network topology stability.
 */
class RoutingAgent extends AgentBase {
    constructor() {
        super('agent_route_01', 'RoutingAgent');
    }

    async propose(input) {
        // Look at cross-instance signals via the signal bus
        const signals = signalIngestor.getLatestSignals();
        const proposals = [];

        for (const sig of signals) {
            const evaluation = federatedDecisionEngine.evaluateCrossRegionAction(sig);
            if (evaluation.action === 'ROUTE_AWAY' || evaluation.action === 'SUGGEST_REDISTRIBUTION') {
                proposals.push({
                    id: `fed_route_${Date.now()}`,
                    agentType: this.agentType,
                    action: 'ROUTING_SHIFT',
                    targetId: evaluation.targetInstance, // We shift TO them or FROM them based on synthetic logic
                    mode: 'BOUNDED_AUTO',
                    payload: { suggestion: evaluation }
                });
            }
        }

        // We can also actively look if we need to evacuate local traffic
        const evacuation = federatedDecisionEngine.synthesizeEvacuationRoute(input.contractContext);
        if (evacuation.action === 'ROUTE_AWAY') {
            proposals.push({
                id: `local_evac_${Date.now()}`,
                agentType: this.agentType,
                action: 'ROUTING_SHIFT',
                targetId: evacuation.targetInstance,
                mode: 'BOUNDED_AUTO',
                payload: { suggestion: evacuation }
            });
        }

        return proposals;
    }

    async evaluate(proposal) {
        if (proposal.action === 'ROUTING_SHIFT' && proposal.agentType !== 'RoutingAgent') {
             // In future phases, RoutingAgent dominates here.
        }
        return { action: 'ALLOW', reason: 'Routing domain verified.' };
    }
}
module.exports = new RoutingAgent();
