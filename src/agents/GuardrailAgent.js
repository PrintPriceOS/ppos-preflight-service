const AgentBase = require('./agentBase');

/**
 * Guardrail Agent
 * The system's primary safety enforcer. Evaluates proposals
 * emitted by siblings and hard-blocks them if they violate rules.
 */
class GuardrailAgent extends AgentBase {
    constructor() {
        super('agent_gr_01', 'GuardrailAgent');
    }

    async propose(input) {
        // Guardrails are predominantly reactive evaluators
        return [];
    }

    async evaluate(proposal) {
        // Check structural bounds
        if (proposal.action === 'CONCURRENCY_TUNE') {
            const step = proposal.payload?.proposedChange?.step || 0;
            if (Math.abs(step) > 0.5) {
                return { action: 'BLOCK', reason: `GUARDRAIL_VIOLATION: Concurrency step ${step} exceeds max safe threshold (0.5)` };
            }
        }
        
        if (proposal.action === 'RETRY_TUNE') {
            const backoff = proposal.payload?.proposedChange?.backoff || 0;
            if (backoff > 10000) {
                return { action: 'BLOCK', reason: `GUARDRAIL_VIOLATION: Retry backoff ${backoff}ms exceeds 10s maximum limit` };
            }
        }

        return { action: 'ALLOW', reason: 'Guardrail topology checks passed.' };
    }
}
module.exports = new GuardrailAgent();
