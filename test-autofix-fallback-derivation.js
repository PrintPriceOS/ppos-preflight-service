/**
 * Hardened AUTOFIX Fallback Derivation Verification
 * 
 * Asserts that:
 * 1. When clients omit requested_fixes/fixes, the service derives them from source job findings.
 * 2. Derivation sources include repairStrategy, fix_method, and recommended_fix.
 * 3. The derived list is deduplicated and strictly ordered:
 *    1. REBUILD_TRIMBOX
 *    2. APPLY_BLEED
 *    3. CONVERT_CMYK
 *    4. INJECT_OUTPUT_INTENT
 * 4. Required log [SERVICE][FIX-ACTION][REQUEST] displays the final derived list.
 * 5. If no fixes can be derived, requested_fixes remains [] and logs [SERVICE][FIX-ACTION][NO_REQUESTED_FIXES].
 */

const path = require('path');
const Module = require('module');
const originalRequire = Module.prototype.require;

let queryScenario = 'HAS_FINDINGS';
let loggedRequestLine = null;
let loggedNoRequestedFixesLine = null;
let insertedResultObj = null;

// Override console.log to intercept mandatory log strings
const originalLog = console.log;
console.log = function(...args) {
    const str = args.join(' ');
    if (str.includes('[SERVICE][FIX-ACTION][REQUEST]')) {
        loggedRequestLine = str;
    }
    if (str.includes('[SERVICE][FIX-ACTION][NO_REQUESTED_FIXES]')) {
        loggedNoRequestedFixesLine = str;
    }
    originalLog.apply(console, args);
};

Module.prototype.require = function(request) {
    if (request.includes('src/services/db')) {
        return {
            execute: async (sql, params) => {
                if (sql.includes('INSERT INTO jobs')) {
                    insertedResultObj = JSON.parse(params[7]);
                }
            },
            query: async (sql, params) => {
                if (sql.includes('SELECT status, error, result FROM jobs')) {
                    if (queryScenario === 'HAS_FINDINGS') {
                        // Return out-of-order, mixed source findings with duplicates
                        return [{
                            status: 'COMPLETED',
                            result: JSON.stringify({
                                findings: [
                                    { recommended_fix: 'INJECT_OUTPUT_INTENT' },
                                    { fix_method: 'APPLY_BLEED' },
                                    { repairStrategy: 'REBUILD_TRIMBOX' },
                                    { fix_method: 'CONVERT_CMYK' },
                                    { repairStrategy: 'APPLY_BLEED' } // duplicate
                                ]
                            })
                        }];
                    } else if (queryScenario === 'EMPTY_FINDINGS') {
                        return [{
                            status: 'COMPLETED',
                            result: JSON.stringify({ findings: [] })
                        }];
                    }
                }
                if (sql.includes('SELECT result FROM jobs')) {
                    // Subsequent check for legacy fallback
                    return [{ result: JSON.stringify({ findings: [] }) }];
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
            stat: async () => ({ size: 50 * 1024 * 1024 }) // async path
        };
    }
    if (request.includes('errors')) {
        return { ErrorCodes: {}, ErrorTypes: {}, PPOSError: class extends Error {} };
    }
    return originalRequire.apply(this, arguments);
};

const PreflightService = require('./services/PreflightService');

const mockWorkerClient = {
    enqueue: async () => ({ job_id: 'bullmq_1', status: 'QUEUED' })
};
const mockStorage = {
    initializeJobStorage: async () => {},
    getJobSubfolder: () => '/mock/storage/path'
};

const service = new PreflightService({}, mockWorkerClient, mockStorage);
service._resolveCanonicalInputPdf = async () => '/mock/input.pdf';

async function runTests() {
    originalLog('=== Starting AUTOFIX Fallback Derivation Verification ===\n');

    const context = {
        auth: { tenantId: 'tenant_1', userId: 'usr_1' },
        deployment: { deploymentId: 'dep_1' }
    };

    originalLog('[TEST 1] Scenario: Client sends empty fixes/requested_fixes, derive from findings');
    queryScenario = 'HAS_FINDINGS';
    loggedRequestLine = null;
    insertedResultObj = null;

    await service.autofix('job_src_100', null, context, { fixes: [], requested_fixes: [] });

    originalLog('\n--- Intercepted [SERVICE][FIX-ACTION][REQUEST] Log ---');
    originalLog(loggedRequestLine);

    // Verify ordering and content
    const expectedDerivedList = ["REBUILD_TRIMBOX", "APPLY_BLEED", "CONVERT_CMYK", "INJECT_OUTPUT_INTENT"];
    const hasCorrectListInLog = loggedRequestLine && loggedRequestLine.includes(JSON.stringify(expectedDerivedList));
    const hasCorrectListInDb = insertedResultObj && JSON.stringify(insertedResultObj.requested_fixes) === JSON.stringify(expectedDerivedList);

    if (hasCorrectListInLog && hasCorrectListInDb) {
        originalLog('--> [PASS] Derivation successfully extracted, deduplicated, and ordered fixes into the required log and persistence object.');
    } else {
        originalLog('--> [FAIL] Derivation logic output is incorrect.');
    }

    originalLog('\n[TEST 2] Scenario: Client sends empty fixes, source findings are also empty');
    queryScenario = 'EMPTY_FINDINGS';
    loggedRequestLine = null;
    loggedNoRequestedFixesLine = null;
    insertedResultObj = null;

    await service.autofix('job_src_200', null, context, { fixes: [], requested_fixes: [] });

    originalLog('\n--- Intercepted Logs ---');
    originalLog('Request Log:', loggedRequestLine);
    originalLog('No-Fixes Log:', loggedNoRequestedFixesLine);

    const keptEmptyArray = insertedResultObj && JSON.stringify(insertedResultObj.requested_fixes) === '[]';
    const loggedProperly = loggedNoRequestedFixesLine && loggedNoRequestedFixesLine.includes('[SERVICE][FIX-ACTION][NO_REQUESTED_FIXES]');

    if (keptEmptyArray && loggedProperly) {
        originalLog('--> [PASS] When no fixes are derivable, requested_fixes remains [] and logs NO_REQUESTED_FIXES appropriately without inventing fake intent.');
    } else {
        originalLog('--> [FAIL] Empty fallback logic failed.');
    }

    originalLog('\n=== Fallback Derivation Verification Finished ===\n');
}

runTests();
