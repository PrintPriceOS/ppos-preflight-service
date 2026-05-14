/**
 * Hardened AUTOFIX Pipeline Integrity & Regression Verification
 * 
 * Asserts that:
 * 1. Requested multiple repair strategies are fully propagated without fallback.
 * 2. Complete forensic context (sourceJobId, fixes, forceBleed, targetProfile) is maintained end-to-end.
 * 3. Contract normalization correctly outputs arrays/counts/object-mappings for downstream consumption.
 */

const path = require('path');

// Intercept module loading to run instantly without external database or network calls
const Module = require('module');
const originalRequire = Module.prototype.require;

let insertedJobRecord = null;
let enqueuedWorkerPayload = null;

Module.prototype.require = function(request) {
    if (request.includes('src/services/db')) {
        return {
            execute: async (sql, params) => {
                if (sql.includes('INSERT INTO jobs')) {
                    insertedJobRecord = {
                        id: params[0],
                        result: JSON.parse(params[7])
                    };
                }
            },
            query: async (sql, params) => {
                if (sql.includes('SELECT result FROM jobs')) {
                    // Simulate source job with a bleed issue to verify no single-strategy fallback occurs when multiple fixes are requested
                    return [{ result: JSON.stringify({ findings: [{ fix_method: 'APPLY_BLEED' }] }) }];
                }
                if (sql.includes('SELECT id, status')) {
                    return [{
                        id: params[0],
                        status: 'COMPLETED',
                        job_type: 'AUTOFIX',
                        progress: 100,
                        result: JSON.stringify({
                            sourceJobId: 'job_src_999',
                            requested_fixes: ['APPLY_BLEED', 'REBUILD_TRIMBOX', 'CONVERT_CMYK', 'INJECT_OUTPUT_INTENT'],
                            fixes: ['APPLY_BLEED', 'REBUILD_TRIMBOX', 'CONVERT_CMYK', 'INJECT_OUTPUT_INTENT'],
                            forceBleed: true,
                            targetProfile: 'FOGRA51',
                            repairs: [{ code: 'APPLY_BLEED', status: 'APPLIED' }],
                            skipped_fixes: ['CONVERT_CMYK'],
                            failed_fixes: [],
                            artifacts: { final_fixed_pdf: 'fixed.pdf' }
                        })
                    }];
                }
                return [];
            }
        };
    }
    if (request.includes('src/services/policyEngine')) {
        return {
            resolveEffectivePolicy: async () => ({ id: 'policy_prod_1', name: 'OFFSET_MODERN_COATED_F51' }),
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
            stat: async () => ({ size: 50 * 1024 * 1024 }) // Trigger async worker path
        };
    }
    if (request.includes('errors')) {
        return { ErrorCodes: {}, ErrorTypes: {}, PPOSError: class extends Error {} };
    }
    return originalRequire.apply(this, arguments);
};

const PreflightService = require('./services/PreflightService');

// Instantiate service with lightweight mock layer
const mockWorkerClient = {
    enqueue: async (type, payload) => {
        enqueuedWorkerPayload = payload;
        return { job_id: 'bullmq_async_100', status: 'QUEUED' };
    }
};

const mockStorage = {
    initializeJobStorage: async () => {},
    getJobSubfolder: () => '/mock/storage/path'
};

const service = new PreflightService({}, mockWorkerClient, mockStorage);
// Stub getJobArtifacts
service.getJobArtifacts = async () => [{ type: 'final_fixed_pdf', name: 'fixed.pdf' }];
// Stub internal path resolution helper
service._resolveCanonicalInputPdf = async () => '/mock/input.pdf';

async function runAutofixPipelineVerification() {
    console.log('=== Starting Hardened AUTOFIX Pipeline Verification ===\n');

    const sourceJobId = 'job_src_999';
    const requestOptions = {
        fixes: ['APPLY_BLEED', 'REBUILD_TRIMBOX', 'CONVERT_CMYK', 'INJECT_OUTPUT_INTENT'],
        requested_fixes: ['APPLY_BLEED', 'REBUILD_TRIMBOX', 'CONVERT_CMYK', 'INJECT_OUTPUT_INTENT'],
        forceBleed: true,
        targetProfile: 'FOGRA51'
    };

    const context = {
        auth: { tenantId: 'tenant_omega_1', userId: 'usr_sec_1' },
        deployment: { deploymentId: 'dep_prod_1' }
    };

    console.log('[TEST 1] Triggering PreflightService.autofix with multiple strategies');
    const response = await service.autofix(sourceJobId, null, context, requestOptions);

    console.log('\n--- Asserting Immediate Response Contract ---');
    console.log(JSON.stringify(response, null, 2));
    const passedResponseContract = 
        response.sourceJobId === sourceJobId &&
        response.targetJobId === response.id &&
        response.type === 'AUTOFIX' &&
        response.forceBleed === true &&
        response.targetProfile === 'FOGRA51' &&
        response.fixes.length === 4;

    if (passedResponseContract) {
        console.log('--> [PASS] Response contract strictly preserves full autofix intent and context.');
    } else {
        console.error('--> [FAIL] Response contract validation failed.');
    }

    console.log('\n--- Asserting Initial Job Registry Record ---');
    console.log(JSON.stringify(insertedJobRecord, null, 2));
    const passedJobRecord =
        insertedJobRecord &&
        insertedJobRecord.result.sourceJobId === sourceJobId &&
        insertedJobRecord.result.forceBleed === true &&
        insertedJobRecord.result.targetProfile === 'FOGRA51' &&
        insertedJobRecord.result.requested_fixes.length === 4;

    if (passedJobRecord) {
        console.log('--> [PASS] Initial job record correctly maps full array strategies without truncation.');
    } else {
        console.error('--> [FAIL] Job record integrity check failed.');
    }

    console.log('\n--- Asserting Queued Worker Payload Integrity ---');
    console.log(JSON.stringify(enqueuedWorkerPayload, null, 2));
    const passedWorkerPayload =
        enqueuedWorkerPayload &&
        enqueuedWorkerPayload.type === 'AUTOFIX' &&
        enqueuedWorkerPayload.sourceJobId === sourceJobId &&
        enqueuedWorkerPayload.forceBleed === true &&
        enqueuedWorkerPayload.targetProfile === 'FOGRA51' &&
        enqueuedWorkerPayload.requested_fixes.length === 4 &&
        enqueuedWorkerPayload.fixes.length === 4 &&
        enqueuedWorkerPayload.input.specs.options.type === 'composite'; // Verified no fallback to single 'bleed' type occurred

    if (passedWorkerPayload) {
        console.log('--> [PASS] Worker queued payload perfectly adheres to the top-level V2 root fields contract.');
    } else {
        console.error('--> [FAIL] Worker payload structure is incorrect.');
    }

    console.log('\n[TEST 2] Polling Status Verification (GET /api/preflight/jobs/:fixJobId)');
    const statusPayload = await service.getJobStatus(response.id, context);
    console.log('\n--- Asserting Polled Status Payload Mapping ---');
    console.log(JSON.stringify(statusPayload, null, 2));

    const passedStatusPolling =
        statusPayload &&
        statusPayload.sourceJobId === sourceJobId &&
        statusPayload.type === 'AUTOFIX' &&
        statusPayload.repairs && statusPayload.repairs.length === 1 &&
        statusPayload.requested_fixes && statusPayload.requested_fixes.length === 4 &&
        statusPayload.skipped_fixes && statusPayload.skipped_fixes.length === 1 &&
        statusPayload.artifacts && typeof statusPayload.artifacts === 'object' &&
        statusPayload.artifacts.final_fixed_pdf === 'fixed.pdf';

    if (passedStatusPolling) {
        console.log('--> [PASS] Status polling returns exhaustive root list properties and maps artifacts as an object.');
    } else {
        console.error('--> [FAIL] Polled status payload shape does not match strict specifications.');
    }

    console.log('\n=== AUTOFIX Pipeline Integrity Verification Complete ===\n');
}

runAutofixPipelineVerification();
