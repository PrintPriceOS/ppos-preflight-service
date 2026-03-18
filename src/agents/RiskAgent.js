const AgentBase = require('./agentBase');

/**
 * Risk Agent
 * Observes threat indicators and initiates high-level mitigation proposals.
 */
class RiskAgent extends AgentBase {
    constructor() {
        super('agent_risk_01', 'RiskAgent');
    }

    async propose(input) {
        const props = [];
        if (input.tenantRisks) {
            input.tenantRisks.forEach(risk => {
                if (risk.riskScore >= 90) {
                    props.push({
                        id: `risk_mitigation_${Date.now()}_${risk.tenantId}`,
                        agentType: this.agentType,
                        action: 'MITIGATE_RISK',
                        targetId: risk.tenantId,
                        mode: 'BOUNDED_AUTO',
                        payload: { riskScore: risk.riskScore }
                    });
                }
            });
        }
        return props;
    }

    async evaluate(proposal) {
        return { action: 'ALLOW', reason: 'Risk tolerances acceptable.' };
    }
}
module.exports = new RiskAgent();
