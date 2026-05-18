/**
 * API Normalization & Integrity Verification
 * Verifies that PreflightService enforces strict canonical integrity invariants,
 * eliminates payload duplications, separates environmental failures from document errors,
 * and maintains full Control Plane compatibility.
 */

const path = require('path');

// Intercept requires to allow running without local node_modules installed
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(request) {
    if (request.includes('src/services/db')) {
        return { execute: async () => {}, query: async () => [] };
    }
    if (request.includes('src/services/policyEngine')) {
        return {};
    }
    if (request.includes('src/services/auditLogger')) {
        return { log: async () => {} };
    }
    if (request === 'fs-extra') {
        return { pathExists: async () => true, copy: async () => {}, writeJson: async () => {}, stat: async () => ({ size: 1000 }) };
    }
    if (request.includes('errors')) {
        return { ErrorCodes: {}, ErrorTypes: {}, PPOSError: class extends Error {} };
    }
    return originalRequire.apply(this, arguments);
};

const PreflightService = require('./services/PreflightService');

// Instantiate service with lightweight mock dependencies
const service = new PreflightService({}, {}, {});

function runNormalizationTests() {
    console.log('=== Starting API Normalization & Integrity Verification ===\n');

    // TEST 1: Missing Tools Degraded Diagnostics scenario (Phase 10)
    console.log('[TEST 1] Missing Tools Triggering Degraded Analysis instead of Environment Failure');
    const job1 = { id: 'job_env_fail_1', status: 'COMPLETED', job_type: 'ANALYZE' };
    const rawResult1 = {
        ok: true, // Contradictory initial OK
        analysis_status: 'COMPLETED', // Contradictory status
        missing_tools: ['pdfimages', 'mutool'],
        degradedMode: false, // Contradictory flag
        extractionFidelity: 'REAL_EXTRACTION',
        summary: {
            risk_score: 100
        },
        findings: [
            { id: 'f1', severity: 'warning', message: 'Low resolution image' }
        ]
    };

    const norm1 = service._normalizeJobPayload(job1, [{ type: 'analysis_report', name: 'report.json' }, { type: 'certified_pdf', name: 'certified.pdf' }], rawResult1);
    console.log('Normalized Outcome Category:', norm1.result.outcome_category);
    console.log('Normalized Analysis Status:', norm1.result.analysis_status);
    console.log('Normalized Summary:', JSON.stringify(norm1.result.summary));
    console.log('Normalized Integrity Contract:', JSON.stringify(norm1.result.analysisIntegrity));

    const passedTest1 = 
        norm1.result.outcome_category === 'DEGRADED_ANALYSIS' &&
        norm1.result.analysis_status === 'DEGRADED' &&
        norm1.result.summary.risk_score === 100 &&
        norm1.result.summary.environment_errors === 0 &&
        norm1.result.analysisIntegrity.degradedMode === true &&
        norm1.result.analysisIntegrity.realExtraction === true &&
        norm1.result.analysisIntegrity.certifiable === true &&
        norm1.result.extractionFidelity === 'DEGRADED';

    if (passedTest1) {
        console.log('--> [PASS] Degraded diagnostics invariants enforced correctly.\n');
    } else {
        console.error('--> [FAIL] Degraded diagnostics invariant mismatch.\n');
    }

    // TEST 2: Duplicate Findings Array Optimization scenario
    console.log('[TEST 2] Duplicate Findings Reduction and Deletion');
    const job2 = { id: 'job_dup_findings', status: 'COMPLETED', job_type: 'ANALYZE' };
    const sharedFindings = [{ id: 'issue_1', severity: 'error', message: 'Missing fonts' }];
    const rawResult2 = {
        ok: true,
        status: 'COMPLETED',
        findings: sharedFindings,
        issues: sharedFindings,
        analysis: {
            issues: sharedFindings
        },
        forensics: {
            findings: sharedFindings
        },
        summary: {
            risk_score: 65
        }
    };

    const norm2 = service._normalizeJobPayload(job2, [{ type: 'analysis_report', name: 'report.json' }], rawResult2);
    
    const passedTest2 = 
        norm2.result.findings.length === 1 &&
        norm2.result.issues.length === 1 &&
        norm2.result.analysis?.issues.length === 1 &&
        norm2.result.forensics?.findings.length === 1 &&
        norm2.result.outcome_category === 'PDF_DOCUMENT_FAILURE' &&
        norm2.result.summary.issue_count === 1;

    if (passedTest2) {
        console.log('--> [PASS] Bloated duplicated finding arrays successfully eliminated but aliases preserved.\n');
    } else {
        console.error('--> [FAIL] Finding deduplication failed.\n');
    }

    // TEST 3: Successful Validation with Findings
    console.log('[TEST 3] Successful Validation with Document Findings');
    const job3 = { id: 'job_success_warn', status: 'COMPLETED', job_type: 'ANALYZE' };
    const rawResult3 = {
        ok: true,
        status: 'COMPLETED',
        findings: [{ id: 'w1', severity: 'warning', message: 'RGB Color Space used' }],
        summary: {
            risk_score: 90
        }
    };

    const norm3 = service._normalizeJobPayload(job3, [{ type: 'certified_pdf', name: 'cert.pdf' }, { type: 'analysis_report', name: 'report.json' }], rawResult3);
    
    const passedTest3 = 
        norm3.result.outcome_category === 'SUCCESS_WITH_FINDINGS' &&
        norm3.result.analysisIntegrity.certifiable === true &&
        norm3.result.analysisIntegrity.scoreBasis === 'DOCUMENT_FINDINGS' &&
        norm3.partial === true &&
        norm3.artifacts.length === 2;

    if (passedTest3) {
        console.log('--> [PASS] Document success categorization and warnings payload mapped correctly.\n');
    } else {
        console.error('--> [FAIL] Document success verification failed.\n');
    }

    // TEST 4: Certifiable clean doc + missing certified.pdf => PARTIAL_ARTIFACTS
    console.log('[TEST 4] Certifiable Clean Doc + Missing certified.pdf triggers PARTIAL_ARTIFACTS');
    const job4 = { id: 'job_clean_missing_cert', status: 'COMPLETED', job_type: 'ANALYZE' };
    const rawResult4 = { ok: true, status: 'COMPLETED', findings: [] };
    const norm4 = service._normalizeJobPayload(job4, [{ type: 'analysis_report', name: 'report.json' }], rawResult4);
    
    if (norm4.result.analysis_status === 'PARTIAL_ARTIFACTS' && norm4.result.outcome_category === 'ARTIFACT_INTEGRITY_FAILURE') {
        console.log('--> [PASS] Missing certified.pdf on a certifiable document correctly causes PARTIAL_ARTIFACTS.\n');
    } else {
        console.error('--> [FAIL] Clean document missing certified.pdf failed check.\n');
    }

    // TEST 5: Non-certifiable doc + missing certified.pdf + has report => COMPLETED_WITH_FINDINGS
    console.log('[TEST 5] Non-certifiable Doc + Missing certified.pdf + Has Report triggers COMPLETED_WITH_FINDINGS');
    const job5 = { id: 'job_non_cert', status: 'COMPLETED', job_type: 'ANALYZE' };
    const rawResult5 = {
        ok: false,
        status: 'COMPLETED',
        certifiable: false,
        findings: [{ id: 'e1', severity: 'error', message: 'Low resolution elements' }]
    };
    const norm5 = service._normalizeJobPayload(job5, [{ type: 'analysis_report', name: 'report.json' }], rawResult5);
    
    if (norm5.result.analysis_status === 'COMPLETED_WITH_FINDINGS' && norm5.result.outcome_category === 'PDF_DOCUMENT_FAILURE' && norm5.result.artifactIntegrity.ready === true) {
        console.log('--> [PASS] Missing certified.pdf on non-certifiable document is safely permitted without artifact error.\n');
    } else {
        console.error('--> [FAIL] Non-certifiable document check failed.\n');
    }

    // TEST 6: Missing report.json => PARTIAL_ARTIFACTS
    console.log('[TEST 6] Missing report.json triggers PARTIAL_ARTIFACTS regardless of document outcome');
    const job6 = { id: 'job_missing_report', status: 'COMPLETED', job_type: 'ANALYZE' };
    const rawResult6 = { ok: true, status: 'COMPLETED', findings: [] };
    const norm6 = service._normalizeJobPayload(job6, [{ type: 'certified_pdf', name: 'cert.pdf' }], rawResult6);
    
    if (norm6.result.analysis_status === 'PARTIAL_ARTIFACTS' && norm6.result.outcome_category === 'ARTIFACT_INTEGRITY_FAILURE') {
        console.log('--> [PASS] Mandatory analysis_report presence checked correctly.\n');
    } else {
        console.error('--> [FAIL] Missing report.json verification failed.\n');
    }

    console.log('=== Normalization & Integrity Verification Complete ===');
}

runNormalizationTests();
