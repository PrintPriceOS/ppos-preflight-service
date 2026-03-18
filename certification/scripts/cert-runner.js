/**
 * PrintPrice OS — Certification Runner (Batch 1)
 * 
 * Aggregates and executes all verification suites for governance, isolation, and security.
 * Rebuilds trust in the enterprise-grade baseline (v2.0.0).
 */
const { runAuthSuite } = require('../suites/auth.cert');
const { runAuthzSuite } = require('../suites/authz.cert');
const { runIsolationSuite } = require('../suites/isolation.cert');
const { runGovernanceSuite } = require('../suites/governance.cert');

async function main() {
    console.log('====================================================================');
    console.log('PRINTPRICE OS — Enterprise Certification Batch 1 (' + new Date().toISOString() + ')');
    console.log('====================================================================');

    const results = [];

    // 1. Isolation Verification
    results.push(await runIsolationSuite());

    // 2. Authentication Verification
    results.push(await runAuthSuite());

    // 3. Authorization & Governance Verification
    results.push(await runAuthzSuite());

    // 4. Governance Enforcement Verification
    results.push(await runGovernanceSuite());

    // --- Final Report ---
    console.log('\n====================================================================');
    console.log('CERTIFICATION FINAL REPORT');
    console.log('====================================================================');
    let totalPasses = 0, totalTests = 0;
    results.forEach(r => {
        totalPasses += r.passes;
        totalTests += r.total;
    });

    const status = totalPasses === totalTests ? '🌟 CERTIFIED (Level 1 Foundation)' : '⚠️ FAILED (Non-Compliant)';
    console.log(`Status:  ${status}`);
    console.log(`Summary: ${totalPasses}/${totalTests} tests passed`);
    console.log('====================================================================\n');

    process.exit(totalPasses === totalTests ? 0 : 1);
}

main().catch(err => {
    console.error('[CRITICAL] Certification Failure:', err.message);
    process.exit(1);
});
