/**
 * Decision Orchestrator
 * Phase 14 — Multi-Agent Coordination
 */

const conflictResolver = require('./conflictResolver');

class Orchestrator {
    constructor() {
        this.agents = [];
        this.decisionLog = [];
    }

    registerAgent(agent) {
        this.agents.push(agent);
    }

    async runCycle(context) {
        console.log(`\n[ORCHESTRATOR] Starting Arbitration Cycle via ${this.agents.length} bounded Agents.`);
        
        let allProposals = [];
        
        // Phase 1: Generation & Proposals
        for (const agent of this.agents) {
            const props = await agent.propose(context);
            if (props && props.length > 0) {
                console.log(`[ORCHESTRATOR] ${agent.agentType} emitted ${props.length} proposals.`);
                allProposals.push(...props);
                
                props.forEach(p => this.logAudit('AGENT_PROPOSAL_CREATED', agent.agentType, p));
            }
        }

        const outcomes = [];

        // Phase 2: Peer Review & Resolution
        for (const proposal of allProposals) {
            const evaluations = [];
            
            // Siblings scrutinize the intent
            for (const evaluator of this.agents) {
                if (evaluator.agentType !== proposal.agentType) { // Self-exclusion
                    const ev = await evaluator.evaluate(proposal);
                    ev.agentType = evaluator.agentType;
                    evaluations.push(ev);
                    
                    if (ev.action === 'BLOCK') {
                        this.logAudit('AGENT_PROPOSAL_EVALUATED_BLOCK', evaluator.agentType, { proposalId: proposal.id, reason: ev.reason });
                    }
                }
            }

            // Phase 3: Supreme Court Ruling
            const resolution = conflictResolver.resolveConflicts([proposal], evaluations);
            
            if (resolution.resolution === 'BLOCKED') {
                this.logAudit('AGENT_PROPOSAL_BLOCKED', resolution.winningAgent, { proposalId: proposal.id, reason: resolution.reason });
                outcomes.push({ proposalId: proposal.id, status: 'BLOCKED', reason: resolution.reason, executed: false });
            } else if (resolution.resolution === 'APPROVED') {
                this.logAudit('AGENT_PROPOSAL_APPROVED', resolution.winningAgent, { proposalId: proposal.id });
                // We map executed: false pending explicit integration dispatch hook.
                outcomes.push({ proposal: resolution.proposal, status: 'APPROVED', executed: false });
            }
        }

        return { decisions: outcomes };
    }

    logAudit(event, agentType, metadata) {
        console.log(`[AUDIT-AGENT] ${event} | Role: ${agentType} | Context: ${JSON.stringify(metadata)}`);
    }
}

module.exports = new Orchestrator();
