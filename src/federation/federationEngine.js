/**
 * Federation Engine (Core)
 * Orchestrates cross-instance interactions and validates incoming envelopes.
 * Phase 15 — Distributed Regional Federation
 */

const registry = require('./instanceRegistry');

class FederationEngine {
    constructor() {
        this.activeSessions = [];
    }

    /**
     * Determines if the local instance represents the canonical authority
     * for a given tenant context in multi-region overlap scenarios.
     */
    isCanonicalAuthority(tenantId, requiredTier) {
        const local = registry.get('local-ops-1');
        if (!local) return false;
        
        // Simplified check: If we are Enterprise, we assume authority for this sandbox
        if (local.serviceTier === 'ENTERPRISE') return true;
        
        return false;
    }

    /**
     * Finds the best active peer in the registry capable of absorbing traffic.
     */
    findCapablePeer(requestedCapability, currentTier) {
        const peers = registry.getAll().filter(p => p.instanceId !== 'local-ops-1'); // Exclude self
        
        // Must be HEALTHY and possess capability
        const viable = peers.filter(p => p.status === 'HEALTHY' && p.capabilities.includes(requestedCapability));
        
        if (viable.length === 0) return null;
        
        // Prefer matching or higher service tiers
        const tierWeights = { 'BASIC': 1, 'STANDARD': 2, 'ENTERPRISE': 3 };
        const localWeight = tierWeights[currentTier] || 1;
        
        viable.sort((a, b) => (tierWeights[b.serviceTier] || 1) - (tierWeights[a.serviceTier] || 1));
        
        return viable[0]; // Return the most capable partner
    }

    logFederationEvent(eventDef) {
        console.log(`[FEDERATION-BUS] ${eventDef.type} | Target: ${eventDef.target} | Origin: ${eventDef.origin}`);
        this.activeSessions.push(eventDef);
    }
}

module.exports = new FederationEngine();
