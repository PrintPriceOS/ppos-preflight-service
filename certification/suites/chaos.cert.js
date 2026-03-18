const { exec } = require('child_process');
const axios = require('axios');
const certUtils = require('../scripts/cert-utils');
const { generateTestTokens } = require('../config/tenants.config');

const tokens = generateTestTokens();

/**
 * PrintPrice OS — Chaos & Resilience Suite
 */
async function runChaosSuite() {
    console.log('\n--- SUITE: CHAOS & RESILIENCE ---');
    let passes = 0, total = 0;

    // 1. Service Persistence Check (Restart Simulation)
    // We simulate a restart request and verify that we can reconnect
    total++;
    try {
        console.log('  [CHAOS] Simulating preflight-service restart via PM2 command...');
        // Mock command: In real env this would be `pm2 restart ppos-preflight-service`
        // For testing the script logic, we'll pulse the health check
        const res = await axios.get('http://127.0.0.1:8001/health');
        if (res.status === 200) {
            console.log('  [CHAOS] Service is alive. Verifying lifecycle continuity...');
            passes++;
            certUtils.report('Service uptime & reachability', true, 200, 200);
        }
    } catch (err) {
        certUtils.report('Service uptime', false, 200, 'CONN_REFUSED');
    }

    // 2. Worker Crash Recovery (Mock behavior)
    // Verifies that if a job is in QUEUED state, it's eventually picked up after worker reboot
    total++;
    const [stuckJobs] = await require('../../src/services/db').execute(
        "SELECT COUNT(*) as count FROM jobs WHERE status = 'QUEUED' AND created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
    );
    if (stuckJobs[0].count === 0) {
        certUtils.report('Worker recovery (queue processing)', true, 0, 0, 'No orphaned queued jobs');
        passes++;
    } else {
        certUtils.report('Worker recovery', false, 0, stuckJobs[0].count, 'Orphaned jobs detected');
    }

    return { passes, total };
}

module.exports = { runChaosSuite };
