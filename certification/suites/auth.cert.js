const certUtils = require('../scripts/cert-utils');
const { generateToken } = require('../../src/auth/generateToken');

const VALID_TOKEN = generateToken({ userId: 'tester', tenantId: 'tenant-a', role: 'admin', scopes: ['*'] });
const EXPIRED_TOKEN = generateToken({ userId: 'tester', tenantId: 'tenant-a', role: 'admin' }, '-1h');
const INVALID_SIGNATURE = VALID_TOKEN.slice(0, -5) + 'xxxxx';

/**
 * Certification: Authentication
 * Ensures only users with valid, signed tokens can access the platform.
 */
async function runAuthSuite() {
    console.log('\n--- SUITE: AUTHENTICATION ---');
    let passes = 0, total = 0;

    // 1. Valid JWT
    total++;
    const res1 = await certUtils.get('/health', VALID_TOKEN);
    if (res1.status === 200) {
        certUtils.report('Valid JWT Access', true, 200, 200);
        passes++;
    } else {
        certUtils.report('Valid JWT Access', false, 200, res1.status);
    }

    // 2. Missing JWT
    total++;
    const res2 = await certUtils.get('/health');
    // Health is public in some apps, check a protected route
    const res2p = await certUtils.get('/preflight/status/123');
    if (res2p.status === 401) {
        certUtils.report('Missing JWT Protection', true, 401, 401);
        passes++;
    } else {
        certUtils.report('Missing JWT Protection', false, 401, res2p.status);
    }

    // 3. Invalid Signature
    total++;
    const res3 = await certUtils.get('/health', INVALID_SIGNATURE);
    if (res3.status === 401) {
        certUtils.report('Invalid Signature Protection', true, 401, 401);
        passes++;
    } else {
        certUtils.report('Invalid Signature Protection', false, 401, res3.status);
    }

    // 4. Expired JWT
    total++;
    const res4 = await certUtils.get('/health', EXPIRED_TOKEN);
    if (res4.status === 401) {
        certUtils.report('Expired JWT Protection', true, 401, 401);
        passes++;
    } else {
        certUtils.report('Expired JWT Protection', false, 401, res4.status);
    }

    return { passes, total };
}

module.exports = { runAuthSuite };
