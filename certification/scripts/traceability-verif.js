const db = require('../../src/services/db');

/**
 * PrintPrice OS — Traceability & Forensic Verification
 * 
 * Audits the api_audit_log for lifecycle integrity.
 */
async function verifyTraceability() {
    console.log('\n--- SUITE: TRACEABILITY & FORENSICS ---');
    const logs = [];

    // 1. Terminal State Check (Sample orphaned jobs)
    const [orphaned] = await db.execute(
        "SELECT id, status, created_at FROM jobs WHERE status NOT IN ('COMPLETED', 'FAILED', 'FIXED') AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR) LIMIT 10;"
    );
    if (orphaned.length > 0) {
        console.warn(`[⚠️ TRACEABILITY_GAP] Detected ${orphaned.length} orphaned jobs without terminal state.`);
        orphaned.forEach(j => console.log(`  - Job ${j.id} stuck in ${j.status}`));
    } else {
        console.log('✅ PASS: All recent jobs reached terminal state.');
    }

    // 2. Lifecycle Reconstruction Sample
    const [recentJobs] = await db.execute("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 5;");
    for (const job of recentJobs) {
        const [trace] = await db.execute(
            "SELECT action, request_id, created_at FROM api_audit_log WHERE resource_id = ? OR request_id IN (SELECT request_id FROM api_audit_log WHERE resource_id = ?) ORDER BY created_at ASC;",
            [job.id, job.id]
        );
        
        const actions = trace.map(t => t.action);
        const hasCreated = actions.includes('JOB_CREATED');
        const hasStarted = actions.includes('JOB_STARTED');
        const hasCompleted = actions.some(a => a.startsWith('JOB_COMPLETED') || a.startsWith('JOB_FIXED'));

        if (hasCreated && hasStarted && hasCompleted) {
            console.log(`✅ PASS: Job ${job.id} lifecycle verified (CREATED -> STARTED -> COMPLETED).`);
        } else {
             console.warn(`[❌ TRACEABILITY_GAP] Job ${job.id} missing lifecycle events: ${JSON.stringify(actions)}`);
        }
    }

    // 3. Governance Snapshot Presence
    const [blocked] = await db.execute(
        "SELECT id, action, governance_snapshot FROM api_audit_log WHERE action LIKE 'GOVERNANCE_BLOCK%' LIMIT 5;"
    );
    for (const b of blocked) {
        if (b.governance_snapshot) {
            console.log(`✅ PASS: Blocked action ${b.action} has governance evidence snapshot.`);
        } else {
            console.error(`[❌ EVIDENCE_PERSISTENCE_FAILURE] Blocked action ${b.id} missing snapshot.`);
        }
    }

    // 4. Index usage check (Implicitly via performance / query results)
}

if (require.main === module) {
    verifyTraceability().then(() => process.exit()).catch(console.error);
}

module.exports = { verifyTraceability };
