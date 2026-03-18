/**
 * Federation Signal Ingestor
 * Listens for incoming capacity & risk signals from sister regions.
 * Phase 15 — Distributed Regional Federation
 */

const registry = require('./instanceRegistry');

class SignalIngestor {
    constructor() {
        this.receivedSignals = [];
    }

    /**
     * Receives and validates incoming federation intent.
     * Crucially: Drops signals from unregistered or un-trusted instances immediately.
     */
    receive(signalRaw) {
        const { signalType, origin, payload, federation_request_id } = signalRaw;
        
        console.log(`[SIGNAL-INGESTOR] Inbound ${signalType} from [${origin}]...`);
        
        const peer = registry.get(origin);
        if (!peer) {
            console.log(`[SIGNAL-INGESTOR] Dropped. Unrecognized Origin: ${origin}`);
            return { accepted: false, reason: 'UNRECOGNIZED_ORIGIN' };
        }

        if (peer.trustLevel === 'LOW' || peer.status === 'ISOLATED') {
            console.log(`[SIGNAL-INGESTOR] Dropped. Origin lacks trust quota: ${origin}`);
            return { accepted: false, reason: 'INSUFFICIENT_TRUST' };
        }

        // Successfully parsed external metadata context
        this.receivedSignals.push(signalRaw);
        return { accepted: true, receipt: federation_request_id };
    }

    getLatestSignals() {
        return this.receivedSignals;
    }
}

module.exports = new SignalIngestor();
