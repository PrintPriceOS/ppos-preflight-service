/**
 * Federation Protocol Specification
 * Defines the strict, immutable schema for Inter-Instance Communication (ICC)
 * Phase 15 — Distributed Regional Federation
 */

const SIGNAL_TYPES = [
    'CAPACITY_PRESSURE',
    'REGION_DEGRADED',
    'HIGH_FAILURE_CLUSTER',
    'ROUTING_ADVISORY',
    'POLICY_MISMATCH_WARNING'
];

function buildSignal(type, origin, payload, policyContext = {}) {
    if (!SIGNAL_TYPES.includes(type)) {
        throw new Error(`[FEDERATION-PROTOCOL] Invalid Signal Type: ${type}`);
    }

    if (!origin) {
        throw new Error(`[FEDERATION-PROTOCOL] Missing origin descriptor.`);
    }

    return {
        federation_request_id: `fed_req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        type: 'FEDERATION_SIGNAL',
        signalType: type,
        origin: origin, // e.g., 'eu-west-1'
        payload: payload,
        policyContext: policyContext,
        timestamp: new Date().toISOString()
    };
}

module.exports = {
    SIGNAL_TYPES,
    buildSignal
};
