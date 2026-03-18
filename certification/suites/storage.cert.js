const certUtils = require('../scripts/cert-utils');
const { generateTestTokens } = require('../config/tenants.config');

const tokens = generateTestTokens();

/**
 * Certification: Storage Safety & Attack Surface
 */
async function runStorageSuite() {
    console.log('\n--- SUITE: STORAGE SAFETY & TRAVERSAL ---');
    let passes = 0, total = 0;

    // 1. Path Traversal Attempt
    // Sending a payload or querying a resource with traversal sequences
    total++;
    const res1 = await certUtils.get('/preflight/status/../../etc/passwd', tokens.tenant_A.admin);
    if (res1.status === 401 || res1.status === 403 || res1.status === 404 || res1.status === 400) {
        certUtils.report('Path Traversal protection (../..)', true, 'Rejected/Not Found', res1.status);
        passes++;
    } else {
        certUtils.report('Path Traversal protection', false, 'Blocked', res1.status);
    }

    // 2. Tenant Boundary Escape
    // Trying to access an artifact from another tenant using direct ID guessing 
    // This overlaps with isolation, let's verify if the status route is truly isolated.
    total++;
    const res2 = await certUtils.get('/preflight/status/tenant-b-job-001', tokens.tenant_A.member);
    if (res2.status === 404) {
        certUtils.report('Tenant Boundary Escape protection', true, 404, 404);
        passes++;
    } else {
        certUtils.report('Tenant Boundary Escape', false, 404, res2.status);
    }

    // 3. Storage Path Leakage
    // Check if error message reveals internal paths (e.g. c:/Users/...)
    total++;
    const res3 = await certUtils.get('/preflight/status/invalid@@', tokens.tenant_A.admin);
    const bodyStr = JSON.stringify(res3.data);
    const hasLeakage = /C:\\Users|\\storage\\/i.test(bodyStr);
    if (!hasLeakage) {
        certUtils.report('Internal path leakage protection', true, 'Clean Error', 'Clean Error');
        passes++;
    } else {
        certUtils.report('Internal path leakage', false, 'Clean Error', 'Path revealed in error message');
    }

    return { passes, total };
}

module.exports = { runStorageSuite };
