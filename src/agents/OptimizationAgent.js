const AgentBase = require('./agentBase');
const engine = require('../../../ppos-control-plane/src/api/services/optimizationEngine');

/**
 * Optimization Agent
 * Inherits Phase 11/12/13 generation power but subjects it
 * to Phase 14 Multi-Agent Arbitration constraints.
 */
class OptimizationAgent extends AgentBase {
    constructor() {
        super('agent_opt_01', 'OptimizationAgent');
    }

    async propose(input) {
        // Delegate proposal generation to the existing deterministic engine
        const { candidates } = engine.generateCandidates(input);
        
        // Map candidates to unified Arbitrator proposals
        return candidates.map(c => ({
            id: c.id,
            agentType: this.agentType,
            action: c.type,
            targetId: c.targetId,
            mode: c.mode,
            payload: c
        }));
    }

    async evaluate(proposal) {
        // Stays quiet on other agents' proposals for now.
        return { action: 'ALLOW', reason: 'No optimization domain conflict.' };
    }
}
module.exports = new OptimizationAgent();
