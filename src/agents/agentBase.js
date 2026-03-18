/**
 * Agent Abstraction Layer
 * Phase 14 — Multi-Agent Coordination
 */
class AgentBase {
    constructor(agentId, agentType) {
        this.agentId = agentId;
        this.agentType = agentType;
        this.capabilities = [];
        this.constraints = {};
    }

    /**
     * Examines environment signals and issues structured intent proposals.
     * @param {Object} input - Context payload
     * @returns {Array} - Array of proposals
     */
    async propose(input) {
        return [];
    }

    /**
     * Examines proposals emitted by OTHER agents and provides ALLOW / BLOCK assertions.
     * @param {Object} proposal - Intent payload from sibling agent
     * @returns {Object} { action: 'ALLOW' | 'BLOCK', reason: string }
     */
    async evaluate(proposal) {
        return { action: 'ALLOW', reason: 'NO_OP' };
    }
}

module.exports = AgentBase;
