/**
 * Service-level Smoke Test: Preflight Policy Catalog
 * Validates the internal service logic without live HTTP or Database.
 */
const Module = require('module');
const originalRequire = Module.prototype.require;

// PHASE 10: Precise Module Mocks (Service Isolation)
Module.prototype.require = function(id) {
    const mocks = {
        '../src/services/db': {
            query: async () => [],
            execute: async () => []
        },
        '../src/services/policyEngine': {
            resolveEffectivePolicy: async () => ({})
        },
        '../src/services/auditLogger': {
            log: async () => {}
        },
        'mysql2/promise': { createPool: () => ({}) },
        'fs-extra': {
            pathExists: async () => true,
            readdir: async () => [],
            ensureDir: async () => {}
        }
    };

    if (mocks[id]) {
        return mocks[id];
    }
    return originalRequire.apply(this, arguments);
};

const PreflightService = require('./services/PreflightService');

async function runServiceSmokeTest() {
    console.log('--- STARTING: ppos-preflight-service smoke test ---');
    
    // Instantiate with mock deps
    const service = new PreflightService({}, {}, {}); 
    
    try {
        const response = await service.getPolicies({ auth: { tenantId: 'test-tenant' } });
        
        // 1. Validate Response Shape
        if (!response?.policies || !Array.isArray(response.policies)) {
            throw new Error(`Invalid response shape: expected { policies: [...] } but got ${JSON.stringify(response)}`);
        }

        const actualIds = response.policies.map(p => p.id);
        const requiredIds = [
            'OFFSET_MODERN_COATED',
            'OFFSET_MODERN_UNCOATED',
            'OFFSET_LEGACY_COATED',
            'OFFSET_LEGACY_UNCOATED',
            'US_COATED_GRACOL',
            'US_WEB_SWOP',
            'NEWSPAPER',
            'DIGITAL_RGB'
        ];

        // 2. Validate IDs and Rules Object
        for (const id of requiredIds) {
            const policy = response.policies.find(p => p.id === id);
            if (!policy) {
                throw new Error(`FAIL: Missing required policy ID: ${id}`);
            }
            if (!policy.rules || typeof policy.rules !== 'object') {
                throw new Error(`FAIL: Policy ${id} missing rules object.`);
            }
        }

        console.log(`PASS: Received ${response.policies.length} policies.`);
        console.log(`PASS: Found all ${requiredIds.length} required canonical policy IDs.`);
        console.log('DONE: service-level smoke test passed.');
        
    } catch (e) {
        console.error('FATAL:', e.message);
        process.exit(1);
    }
}

runServiceSmokeTest();
