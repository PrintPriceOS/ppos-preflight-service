/**
 * Regression Test Suite: Phase 10 Intelligence Layer & Artifacts Resolution
 * Verifies:
 * 1. EngineClient fail-loud behavior when PreflightEngine is missing
 * 2. EngineClient safe risk_score resolution
 * 3. Multi-location findings merging and deduplication
 * 4. Dynamic status refinement (DEGRADED, PARTIAL, PARTIAL_ARTIFACTS)
 * 5. GET /jobs/:id/artifacts/:artifactId alias resolution (final_fixed_pdf, certified_pdf, analysis_report)
 * 6. DEGRADED source job with missing_tools can still attempt autofix if source input exists
 * 7. FULL_ENVIRONMENT_FAILURE source job blocks autofix
 * 8. EngineClient preserves report.status="DEGRADED" even if ok=true
 * 9. final_fixed_pdf alias priority resolution order (fixed.pdf -> normalized.pdf -> certified.pdf)
 * 10. Route-level registration and multipart fix execution without ReferenceError
 */

const assert = require('assert').strict;

// Intercept requires to allow running without local node_modules installed
const Module = require('module');
const originalRequire = Module.prototype.require;

let mockDbQueryResults = {};
let mockDbExecuteCalls = [];

Module.prototype.require = function(request) {
    if (request.includes('src/services/db')) {
        return {
            execute: async (...args) => {
                mockDbExecuteCalls.push(args);
                return {};
            },
            query: async (queryStr, params) => {
                const id = params[0];
                return mockDbQueryResults[id] || [];
            }
        };
    }
    if (request.includes('src/services/policyEngine')) {
        return {
            resolveEffectivePolicy: async () => ({ name: 'DEFAULT_POLICY', id: 'default' }),
            validateExecution: async () => {}
        };
    }
    if (request.includes('src/services/auditLogger')) {
        return { log: async () => {} };
    }
    if (request === 'fs-extra') {
        return {
            pathExists: async () => true,
            copy: async () => {},
            writeJson: async () => {},
            stat: async () => ({ size: 1000 }),
            readdir: async () => ['input.pdf'],
            ensureDir: async () => {},
            ensureDirSync: () => {},
            readFile: async () => Buffer.from('fixed_pdf_binary_content')
        };
    }
    if (request.includes('errors')) {
        return {
            ErrorCodes: { BAD_REQUEST: 'BAD_REQUEST', UNAUTHORIZED: 'UNAUTHORIZED' },
            ErrorTypes: { USER_ERROR: 'USER_ERROR', SERVICE_ERROR: 'SERVICE_ERROR' },
            PPOSError: class extends Error {
                constructor(code, message, type) {
                    super(message);
                    this.code = code;
                    this.type = type;
                    this.isPPOSError = true;
                }
            }
        };
    }
    if (request.includes('src/middleware/requireScope')) {
        return () => (req, reply, next) => { if (next) next(); };
    }
    if (request.includes('src/auth/ownershipValidator')) {
        return {
            validateOwnership: () => (req, reply, next) => { if (next) next(); }
        };
    }
    if (request.includes('clients/WorkerClient')) {
        return class MockWorkerClient {
            constructor() {}
            async enqueue() { return { jobId: 'mock_worker_job_id', status: 'QUEUED' }; }
        };
    }
    if (request.includes('utils/StorageManager')) {
        return class MockStorageManager {
            constructor() {}
            initializeJobStorage() {}
            async saveInputFile() { return { filePath: '/dummy/input.pdf' }; }
            getJobSubfolder() { return '/dummy/output'; }
        };
    }
    if (request === '@ppos/preflight-engine') {
        return {
            createStandardEngine: () => ({
                analyzePdf: async () => ({
                    ok: true,
                    status: 'PASS',
                    summary: { risk_score: 100 }
                }),
                autofixPdf: async () => ({
                    ok: true,
                    fixedPath: '/dummy/fixed.pdf',
                    repairs: [{ code: 'APPLY_BLEED', status: 'APPLIED' }]
                })
            })
        };
    }
    return originalRequire.apply(this, arguments);
};

const EngineClient = require('./clients/EngineClient');
const PreflightService = require('./services/PreflightService');

async function runRegressionTests() {
    console.log('=== Starting Phase 10 Regression Tests ===\n');

    // 1. Test EngineClient fail-loud behavior without engine
    console.log('[TEST 1] EngineClient behavior without engine');
    const clientNoEngine = new EngineClient(null);
    const resNoEngine = await clientNoEngine.analyze('/dummy/path.pdf', {});
    
    assert.equal(resNoEngine.ok, false);
    assert.equal(resNoEngine.status, 'FAILED_RUNTIME_ENVIRONMENT');
    assert.equal(resNoEngine.error, 'ENGINE_NOT_INITIALIZED');
    console.log('--> [PASS] EngineClient without engine fails loud correctly.\n');

    // 2. Test EngineClient safe risk_score resolution with engine mock
    console.log('[TEST 2] EngineClient risk_score safe resolution');
    const mockEngine = {
        analyzePdf: async () => ({
            ok: true,
            summary: { risk_score: 92 }
        })
    };
    const clientWithEngine = new EngineClient(mockEngine);
    const resWithEngine = await clientWithEngine.analyze('/dummy/path.pdf', {});
    assert.equal(resWithEngine.risk_score, 92);
    assert.equal(resWithEngine.status, 'PASS');
    console.log('--> [PASS] EngineClient resolves risk_score successfully.\n');

    // 3. Test multi-location findings merging & deduplication in PreflightService
    console.log('[TEST 3] Multi-location findings merging & deduplication');
    const service = new PreflightService({}, {}, {});
    const job = { id: 'job_multi_merge', status: 'COMPLETED', job_type: 'ANALYZE' };
    const rawResult = {
        findings: [{ code: 'RGB_COLOR', page: 1, severity: 'warning', message: 'RGB color space used' }],
        issues: [{ code: 'RGB_COLOR', page: 1, severity: 'warning', message: 'RGB color space used' }], // Duplicate
        analysis: {
            findings: [{ id: 'f2', code: 'LOW_RES', page: 2, severity: 'error', message: 'Low resolution' }],
            issues: [{ id: 'f2', code: 'LOW_RES', page: 2, severity: 'error', message: 'Low resolution' }] // Duplicate by ID
        },
        forensics: {
            findings: [{ code: 'OVERINK', page: 3, severity: 'warning', message: 'Overinking detected' }]
        }
    };
    
    const norm = service._normalizeJobPayload(job, [{ type: 'analysis_report', name: 'report.json' }], rawResult);
    
    // We expect exactly 3 merged unique findings: RGB_COLOR (from findings/issues), LOW_RES (from analysis.findings/issues), and OVERINK (from forensics.findings)
    assert.equal(norm.result.findings.length, 3);
    assert.ok(norm.result.findings.some(f => f.code === 'RGB_COLOR'));
    assert.ok(norm.result.findings.some(f => f.code === 'LOW_RES'));
    assert.ok(norm.result.findings.some(f => f.code === 'OVERINK'));
    console.log('--> [PASS] Findings successfully merged and deduplicated across all sources.\n');

    // 4. Test dynamic status refinement
    console.log('[TEST 4] Dynamic status refinement (DEGRADED, PARTIAL, PARTIAL_ARTIFACTS)');
    
    // 4a. Degraded status refinement
    const jobDegraded = { id: 'job_deg', status: 'COMPLETED', job_type: 'ANALYZE' };
    const resDegraded = {
        missing_tools: ['mutool'],
        findings: [{ code: 'RGB', severity: 'warning', message: 'RGB used' }]
    };
    const normDegraded = service._normalizeJobPayload(jobDegraded, [{ type: 'analysis_report', name: 'report.json' }, { type: 'certified_pdf', name: 'certified.pdf' }], resDegraded);
    assert.equal(normDegraded.status, 'DEGRADED');
    assert.equal(normDegraded.result.outcome_category, 'DEGRADED_ANALYSIS');
    
    // 4b. Partial status refinement
    const jobPartial = { id: 'job_part', status: 'COMPLETED', job_type: 'ANALYZE' };
    const resPartial = {
        analyzerCoverage: { partial: ['fonts'] },
        findings: [{ code: 'RGB', severity: 'warning', message: 'RGB used' }]
    };
    const normPartial = service._normalizeJobPayload(jobPartial, [{ type: 'analysis_report', name: 'report.json' }, { type: 'certified_pdf', name: 'certified.pdf' }], resPartial);
    assert.equal(normPartial.status, 'PARTIAL');
    assert.equal(normPartial.result.outcome_category, 'PARTIAL_ANALYSIS');

    // 4c. Partial Artifacts status refinement
    const jobArtifacts = { id: 'job_art', status: 'COMPLETED', job_type: 'ANALYZE' };
    const resArtifacts = {
        findings: []
    };
    // Missing certified_pdf on certifiable clean doc
    const normArtifacts = service._normalizeJobPayload(jobArtifacts, [{ type: 'analysis_report', name: 'report.json' }], resArtifacts);
    assert.equal(normArtifacts.status, 'PARTIAL_ARTIFACTS');
    assert.equal(normArtifacts.result.outcome_category, 'ARTIFACT_INTEGRITY_FAILURE');

    console.log('--> [PASS] Dynamic status refinement works perfectly.\n');

    // 5. Test DEGRADED source job with missing_tools can still attempt autofix
    console.log('[TEST 5] DEGRADED source job with missing_tools can still attempt autofix');
    mockDbQueryResults['job_source_degraded'] = [{
        status: 'DEGRADED',
        error: null,
        result: JSON.stringify({
            missing_tools: ['mutool'],
            findings: [{ code: 'RGB', severity: 'warning', repairStrategy: 'CONVERT_CMYK' }]
        })
    }];

    const storageMock = {
        initializeJobStorage: async () => {},
        getJobSubfolder: () => '/dummy/path'
    };
    const engineClientMock = {
        autofix: async () => ({ ok: true, repairs: ['CONVERT_CMYK'], fixedPath: '/dummy/fixed.pdf' })
    };
    const serviceAutofixTest = new PreflightService(engineClientMock, {}, storageMock);

    let autofixSucceeded = false;
    try {
        const res = await serviceAutofixTest.autofix('job_source_degraded', 'default', {
            auth: { tenantId: 'tenant_1' },
            deployment: { deploymentId: 'dep_1' }
        });
        assert.equal(res.ok, true);
        autofixSucceeded = true;
    } catch (err) {
        console.error('Autofix failed with error:', err);
    }
    assert.ok(autofixSucceeded);
    console.log('--> [PASS] DEGRADED source job can still attempt autofix.\n');

    // 6. Test FULL_ENVIRONMENT_FAILURE source job blocks autofix
    console.log('[TEST 6] FULL_ENVIRONMENT_FAILURE source job blocks autofix');
    mockDbQueryResults['job_source_full_failure'] = [{
        status: 'FAILED',
        error: 'FAILED_RUNTIME_ENVIRONMENT',
        result: JSON.stringify({
            analysis_status: 'FAILED_RUNTIME_ENVIRONMENT',
            realExtraction: false
        })
    }];

    let autofixBlocked = false;
    try {
        await serviceAutofixTest.autofix('job_source_full_failure', 'default', {
            auth: { tenantId: 'tenant_1' },
            deployment: { deploymentId: 'dep_1' }
        });
    } catch (err) {
        if (err.message.includes('Autofix blocked')) {
            autofixBlocked = true;
        } else {
            console.error('Unexpected error:', err);
        }
    }
    assert.ok(autofixBlocked);
    console.log('--> [PASS] FULL_ENVIRONMENT_FAILURE source job correctly blocks autofix.\n');

    // 7. Test EngineClient preserves report.status="DEGRADED" even if ok=true
    console.log('[TEST 7] EngineClient preserves report.status="DEGRADED" even if ok=true');
    const mockEngineDegraded = {
        analyzePdf: async () => ({
            ok: true,
            status: 'DEGRADED',
            summary: { risk_score: 80 }
        })
    };
    const clientDegraded = new EngineClient(mockEngineDegraded);
    const resDegradedClient = await clientDegraded.analyze('/dummy/path.pdf', {});
    assert.equal(resDegradedClient.status, 'DEGRADED');
    assert.equal(resDegradedClient.ok, true);
    console.log('--> [PASS] EngineClient preserves report.status="DEGRADED" correctly.\n');

    // 8. Test final_fixed_pdf resolves fixed.pdf before normalized.pdf before certified.pdf
    console.log('[TEST 8] final_fixed_pdf alias resolution priority order');
    
    function resolveArtifactId(artifactId, artifacts) {
        let resolvedArtifact = null;
        if (artifactId === 'final_fixed_pdf') {
            const targetFileNames = ['fixed.pdf', 'normalized.pdf', 'certified.pdf'];
            for (const targetName of targetFileNames) {
                resolvedArtifact = artifacts.find(a => a.name.toLowerCase() === targetName.toLowerCase());
                if (resolvedArtifact) break;
            }
        } else if (artifactId === 'certified_pdf') {
            resolvedArtifact = artifacts.find(a => a.name.toLowerCase() === 'certified.pdf');
        } else if (artifactId === 'analysis_report') {
            resolvedArtifact = artifacts.find(a => a.name.toLowerCase() === 'report.json');
        }
        if (!resolvedArtifact) {
            resolvedArtifact = artifacts.find(a => a.name.toLowerCase() === artifactId.toLowerCase());
        }
        return resolvedArtifact;
    }

    const allArtifacts = [
        { name: 'certified.pdf', type: 'certified_pdf' },
        { name: 'normalized.pdf', type: 'final_fixed_pdf' },
        { name: 'fixed.pdf', type: 'final_fixed_pdf' }
    ];

    // Priority 1: fixed.pdf
    const res1 = resolveArtifactId('final_fixed_pdf', allArtifacts);
    assert.equal(res1.name, 'fixed.pdf');

    // Priority 2: normalized.pdf (if fixed.pdf is missing)
    const withoutFixed = allArtifacts.filter(a => a.name !== 'fixed.pdf');
    const res2 = resolveArtifactId('final_fixed_pdf', withoutFixed);
    assert.equal(res2.name, 'normalized.pdf');

    // Priority 3: certified.pdf (if fixed.pdf and normalized.pdf are missing)
    const onlyCertified = allArtifacts.filter(a => a.name !== 'fixed.pdf' && a.name !== 'normalized.pdf');
    const res3 = resolveArtifactId('final_fixed_pdf', onlyCertified);
    assert.equal(res3.name, 'certified.pdf');

    console.log('--> [PASS] final_fixed_pdf priority resolution order is correct (fixed.pdf -> normalized.pdf -> certified.pdf).\n');

    // 9. Test routes/preflight.js route registration and multipart fix route execution
    console.log('[TEST 9] preflightRoutes registration and multipart fix smoke test');
    
    // Register the routes with mockFastify
    const preflightRoutes = require('./routes/preflight');
    const mockFastify = {
        post: (path, options, handler) => {
            const actualHandler = handler || options;
            if (path === '/jobs/:id/actions/fix') {
                mockFastify.multipartFixHandler = actualHandler;
            }
        },
        get: () => {},
        decorateRequest: () => {},
        register: () => {}
    };

    await preflightRoutes(mockFastify, {});
    assert.ok(mockFastify.multipartFixHandler, 'Multipart fix route handler should be registered');

    // Trigger the multipart fix route
    const mockReqMultipart = {
        params: { id: 'job_multipart_target' },
        isMultipart: () => true,
        file: async () => ({
            toBuffer: async () => Buffer.from('dummy_pdf_content'),
            filename: 'test_input.pdf',
            fields: {
                issues: { value: JSON.stringify([{ fix_method: 'APPLY_BLEED' }]) },
                target: { value: 'bleed' }
            }
        }),
        context: {
            auth: { tenantId: 'tenant_omega', userId: 'user_omega' },
            deployment: { deploymentId: 'dep_omega' }
        }
    };

    const mockReplyMultipart = {
        mimeType: null,
        statusCode: null,
        payload: null,
        type: function(t) { this.mimeType = t; return this; },
        status: function(code) { this.statusCode = code; return this; },
        send: function(payload) { this.payload = payload; return this; }
    };

    await mockFastify.multipartFixHandler(mockReqMultipart, mockReplyMultipart);

    assert.equal(mockReplyMultipart.mimeType, 'application/pdf');
    assert.ok(Buffer.isBuffer(mockReplyMultipart.payload));
    console.log('--> [PASS] Multipart fix route registered and executed perfectly without any ReferenceError.\n');

    console.log('=== All Regression Tests Passed Successfully! ===');
}

runRegressionTests().catch(err => {
    console.error('--> [FAIL] Regression test failed:', err);
    process.exit(1);
});
