/**
 * Instance Registry
 * Central repository of all known PrintPrice OS peer instances in the federation mesh.
 * Phase 15 — Distributed Regional Federation
 */

class InstanceRegistry {
    constructor() {
        this.instances = new Map();
        
        // Mocking default environment topologies for the OS sandbox
        this.register({
            instanceId: 'local-ops-1',
            region: 'local',
            endpoint: 'http://localhost:3000',
            serviceTier: 'ENTERPRISE',
            status: 'HEALTHY',
            capabilities: ['ROUTING', 'ML_INFERENCE', 'OPTIMIZATION'],
            trustLevel: 'HIGH'
        });

        this.register({
            instanceId: 'eu-west-1',
            region: 'eu-west',
            endpoint: 'https://eu.ppos.internal',
            serviceTier: 'ENTERPRISE',
            status: 'HEALTHY',
            capabilities: ['ROUTING', 'OPTIMIZATION'],
            trustLevel: 'HIGH'
        });

        this.register({
            instanceId: 'us-east-failover',
            region: 'us-east',
            endpoint: 'https://us.ppos.internal',
            serviceTier: 'STANDARD', // Note: Lower tier than Enterprise
            status: 'DEGRADED',
            capabilities: ['ROUTING'],
            trustLevel: 'MEDIUM'
        });
    }

    register(instanceDef) {
        if (!instanceDef.instanceId || !instanceDef.region) {
            throw new Error(`[INSTANCE-REGISTRY] Cannot register node without ID and Region.`);
        }
        
        instanceDef.lastHeartbeat = Date.now();
        this.instances.set(instanceDef.instanceId, instanceDef);
        console.log(`[FEDERATION] Registered Instance: ${instanceDef.instanceId} [${instanceDef.region}]`);
    }

    get(instanceId) {
        return this.instances.get(instanceId);
    }

    getAll() {
        return Array.from(this.instances.values());
    }

    updateStatus(instanceId, newStatus) {
        const inst = this.instances.get(instanceId);
        if (inst) {
            inst.status = newStatus;
            inst.lastHeartbeat = Date.now();
            this.instances.set(instanceId, inst);
        }
    }
}

module.exports = new InstanceRegistry();
