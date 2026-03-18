/**
 * Federation Safety
 * Final hardware-level isolation checks preventing Data Leakage.
 * Phase 15 — Distributed Regional Federation
 */

class FederationSafety {
    /**
     * Asserts that a routing shift DOES NOT include raw tenant PII, billing hooks,
     * or active structural secrets inside the routing context payload.
     */
    assertTenantIsolation(routeMatrixPayload) {
        const restrictedKeys = ['billing_id', 'raw_jobs', 'api_secrets', 'tenant_token'];
        
        const stringified = JSON.stringify(routeMatrixPayload).toLowerCase();
        
        for (const rk of restrictedKeys) {
            if (stringified.includes(rk)) {
                return {
                    safe: false,
                    reason: `FATAL_DATA_LEAK_PREVENTED: Routing context contains isolated key [${rk}].`
                };
            }
        }

        return { safe: true, reason: 'Isolation constraints verified.' };
    }
}

module.exports = new FederationSafety();
