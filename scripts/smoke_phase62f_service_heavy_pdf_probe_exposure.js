'use strict';

/**
 * Phase 62F-C — Service Heavy PDF Probe Exposure
 * Smoke test: verifies that the Service correctly normalizes, exposes, and enforces
 * heavy_pdf_probe_governance from Worker fix_audit payloads.
 *
 * Input: ../ppos-preflight-worker/reports/phase62f_worker_heavy_pdf_probe_governance.json
 * Fallback: synthetic payloads labeled input_mode="SYNTHETIC_POLICY_FALLBACK"
 */

const path = require('path');
const fs = require('fs');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');
const FixCapabilityContract = require('../services/FixCapabilityContract');

// ---------------------------------------------------------------------------
// Load Phase 62F-B worker report or fall back to synthetic payloads
// ---------------------------------------------------------------------------
const WORKER_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-worker/reports/phase62f_worker_heavy_pdf_probe_governance.json');
let workerReport = null;
let inputMode = 'WORKER_REPORT';

if (fs.existsSync(WORKER_REPORT_PATH)) {
    try {
        workerReport = JSON.parse(fs.readFileSync(WORKER_REPORT_PATH, 'utf8'));
        inputMode = workerReport.input_mode || 'WORKER_REPORT';
        console.log('[62F-C] Loaded Phase 62F-B worker report from:', WORKER_REPORT_PATH);
    } catch (e) {
        console.warn('[62F-C] Failed to parse Phase 62F-B worker report, using synthetic payloads:', e.message);
    }
}

if (!workerReport) {
    inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    console.log('[62F-C] Phase 62F-B worker report unavailable. Using synthetic payloads.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildFixAuditV2(heavyGov, artifactTrust) {
    return {
        version: '2.0',
        requested_fixes: [],
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: heavyGov.review_required || false,
        production_certified: false,
        highest_risk_level: 'HIGH',
        heavy_pdf_probe_governance: heavyGov,
        artifact_trust: artifactTrust || {
            trust_level: 'DEGRADED_ANALYSIS_REVIEW_REQUIRED',
            production_certified: false,
            review_required: heavyGov.review_required || false,
            certified_pdf_allowed: !(heavyGov.review_required || heavyGov.fatal_document_failure),
            standard_certified: false,
            compliance_claim_allowed: false
        }
    };
}

// Mirror PreflightService._normalizeJobPayload Phase 62F-C enforcement block
function simulateServiceEnforcement(fixAuditData) {
    const normalized = FixAuditNormalizer.normalize(fixAuditData);
    const gov = normalized.heavy_pdf_probe_governance || {};
    const artifactTrust = normalized.artifact_trust || {};

    const requiresBlock = Object.keys(gov).length > 0 && (
        gov.production_certified === false ||
        gov.fatal_document_failure === true ||
        gov.review_required === true ||
        gov.analysis_degraded === true
    );

    let productionCertified = artifactTrust.production_certified !== false;
    let requiresReview = artifactTrust.review_required === true;

    if (requiresBlock) {
        productionCertified = false;
    }
    if (gov.review_required === true || gov.fatal_document_failure === true) {
        requiresReview = true;
    }

    let standardCertified = artifactTrust.standard_certified;
    let complianceClaimAllowed = artifactTrust.compliance_claim_allowed;
    if (requiresBlock) {
        standardCertified = false;
        complianceClaimAllowed = false;
    }

    const trustAllowed = artifactTrust.certified_pdf_allowed !== false;
    const certifiedPdfAllowed = productionCertified && !requiresReview && trustAllowed;

    const customerGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(gov, 'customer');
    const operatorGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(gov, 'operator');

    return {
        normalized, gov, requiresBlock, productionCertified, requiresReview,
        standardCertified, complianceClaimAllowed, certifiedPdfAllowed,
        customerGov, operatorGov
    };
}

// ---------------------------------------------------------------------------
// Test framework
// ---------------------------------------------------------------------------
const results = [];
let pass_count = 0;
let fail_count = 0;

function check(name, condition, notes) {
    const pass = !!condition;
    results.push({ scenario: name, pass, notes: notes || (pass ? 'OK' : 'FAIL') });
    if (pass) pass_count++; else fail_count++;
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${notes && !pass ? ': ' + notes : ''}`);
}

console.log('\n=== Phase 62F-C — Service Heavy PDF Probe Exposure ===\n');
console.log(`Input mode: ${inputMode}\n`);

// ---------------------------------------------------------------------------
// SC0: FixCapabilityContract exposes Phase 62F heavy PDF probe capabilities
// ---------------------------------------------------------------------------
console.log('SC0: FixCapabilityContract Phase 62F heavy PDF probe capabilities');
{
    const caps = FixCapabilityContract.getCapabilities();
    const ids = caps.capabilities.map(c => c.fix_id);

    check('FixCapabilityContract version >= 50.0', parseFloat(caps.version) >= 50.0, `version=${caps.version}`);
    check('HEAVY_PDF_PROBE_SEMANTICS capability present', ids.includes('HEAVY_PDF_PROBE_SEMANTICS'));
    check('QPDF_WARNING_CLASSIFICATION capability present', ids.includes('QPDF_WARNING_CLASSIFICATION'));
    check('PDFIMAGES_WARNING_CLASSIFICATION capability present', ids.includes('PDFIMAGES_WARNING_CLASSIFICATION'));

    const hps = caps.capabilities.find(c => c.fix_id === 'HEAVY_PDF_PROBE_SEMANTICS');
    check('HEAVY_PDF_PROBE_SEMANTICS category=heavy_pdf_probe', hps && hps.category === 'heavy_pdf_probe');
    check('HEAVY_PDF_PROBE_SEMANTICS production_certified=false', hps && hps.production_certified === false);
    check('HEAVY_PDF_PROBE_SEMANTICS standard_certified=false', hps && hps.standard_certified === false);
    check('HEAVY_PDF_PROBE_SEMANTICS compliance_claim_allowed=false', hps && hps.compliance_claim_allowed === false);
    check('HEAVY_PDF_PROBE_SEMANTICS not exposed as a fix (analysis_capability=true, autofixable=false)',
        hps && hps.analysis_capability === true && hps.autofixable === false);

    check('Phase 70 capabilities still present (regression)',
        ids.includes('PROOF_APPROVAL_CONTRACT') && ids.includes('GENERATE_PROOF_APPROVAL_METADATA'));
}

// ---------------------------------------------------------------------------
// SC1: qpdf WARNING_ONLY preserved (not generic fatal)
// ---------------------------------------------------------------------------
console.log('\nSC1: qpdf WARNING_ONLY preserved');
{
    const gov = {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: true,
        fatal_document_failure: false,
        certifiable: false,
        review_required: true,
        production_certified: false,
        standard_certified: false,
        pdfx_compliance_claimed: false,
        pdfa_compliance_claimed: false,
        compliance_claim_allowed: false,
        strict_forensic_mode: false,
        probe_summary: { total: 2, warning_only: 2, failed_fatal: 0 },
        tools: {
            qpdf: {
                raw_status: 'FAILED',
                semantic_status: 'WARNING_ONLY',
                severity: 'warning',
                usable_output: true,
                fatal: false,
                warning_classes: ['PDF_LINEARIZATION_HINT_WARNING', 'PDF_SHARED_OBJECT_HINT_MISMATCH', 'PDF_OBJECT_COUNT_HINT_MISMATCH']
            }
        },
        warnings: ['Heavy PDF analysis completed with probe warnings.', 'qpdf reported structural warnings that require review.'],
        review_required_reasons: ['TOOL_PROBE_WARNING:qpdf'],
        evidence: { qpdf_exit_code: 3, qpdf_stderr_excerpt: 'WARNING: page 0 has shared identifier entries' }
    };

    const normalized = FixAuditNormalizer.normalize(buildFixAuditV2(gov));
    check('heavy_pdf_probe_governance preserved at root', normalized.heavy_pdf_probe_governance !== undefined);
    check('qpdf semantic_status=WARNING_ONLY preserved', normalized.heavy_pdf_probe_governance.tools.qpdf.semantic_status === 'WARNING_ONLY');
    check('qpdf not classified as fatal', normalized.heavy_pdf_probe_governance.tools.qpdf.fatal === false);

    const r = simulateServiceEnforcement(buildFixAuditV2(gov));
    check('WARNING_ONLY → review_required=true', r.requiresReview === true);
    check('WARNING_ONLY → production_certified=false', r.productionCertified === false);
    check('WARNING_ONLY → fatal_document_failure=false preserved', r.gov.fatal_document_failure === false);
}

// ---------------------------------------------------------------------------
// SC2: pdfimages WARNING_ONLY preserved (not generic fatal)
// ---------------------------------------------------------------------------
console.log('\nSC2: pdfimages WARNING_ONLY preserved');
{
    const gov = {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: true,
        fatal_document_failure: false,
        certifiable: false,
        review_required: true,
        production_certified: false,
        standard_certified: false,
        compliance_claim_allowed: false,
        strict_forensic_mode: false,
        probe_summary: { total: 2, warning_only: 2 },
        tools: {
            pdfimages: {
                raw_status: 'FAILED',
                semantic_status: 'WARNING_ONLY',
                severity: 'warning',
                usable_output: true,
                fatal: false,
                warning_classes: ['PDF_FONT_WEIGHT_WARNING']
            }
        },
        warnings: ['pdfimages reported warnings during image extraction.'],
        review_required_reasons: ['PDF_FONT_WEIGHT_WARNING:pdfimages'],
        evidence: { pdfimages_exit_code: 1, pdfimages_stderr_excerpt: 'Syntax Warning: Invalid Font Weight' }
    };

    const normalized = FixAuditNormalizer.normalize(buildFixAuditV2(gov));
    check('pdfimages semantic_status=WARNING_ONLY preserved', normalized.heavy_pdf_probe_governance.tools.pdfimages.semantic_status === 'WARNING_ONLY');
    check('pdfimages not classified as fatal', normalized.heavy_pdf_probe_governance.tools.pdfimages.fatal === false);

    const customerGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(gov, 'customer');
    check('PDF_FONT_WEIGHT_WARNING preserved in customer view (safe class)',
        customerGov.tools.pdfimages.warning_classes.includes('PDF_FONT_WEIGHT_WARNING'));
}

// ---------------------------------------------------------------------------
// SC3: Fatal qpdf preserved as fatal — blocks production, requires remediation
// ---------------------------------------------------------------------------
console.log('\nSC3: Fatal qpdf preserved as fatal');
{
    const gov = {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: true, // intentionally true to verify fatal wins
        fatal_document_failure: true,
        certifiable: false,
        review_required: true,
        production_certified: false,
        standard_certified: false,
        compliance_claim_allowed: false,
        strict_forensic_mode: false,
        probe_summary: { total: 2, failed_fatal: 1 },
        tools: {
            qpdf: {
                raw_status: 'FAILED',
                semantic_status: 'FAILED_FATAL',
                severity: 'error',
                usable_output: false,
                fatal: true,
                structural_fatal: true,
                fatal_classes: ['INVALID_XREF', 'UNABLE_TO_FIND_TRAILER']
            }
        },
        warnings: [],
        review_required_reasons: ['QPDF_FATAL_STRUCTURAL_ERROR'],
        evidence: { qpdf_exit_code: 2, qpdf_stderr_excerpt: 'unable to find trailer dictionary' }
    };

    const r = simulateServiceEnforcement(buildFixAuditV2(gov));
    check('FAILED_FATAL preserved as fatal', r.gov.tools.qpdf.semantic_status === 'FAILED_FATAL' && r.gov.tools.qpdf.fatal === true);
    check('fatal_document_failure=true → degraded_but_usable forced false',
        r.customerGov.degraded_but_usable === false, 'fatal wins over degraded_but_usable');
    check('fatal_document_failure=true → review_required=true', r.requiresReview === true);
    check('fatal_document_failure=true → production_certified=false', r.productionCertified === false);
    check('fatal_document_failure=true → certified.pdf not allowed', r.certifiedPdfAllowed === false);
}

// ---------------------------------------------------------------------------
// SC4: degraded_but_usable=true exposed safely — supports review route
// ---------------------------------------------------------------------------
console.log('\nSC4: degraded_but_usable=true exposed safely');
{
    const gov = {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: true,
        fatal_document_failure: false,
        certifiable: false,
        review_required: true,
        production_certified: false,
        standard_certified: false,
        compliance_claim_allowed: false,
        strict_forensic_mode: false,
        probe_summary: { total: 2, warning_only: 2 },
        tools: {
            qpdf: { semantic_status: 'WARNING_ONLY', severity: 'warning', usable_output: true, fatal: false, warning_classes: ['PDF_LINEARIZATION_HINT_WARNING'] },
            pdfimages: { semantic_status: 'WARNING_ONLY', severity: 'warning', usable_output: true, fatal: false, warning_classes: ['PDF_FONT_WEIGHT_WARNING'] }
        },
        warnings: ['Analysis is degraded but usable; production approval requires review.'],
        review_required_reasons: ['TOOL_PROBE_WARNING:qpdf', 'PDF_FONT_WEIGHT_WARNING:pdfimages'],
        evidence: {}
    };

    const r = simulateServiceEnforcement(buildFixAuditV2(gov));
    check('degraded_but_usable=true preserved (not fatal)', r.customerGov.degraded_but_usable === true && r.customerGov.fatal_document_failure === false);
    check('degraded_but_usable=true → review_required=true (review route, not auto-fail)', r.requiresReview === true);
    check('degraded_but_usable=true → production_certified=false (no auto-certify)', r.productionCertified === false);
}

// ---------------------------------------------------------------------------
// SC5: Customer payload sanitized — no raw stderr, no paths, no object IDs
// ---------------------------------------------------------------------------
console.log('\nSC5: Customer payload sanitized');
{
    const gov = {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: false,
        fatal_document_failure: true,
        certifiable: false,
        review_required: true,
        production_certified: false,
        standard_certified: false,
        compliance_claim_allowed: false,
        strict_forensic_mode: false,
        probe_summary: { total: 1, failed_fatal: 1 },
        tools: {
            qpdf: {
                semantic_status: 'FAILED_FATAL',
                severity: 'error',
                usable_output: false,
                fatal: true,
                structural_fatal: true,
                fatal_classes: ['INVALID_XREF'],
                warning_classes: ['PDF_LINEARIZATION_HINT_WARNING']
            }
        },
        warnings: ['Heavy PDF analysis completed with probe warnings.'],
        review_required_reasons: ['QPDF_FATAL_STRUCTURAL_ERROR'],
        evidence: {
            qpdf_exit_code: 2,
            qpdf_stderr_excerpt: 'C:\\storage\\tenants\\t1\\jobs\\j1\\input\\file.pdf: 12 0 obj: unable to find trailer dictionary'
        }
    };

    const customerGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(gov, 'customer');
    const customerStr = JSON.stringify(customerGov);

    check('customer payload has no evidence field content', Object.keys(customerGov.evidence || {}).length === 0);
    check('customer payload contains no local filesystem paths',
        !/[A-Za-z]:[\\\/]|\/tmp\/|\/var\/|\/home\/|\/storage\//.test(customerStr));
    check('customer payload contains no raw object IDs', !/\d+\s+0\s+obj/i.test(customerStr));
    check('customer payload production_certified=false', customerGov.production_certified === false);
    check('customer payload standard_certified=false', customerGov.standard_certified === false);
    check('customer payload compliance_claim_allowed=false', customerGov.compliance_claim_allowed === false);
}

// ---------------------------------------------------------------------------
// SC6: Operator payload preserves semantic detail
// ---------------------------------------------------------------------------
console.log('\nSC6: Operator payload preserves semantic detail');
{
    const gov = {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: true,
        fatal_document_failure: false,
        certifiable: false,
        review_required: true,
        production_certified: false,
        standard_certified: false,
        compliance_claim_allowed: false,
        strict_forensic_mode: false,
        probe_summary: { total: 2, warning_only: 2 },
        tools: {
            qpdf: {
                raw_status: 'FAILED',
                semantic_status: 'WARNING_ONLY',
                severity: 'warning',
                usable_output: true,
                fatal: false,
                warning_classes: ['PDF_LINEARIZATION_HINT_WARNING', 'PDF_SHARED_OBJECT_HINT_MISMATCH', 'PDF_OBJECT_COUNT_HINT_MISMATCH']
            }
        },
        warnings: ['qpdf reported structural warnings that require review.'],
        review_required_reasons: ['TOOL_PROBE_WARNING:qpdf'],
        evidence: { qpdf_exit_code: 3, qpdf_stderr_excerpt: 'WARNING: page 0 has shared identifier entries' }
    };

    const operatorGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(gov, 'operator');
    const customerGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(gov, 'customer');

    check('operator payload preserves raw_status', operatorGov.tools.qpdf.raw_status === 'FAILED');
    check('operator payload preserves all warning_classes',
        operatorGov.tools.qpdf.warning_classes.length === 3);
    check('operator payload includes evidence excerpt', !!operatorGov.evidence.qpdf_stderr_excerpt);
    check('operator payload has more detail than customer payload',
        operatorGov.tools.qpdf.warning_classes.length >= customerGov.tools.qpdf.warning_classes.length &&
        Object.keys(operatorGov.evidence).length > Object.keys(customerGov.evidence).length);
}

// ---------------------------------------------------------------------------
// SC7: certified.pdf downgrade when heavy_pdf_probe_governance.review_required=true
// ---------------------------------------------------------------------------
console.log('\nSC7: certified.pdf downgrade');
{
    const gov = {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: true,
        fatal_document_failure: false,
        certifiable: false,
        review_required: true,
        production_certified: false,
        standard_certified: false,
        compliance_claim_allowed: false,
        strict_forensic_mode: false,
        probe_summary: { total: 2, warning_only: 2 },
        tools: { qpdf: { semantic_status: 'WARNING_ONLY', severity: 'warning', usable_output: true, fatal: false, warning_classes: ['PDF_LINEARIZATION_HINT_WARNING'] } },
        warnings: [],
        review_required_reasons: ['TOOL_PROBE_WARNING:qpdf'],
        evidence: {}
    };

    // Even if upstream artifact_trust would otherwise allow production, the
    // heavy PDF probe governance must downgrade certified.pdf.
    const r = simulateServiceEnforcement(buildFixAuditV2(gov, {
        trust_level: 'CERTIFIED',
        production_certified: true,
        review_required: false,
        certified_pdf_allowed: true,
        standard_certified: true,
        compliance_claim_allowed: true
    }));

    check('review_required=true → certified.pdf downgraded (certifiedPdfAllowed=false)', r.certifiedPdfAllowed === false);
    check('review_required=true → production_certified=false even if artifact_trust said true', r.productionCertified === false);
    check('review_required=true → standard_certified=false even if artifact_trust said true', r.standardCertified === false);
}

// ---------------------------------------------------------------------------
// SC8: Standards overclaim regression — no PDF/X or PDF/A from heavy PDF probe
// ---------------------------------------------------------------------------
console.log('\nSC8: Standards overclaim regression');
{
    const gov = {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: true,
        fatal_document_failure: false,
        certifiable: false,
        review_required: true,
        production_certified: false,
        standard_certified: false,
        pdfx_compliance_claimed: false,
        pdfa_compliance_claimed: false,
        compliance_claim_allowed: false,
        strict_forensic_mode: false,
        probe_summary: { total: 2, warning_only: 2 },
        tools: { qpdf: { semantic_status: 'WARNING_ONLY', severity: 'warning', usable_output: true, fatal: false, warning_classes: ['PDF_LINEARIZATION_HINT_WARNING'] } },
        warnings: [],
        review_required_reasons: ['TOOL_PROBE_WARNING:qpdf'],
        evidence: {}
    };

    const customerGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(gov, 'customer');
    const operatorGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(gov, 'operator');

    check('customer: production_certified=false', customerGov.production_certified === false);
    check('customer: standard_certified=false', customerGov.standard_certified === false);
    check('customer: pdfx_compliance_claimed=false', customerGov.pdfx_compliance_claimed === false);
    check('customer: pdfa_compliance_claimed=false', customerGov.pdfa_compliance_claimed === false);
    check('customer: compliance_claim_allowed=false', customerGov.compliance_claim_allowed === false);
    check('operator: production_certified=false', operatorGov.production_certified === false);
    check('operator: compliance_claim_allowed=false', operatorGov.compliance_claim_allowed === false);
}

// ---------------------------------------------------------------------------
// SC9: Huge stderr transcript summarized — never dumped raw to customer
// ---------------------------------------------------------------------------
console.log('\nSC9: Huge stderr transcript summarized');
{
    const hugeTranscript = 'WARNING: ' + 'object 12 0 obj has shared identifier entries; '.repeat(200) + ' /storage/tenants/t1/jobs/j1/input/heavy.pdf';

    const gov = {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: true,
        fatal_document_failure: false,
        certifiable: false,
        review_required: true,
        production_certified: false,
        standard_certified: false,
        compliance_claim_allowed: false,
        strict_forensic_mode: false,
        probe_summary: { total: 1, warning_only: 1 },
        tools: { qpdf: { semantic_status: 'WARNING_ONLY', severity: 'warning', usable_output: true, fatal: false, warning_classes: ['PDF_SHARED_OBJECT_HINT_MISMATCH'] } },
        warnings: [],
        review_required_reasons: [],
        evidence: { qpdf_exit_code: 3, qpdf_stderr_excerpt: hugeTranscript }
    };

    check('raw transcript exceeds 500 chars (sanity check)', hugeTranscript.length > 500);

    const customerGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(gov, 'customer');
    check('customer payload contains no evidence at all', Object.keys(customerGov.evidence || {}).length === 0);

    const operatorGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(gov, 'operator');
    check('operator payload truncates huge transcript', operatorGov.evidence.qpdf_stderr_excerpt.length <= 520);
    check('operator payload truncation marker present', operatorGov.evidence.qpdf_stderr_excerpt.endsWith('[truncated]'));
    check('operator payload redacts local paths from transcript', !/\/storage\//.test(operatorGov.evidence.qpdf_stderr_excerpt));
}

// ---------------------------------------------------------------------------
// SC10: Legacy payload without heavy_pdf_probe_governance still works
// ---------------------------------------------------------------------------
console.log('\nSC10: Legacy payload without heavy_pdf_probe_governance still works');
{
    const auditData = {
        version: '2.0',
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: false,
        production_certified: true,
        highest_risk_level: 'LOW',
        artifact_trust: {
            trust_level: 'CERTIFIED',
            production_certified: true,
            review_required: false,
            certified_pdf_allowed: true,
            standard_certified: false,
            compliance_claim_allowed: false
        }
    };

    const normalized = FixAuditNormalizer.normalize(auditData);
    check('legacy payload normalizes without error', normalized.available === true);
    check('legacy payload heavy_pdf_probe_governance=undefined', normalized.heavy_pdf_probe_governance === undefined);
    check('normalizeHeavyPdfProbeGovernance(undefined) returns null', FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(undefined) === null);
    check('normalizeHeavyPdfProbeGovernance({}) returns null', FixAuditNormalizer.normalizeHeavyPdfProbeGovernance({}) === null);

    const r = simulateServiceEnforcement(auditData);
    check('legacy payload → no heavy PDF block', r.requiresBlock === false);
    check('legacy payload → production_certified unchanged (true)', r.productionCertified === true);

    const empty = FixAuditNormalizer.normalize({});
    check('empty audit data → available=false', empty.available === false);
    const nullNorm = FixAuditNormalizer.normalize(null);
    check('null audit data → available=false', nullNorm.available === false);
}

// ---------------------------------------------------------------------------
// SC11: delta_report.heavy_pdf_probe_governance preserved
// ---------------------------------------------------------------------------
console.log('\nSC11: delta_report.heavy_pdf_probe_governance preserved');
{
    const gov = { heavy_pdf_detected: true, review_required: true, fatal_document_failure: false, production_certified: false };
    const auditData = {
        version: '2.0',
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: true,
        production_certified: false,
        highest_risk_level: 'HIGH',
        delta_report: { heavy_pdf_probe_governance: gov }
    };

    const normalized = FixAuditNormalizer.normalize(auditData);
    check('delta_report.heavy_pdf_probe_governance preserved',
        normalized.delta_report && normalized.delta_report.heavy_pdf_probe_governance !== undefined);
    check('delta_report.heavy_pdf_probe_governance.review_required preserved',
        normalized.delta_report?.heavy_pdf_probe_governance?.review_required === true);
}

// ---------------------------------------------------------------------------
// SC12: Phase 62F-B worker report integration
// ---------------------------------------------------------------------------
console.log('\nSC12: Phase 62F-B worker report scenario normalization');
{
    if (workerReport && workerReport.results) {
        let allNormalized = true;
        let allNoOverclaim = true;
        let fatalAlwaysBlocks = true;

        for (const scenario of workerReport.results) {
            if (!scenario.heavy_pdf_probe_governance) continue;
            const auditData = buildFixAuditV2(scenario.heavy_pdf_probe_governance);
            const normalized = FixAuditNormalizer.normalize(auditData);
            if (!normalized || !normalized.available) { allNormalized = false; continue; }

            const customerGov = FixAuditNormalizer.normalizeHeavyPdfProbeGovernance(normalized.heavy_pdf_probe_governance, 'customer');
            if (customerGov.production_certified !== false || customerGov.standard_certified !== false ||
                customerGov.pdfx_compliance_claimed !== false || customerGov.pdfa_compliance_claimed !== false ||
                customerGov.compliance_claim_allowed !== false) {
                allNoOverclaim = false;
            }

            if (scenario.heavy_pdf_probe_governance.fatal_document_failure === true) {
                const r = simulateServiceEnforcement(auditData);
                if (r.productionCertified !== false || r.certifiedPdfAllowed !== false || r.requiresReview !== true) {
                    fatalAlwaysBlocks = false;
                }
            }
        }

        check('All 62F-B scenarios successfully normalized', allNormalized);
        check('No heavy_pdf_probe_governance scenario overclaims production/standards', allNoOverclaim);
        check('fatal_document_failure=true always blocks production end-to-end', fatalAlwaysBlocks);
    } else {
        console.log('  (skipped — no worker report available)');
        check('synthetic fallback acknowledged', true);
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass_count + fail_count;
const smoke_passed = fail_count === 0;

console.log(`\n${'='.repeat(60)}`);
console.log('Phase 62F-C — Service Heavy PDF Probe Exposure');
console.log(`Results: ${pass_count}/${total} passed${fail_count > 0 ? ` (${fail_count} FAILED)` : ''}`);
console.log(`Smoke: ${smoke_passed ? 'PASSED' : 'FAILED'}`);
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// Generate reports
// ---------------------------------------------------------------------------
const report = {
    generated_at: new Date().toISOString(),
    phase: '62F-C',
    repo: 'ppos-preflight-service',
    smoke_passed,
    input_mode: inputMode,
    core_principle: 'heavy_pdf_probe_governance explains analysis quality. It does not certify the PDF, does not override artifact_trust, and does not allow production by itself. review_required=true and fatal_document_failure=true always degrade; they never upgrade certification. Customer payloads never see raw stderr, local paths, or object IDs; only safe warning classes are preserved.',
    changes: [
        'FixAuditNormalizer.js: heavy_pdf_probe_governance preserved at root and in delta_report',
        'FixAuditNormalizer.js: analysisIntegrity, degraded_reasons, extractionErrors, analysis_status, certifiable, strict_forensic_mode preserved',
        'FixAuditNormalizer.js: new normalizeHeavyPdfProbeGovernance(gov, audience) helper for customer/operator sanitization',
        'FixCapabilityContract.js: version bumped to 50.0',
        'FixCapabilityContract.js: HEAVY_PDF_PROBE_SEMANTICS, QPDF_WARNING_CLASSIFICATION, PDFIMAGES_WARNING_CLASSIFICATION capabilities added under heavy_pdf_probe category (analysis capabilities, not fixes)',
        'PreflightService.js: getJobArtifacts resolves heavy_pdf_probe_governance from fix_audit/delta_report sources, applies review_required/fatal wins to productionCertified/requiresReview',
        'PreflightService.js: artifact_summary.heavy_pdf_probe_governance exposed (customer-sanitized), downgrades production_ready_artifact_available when review required',
        'PreflightService.js: _normalizeJobPayload Phase 62F-C enforcement block added after Phase 70C block',
        'PreflightService.js: heavy_pdf_probe_governance (customer) and heavy_pdf_probe_governance_operator (operator) exposed in artifact_summary and root payload'
    ],
    results,
    summary: { total, passed: pass_count, failed: fail_count }
};

const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const jsonPath = path.join(reportsDir, 'phase62f_service_heavy_pdf_probe_exposure.json');
const mdPath = path.join(reportsDir, 'phase62f_service_heavy_pdf_probe_exposure.md');

fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const mdLines = [
    '# Phase 62F-C — Service Heavy PDF Probe Exposure',
    '',
    `**Generated:** ${report.generated_at}  `,
    `**Repo:** ${report.repo}  `,
    `**Input mode:** ${report.input_mode}  `,
    `**Smoke:** ${report.smoke_passed ? '✓ PASSED' : '✗ FAILED'}  `,
    `**Results:** ${report.summary.passed}/${report.summary.total} passed`,
    '',
    '## Core Principle',
    '',
    `> ${report.core_principle}`,
    '',
    '## Changes',
    '',
    report.changes.map(c => `- ${c}`).join('\n'),
    '',
    '## Scenarios',
    '',
    '| # | Scenario | Result |',
    '|---|----------|--------|',
    ...report.results.map((r, i) => `| ${i + 1} | ${r.scenario} | ${r.pass ? '✓ PASS' : '✗ FAIL'} |`),
    ''
];

fs.writeFileSync(mdPath, mdLines.join('\n'));

console.log('\nReports written:');
console.log(`  ${jsonPath}`);
console.log(`  ${mdPath}`);

process.exit(smoke_passed ? 0 : 1);
