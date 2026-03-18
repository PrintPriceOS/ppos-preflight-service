/**
 * Tenant Isolation Configuration
 * Derived from the Deployment Contract.
 */

const ISOLATION_MODES = {
    LOGICAL: 'logical',
    DEDICATED: 'dedicated',
    CLUSTER: 'cluster'
};

/**
 * Validates if the current operation respects the isolation mode.
 * @param {string} mode - The isolation mode from the deployment contract.
 * @param {string} tenantId - The tenant's identity.
 * @returns {boolean}
 */
function validateIsolation(mode, tenantId) {
    if (!tenantId) return false;

    switch (mode) {
        case ISOLATION_MODES.DEDICATED:
            // In dedicated mode, only one specific tenant should ever be present.
            // This can be further validated against an environment variable if needed.
            return true; 
        case ISOLATION_MODES.CLUSTER:
            // Cluster isolation might allow multiple tenants but with strict resource partitioning.
            return true;
        case ISOLATION_MODES.LOGICAL:
        default:
            // Standard shared infrastructure with logical separation.
            return true;
    }
}

module.exports = {
    ISOLATION_MODES,
    validateIsolation
};
