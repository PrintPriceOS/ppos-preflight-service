const path = require('path');
const Module = require('module');

// Mock fs-extra before requiring anything
const mockFs = {
    stat: async () => ({ size: 1024, birthtime: new Date() }),
    pathExists: async () => true,
    readdir: async () => ['dummy.pdf', 'report.json', 'fixed.pdf'],
    copy: async () => {},
    writeJson: async () => {},
    ensureDir: async () => {}
};
const mockMysql = {
    createPool: () => ({
        execute: async () => {},
        query: async () => []
    })
};
const mockFetch = async () => ({ ok: true });

const originalRequire = Module.prototype.require;
Module.prototype.require = function(request) {
    if (request === 'fs-extra') return mockFs;
    if (request === 'mysql2/promise') return mockMysql;
    if (request === 'node-fetch') return mockFetch;
    return originalRequire.apply(this, arguments);
};

const PreflightService = require('../services/PreflightService');
const syncClient = require('../services/ControlPlaneJobSyncClient');

// Stub dependencies
const mockEngine = {
    analyze: async () => {
        return {
            status: 'COMPLETED',
            findings: Array.from({ length: 7 }, (_, i) => ({
                severity: 'warning',
                message: `Test finding ${i}`,
                id: `finding-${i}`
            })),
            summary: {
                issue_count: 7
            }
        };
    },
    autofix: async () => {
        return {
            ok: true,
            fixedPath: 'dummy.pdf',
            repairs: [
                { code: 'REBUILD_TRIMBOX', status: 'APPLIED' },
                { code: 'APPLY_BLEED', status: 'APPLIED', requires_human_review: true },
                { code: 'CONVERT_CMYK', status: 'SKIPPED', destructiveFixRisk: 'HIGH', requires_human_review: true },
                { code: 'INJECT_OUTPUT_INTENT', status: 'APPLIED' }
            ]
        };
    }
};

const mockWorker = {
    enqueue: async () => ({ ok: true, jobId: 'mock-worker-job' })
};

const mockStorage = {
    initializeJobStorage: async () => {},
    saveInputFile: async () => ({ filePath: 'dummy.pdf' }),
    getJobSubfolder: () => 'dummy_dir',
    deleteJobStorage: async () => {}
};

// Stub DB
const mockDb = {
    execute: async () => {},
    query: async () => []
};

// Override DB module
const dbModule = require('../src/services/db');
dbModule.execute = mockDb.execute;
dbModule.query = mockDb.query;

// Spy on syncClient
const originalSyncJob = syncClient.syncJob;
let syncPayloads = [];
syncClient.syncJob = async (payload) => {
    syncPayloads.push(payload);
    return { ok: true };
};

// Stubs removed since they are handled by mockFs

async function run() {
    console.log('--- Running Smoke Test ---');
    const svc = new PreflightService(mockEngine, mockWorker, mockStorage);
    const context = {
        auth: { tenantId: 'test-tenant' },
        deployment: { deploymentId: 'test-dep' }
    };

    console.log('\n1. Test Inline ANALYZE');
    await svc.analyze('stream', 'test.pdf', context);
    const analyzePayload = syncPayloads.shift();
    console.log('Analyze Payload:', JSON.stringify(analyzePayload, null, 2));
    
    if (analyzePayload.findingsCount !== 7 || analyzePayload.issuesCount !== 7) {
        console.error('FAILED: findingsCount/issuesCount mismatch in ANALYZE');
        process.exit(1);
    }

    console.log('\n2. Test Inline AUTOFIX');
    await svc.autofix('job_123', {}, context, { fileSize: 1024 });
    const autofixPayload = syncPayloads.shift();
    console.log('Autofix Payload:', JSON.stringify(autofixPayload, null, 2));

    if (autofixPayload.appliedFixesCount !== 3) {
        console.error('FAILED: appliedFixesCount mismatch in AUTOFIX');
        process.exit(1);
    }
    if (autofixPayload.skippedFixesCount !== 1) {
        console.error('FAILED: skippedFixesCount mismatch in AUTOFIX');
        process.exit(1);
    }
    if (autofixPayload.requiresHumanReview !== true) {
        console.error('FAILED: requiresHumanReview mismatch in AUTOFIX');
        process.exit(1);
    }
    if (autofixPayload.productionCertified !== false) {
        console.error('FAILED: productionCertified mismatch in AUTOFIX');
        process.exit(1);
    }

    console.log('\nSmoke tests passed successfully.');
    process.exit(0);
}

run().catch(err => {
    console.error('Smoke test failed with exception:', err);
    process.exit(1);
});
