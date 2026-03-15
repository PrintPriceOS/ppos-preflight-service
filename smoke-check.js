/**
 * Smoke Test: ppos-preflight-service Integration
 */
const path = require('path');
const fs = require('fs');

async function test() {
    console.log('--- TESTING: ppos-preflight-service ---');

    // 1. Check if engine is reachable via relative path (validating workspace layout)
    const enginePath = path.resolve(__dirname, '../ppos-preflight-engine/index.js');
    if (fs.existsSync(enginePath)) {
        console.log('PASS: Engine reachable at', enginePath);
    } else {
        console.error('FAIL: Engine NOT found at expected relative path');
        process.exit(1);
    }

    // 2. Load Service modules
    try {
        const PreflightService = require('./services/PreflightService');
        const service = new PreflightService(); // No deps for simple load test
        console.log('PASS: PreflightService loaded');
    } catch (e) {
        console.error('FAIL: PreflightService load error:', e.message);
        process.exit(1);
    }

    // 3. Check Routes
    try {
        const routes = require('./routes/preflight');
        console.log('PASS: Preflight routes loaded');
    } catch (e) {
        console.error('FAIL: Routes load error:', e.message);
        process.exit(1);
    }

    console.log('DONE: ppos-preflight-service module graph is valid.');
}

test();
