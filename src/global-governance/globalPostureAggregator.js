/**
 * Global Posture Aggregator
 * Synthesizes network-wide health, risk, and autonomy metrics WITHOUT
 * centralizing raw tenant payloads.
 * Phase 16 — Global Control Plane & Sovereign Network Governance
 */

const registry = require('../federation/instanceRegistry');

class GlobalPostureAggregator {
    /**
     * Builds a real-time snapshot of the entire sovereign network.
     */
    buildNetworkSnapshot() {
        const topology = registry.getAll();
        
        const summary = {
            timestamp: new Date().toISOString(),
            totalNodes: topology.length,
            degradedRegions: [],
            guardedRegions: [], // regions currently locked down intensely
            autonomyRestrictedRegions: [], // regions that rejected global autonomy
            riskHotspots: 0
        };

        for (const node of topology) {
            if (node.status === 'DEGRADED') {
                summary.degradedRegions.push(node.instanceId);
                summary.riskHotspots += 1;
            }
            if (node.status === 'ISOLATED') {
                summary.autonomyRestrictedRegions.push(node.instanceId);
            }
        }

        return summary;
    }
}

module.exports = new GlobalPostureAggregator();
