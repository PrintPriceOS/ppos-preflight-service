/**
 * PrintPrice OS — Multi-Tenant Load Simulator
 * 
 * Verifies that the governance engine handles high parallel load across independent tenants.
 */
const { generateTestTokens } = require('../config/tenants.config');
const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:8001/api';
const tokens = generateTestTokens();

// Simulation parameters
const CONCURRENT_TENANTS = 3;
const REQUESTS_PER_TENANT = 5;

// Mock job upload
async function sendJob(token, tenantId) {
    try {
        const response = await axios.post(`${BASE_URL}/preflight/analyze`, { 
            name: `${tenantId}-job-${Date.now()}` 
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return { success: true, status: response.status, tenantId };
    } catch (err) {
        return { success: false, status: err.response?.status, tenantId, error: err.message };
    }
}

async function runSimulation() {
    console.log(`\n--- LOAD SIMULATION: ${CONCURRENT_TENANTS} Parallel Tenants ---`);
    console.log(`Each tenant will send ${REQUESTS_PER_TENANT} jobs sequentially.\n`);

    const tenants = [
        { id: 'tenant-a', token: tokens.tenant_A.member },
        { id: 'tenant-b', token: tokens.tenant_B.member },
        { id: 'ppos-sup', token: tokens.system.provider_operator }
    ];

    const tasks = tenants.slice(0, CONCURRENT_TENANTS).map(async (t) => {
        const results = [];
        for (let i = 0; i < REQUESTS_PER_TENANT; i++) {
            results.push(await sendJob(t.token, t.id));
        }
        return { tenant: t.id, results };
    });

    const finalResults = await Promise.all(tasks);

    console.log('--- SIMULATION RESULTS ---');
    finalResults.forEach(r => {
        const ok = r.results.filter(res => res.status === 200).length;
        const blocked = r.results.filter(res => res.status === 403 || res.status === 429).length;
        console.log(`Tenant ${r.tenant}: ${ok} Success / ${blocked} Governance Blocks`);
    });
}

runSimulation().catch(console.error);
