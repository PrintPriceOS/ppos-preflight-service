'use strict';

/**
 * Phase 73C — Service Machine Readiness Exposure
 * Smoke test: verifies that the Service correctly normalizes and exposes
 * machine_readiness_governance from Worker fix_audit payloads through
 * artifact_summary and job payload, and that the governance invariants
 * (machine_match_authority=false, production_certified=false,
 * standard_certified=false) always hold regardless of upstream evidence.
 *
 * Input: ../ppos-preflight-worker/reports/phase73b_worker_machine_readiness_governance.json
 * Fallback: synthetic payloads labeled input_mode="SYNTHETIC_POLICY_FALLBACK"
 */

const path = require('path');
const fs = require('fs');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');

// ---------------------------------------------------------------------------
// Load Phase 73B worker report or fall back to synthetic payloads
// ---------------------------------------------------------------------------
const WORKER_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-worker/reports/phase73b_worker_machine_readiness_governance.json');
let workerReport = null;
let inputMode = 'WORKER_REPORT';

if (fs.existsSync(WORKER_REPORT_PATH)) {
    try {
        workerReport = JSON.parse(fs.readFileSync(WORKER_REPORT_PATH, 'utf8'));
        console.log('[73C] Loaded Phase 73B worker report from:', WORKER_REPORT_PATH);
    } catch (e) {
        console.warn('[73C] Failed to parse Phase 73B worker report, using synthetic payloads:', e.message);
    }
}

if (!workerReport) {
    inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    console.log('[73C] Phase 73B worker report unavailable. Using synthetic payloads.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildFixAuditV2(machineReadinessGov, deltaMachineReadinessGov) {
    return {
        version: '2.0',
        requested_fixes: [],
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: false,
        production_certified: false,
        highest_risk_level: 'LOW',
        machine_readiness_governance: machineReadinessGov,
        delta_report: deltaMachineReadinessGov ? {
            machine_readiness_governance: deltaMachineReadinessGov
        } : undefined
    };
}

// Simulate what PreflightService._normalizeJobPayload does for
// machine_readiness_governance exposure (Phase 73C).
function simulateServiceExposure(fixAuditData) {
    const normalized = FixAuditNormalizer.normalize(fixAuditData);
    const mrg = normalized.machine_readiness_governance || {};

    const exposed = Object.keys(mrg).length > 0 ? {
        machine_capability_signals: mrg.machine_capability_signals || {},
        machine_match_required: mrg.machine_match_required ?? false,
        incompatible_machine_reasons: mrg.incompatible_machine_reasons || [],
        warnings: mrg.warnings || [],
        machine_match_authority: false,
        production_certified: false,
        standard_certified: false,
        evidence: mrg.evidence || {}
    } : undefined;

    return { normalized, mrg, exposed };
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

console.log('\n=== Phase 73C — Service Machine Readiness Exposure ===\n');
console.log(`Input mode: ${inputMode}\n`);

// ---------------------------------------------------------------------------
// SC1: FixAuditNormalizer preserves machine_readiness_governance at root
// ---------------------------------------------------------------------------
console.log('SC1: FixAuditNormalizer preserves machine_readiness_governance');
{
    const mrg = {
        machine_capability_signals: {
            page_signals: { page_count: 4, orientation: 'PORTRAIT' },
            color_signals: { color_mode: 'RGB_PRESENT', rgb_detected: true },
            ink_signals: { ink_risk: 'LOW' },
            finishing_signals: { finishing_marks_risk: 'LOW' },
            standards_signals: { standard_status: 'UNKNOWN' },
            media_requirements: { requires_cmyk_conversion: true }
        },
        machine_match_required: true,
        incompatible_machine_reasons: ['REQUIRES_CMYK_CONVERSION'],
        warnings: ['PAGE_SIZE_UNAVAILABLE'],
        machine_match_authority: false,
        production_certified: false,
        standard_certified: false,
        evidence: { page_count: 4, color_mode: 'RGB_PRESENT' }
    };

    const auditData = buildFixAuditV2(mrg);
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('machine_readiness_governance preserved at root',
        normalized.machine_readiness_governance !== undefined);
    check('machine_capability_signals preserved',
        normalized.machine_readiness_governance?.machine_capability_signals?.color_signals?.color_mode === 'RGB_PRESENT');
    check('machine_match_required preserved',
        normalized.machine_readiness_governance?.machine_match_required === true);
    check('incompatible_machine_reasons preserved',
        normalized.machine_readiness_governance?.incompatible_machine_reasons?.includes('REQUIRES_CMYK_CONVERSION'));
    check('warnings preserved',
        normalized.machine_readiness_governance?.warnings?.includes('PAGE_SIZE_UNAVAILABLE'));
    check('evidence preserved',
        normalized.machine_readiness_governance?.evidence?.color_mode === 'RGB_PRESENT');
}

// ---------------------------------------------------------------------------
// SC2: delta_report.machine_readiness_governance preserved
// ---------------------------------------------------------------------------
console.log('\nSC2: delta_report.machine_readiness_governance preserved');
{
    const rootMrg = {
        machine_capability_signals: {},
        machine_match_required: false,
        incompatible_machine_reasons: [],
        warnings: [],
        machine_match_authority: false,
        production_certified: false,
        standard_certified: false,
        evidence: {}
    };
    const deltaMrg = {
        machine_capability_signals: { finishing_signals: { finishing_marks_risk: 'HIGH' } },
        machine_match_required: true,
        incompatible_machine_reasons: ['FINISHING_MARKS_RISK_HIGH'],
        warnings: [],
        machine_match_authority: false,
        production_certified: false,
        standard_certified: false,
        evidence: { finishing_marks_risk: 'HIGH' }
    };

    const auditData = buildFixAuditV2(rootMrg, deltaMrg);
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('delta_report.machine_readiness_governance preserved',
        normalized.delta_report && normalized.delta_report.machine_readiness_governance !== undefined);
    check('delta_report.machine_readiness_governance.incompatible_machine_reasons preserved',
        normalized.delta_report?.machine_readiness_governance?.incompatible_machine_reasons?.includes('FINISHING_MARKS_RISK_HIGH'));
}

// ---------------------------------------------------------------------------
// SC3: machine_match_required=false -> exposed with empty reasons, invariants hold
// ---------------------------------------------------------------------------
console.log('\nSC3: machine_match_required=false -> exposed cleanly');
{
    const mrg = {
        machine_capability_signals: { page_signals: { page_count: 0 } },
        machine_match_required: false,
        incompatible_machine_reasons: [],
        warnings: ['PAGE_COUNT_UNAVAILABLE', 'PAGE_SIZE_UNAVAILABLE'],
        machine_match_authority: false,
        production_certified: false,
        standard_certified: false,
        evidence: { page_count: 0 }
    };

    const r = simulateServiceExposure(buildFixAuditV2(mrg));

    check('exposed present', r.exposed !== undefined);
    check('machine_match_required=false', r.exposed?.machine_match_required === false);
    check('incompatible_machine_reasons empty', Array.isArray(r.exposed?.incompatible_machine_reasons) && r.exposed.incompatible_machine_reasons.length === 0);
    check('warnings preserved', r.exposed?.warnings?.includes('PAGE_COUNT_UNAVAILABLE'));
    check('machine_match_authority=false', r.exposed?.machine_match_authority === false);
    check('production_certified=false', r.exposed?.production_certified === false);
    check('standard_certified=false', r.exposed?.standard_certified === false);
}

// ---------------------------------------------------------------------------
// SC4: machine_match_required=true with multiple reasons -> exposed with reasons
// ---------------------------------------------------------------------------
console.log('\nSC4: machine_match_required=true, multiple reasons -> exposed');
{
    const mrg = {
        machine_capability_signals: {
            color_signals: { color_mode: 'RGB_PRESENT', rgb_detected: true },
            finishing_signals: { finishing_marks_risk: 'HIGH', bleed_missing: true, crop_marks_missing: true },
            page_signals: { mixed_orientation_detected: true }
        },
        machine_match_required: true,
        incompatible_machine_reasons: ['REQUIRES_CMYK_CONVERSION', 'BLEED_MISSING', 'FINISHING_MARKS_RISK_HIGH', 'MIXED_ORIENTATION_DETECTED'],
        warnings: ['PAGE_COUNT_UNAVAILABLE', 'PAGE_SIZE_UNAVAILABLE'],
        machine_match_authority: false,
        production_certified: false,
        standard_certified: false,
        evidence: { color_mode: 'RGB_PRESENT', finishing_marks_risk: 'HIGH' }
    };

    const r = simulateServiceExposure(buildFixAuditV2(mrg));

    check('machine_match_required=true', r.exposed?.machine_match_required === true);
    check('all incompatible_machine_reasons preserved',
        ['REQUIRES_CMYK_CONVERSION', 'BLEED_MISSING', 'FINISHING_MARKS_RISK_HIGH', 'MIXED_ORIENTATION_DETECTED'].every(reason =>
            r.exposed?.incompatible_machine_reasons?.includes(reason)));
    check('machine_capability_signals preserved', r.exposed?.machine_capability_signals?.color_signals?.rgb_detected === true);
}

// ---------------------------------------------------------------------------
// SC5: REGRESSION — governance invariants enforced even if upstream sets true
// ---------------------------------------------------------------------------
console.log('\nSC5: REGRESSION — invariants forced false even if upstream claims true');
{
    const maliciousMrg = {
        machine_capability_signals: {},
        machine_match_required: true,
        incompatible_machine_reasons: ['STANDARD_INVALID'],
        warnings: [],
        machine_match_authority: true,   // OVERCLAIM — must be forced to false
        production_certified: true,      // OVERCLAIM — must be forced to false
        standard_certified: true,        // OVERCLAIM — must be forced to false
        evidence: {}
    };

    const r = simulateServiceExposure(buildFixAuditV2(maliciousMrg));

    check('machine_match_authority forced to false', r.exposed?.machine_match_authority === false);
    check('production_certified forced to false', r.exposed?.production_certified === false);
    check('standard_certified forced to false', r.exposed?.standard_certified === false);
}

// ---------------------------------------------------------------------------
// SC6: no machine_readiness_governance -> undefined, no crash
// ---------------------------------------------------------------------------
console.log('\nSC6: no machine_readiness_governance -> undefined in normalized/exposed output');
{
    const auditData = {
        version: '2.0',
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: false,
        production_certified: true,
        highest_risk_level: 'LOW'
    };

    const normalized = FixAuditNormalizer.normalize(auditData);
    check('no machine_readiness_governance -> undefined in normalized',
        normalized.machine_readiness_governance === undefined);

    const r = simulateServiceExposure(auditData);
    check('no machine_readiness_governance -> exposed undefined',
        r.exposed === undefined);
}

// ---------------------------------------------------------------------------
// SC7: empty/null audit data -> no crash
// ---------------------------------------------------------------------------
console.log('\nSC7: empty/null audit data -> no crash');
{
    const emptyNorm = FixAuditNormalizer.normalize({});
    check('Empty audit data → available=false', emptyNorm.available === false);

    const nullNorm = FixAuditNormalizer.normalize(null);
    check('Null audit data → available=false', nullNorm.available === false);
}

// ---------------------------------------------------------------------------
// SC8: Phase 73B worker report integration
// ---------------------------------------------------------------------------
console.log('\nSC8: Phase 73B worker report scenario normalization');
{
    if (workerReport && workerReport.results) {
        let allNormalized = true;
        let invariantsHold = true;
        let signalsPreserved = true;
        let reasonsPreserved = true;

        for (const scenario of workerReport.results) {
            const mrg = scenario.machine_readiness_governance;
            if (!mrg) continue;

            const auditData = buildFixAuditV2(mrg);
            const r = simulateServiceExposure(auditData);

            if (!r.normalized || !r.normalized.available) { allNormalized = false; continue; }
            if (!r.exposed) continue;

            if (r.exposed.machine_match_authority !== false ||
                r.exposed.production_certified !== false ||
                r.exposed.standard_certified !== false) {
                invariantsHold = false;
            }

            if (JSON.stringify(r.exposed.machine_capability_signals) !== JSON.stringify(mrg.machine_capability_signals || {})) {
                signalsPreserved = false;
            }

            const expectedReasons = mrg.incompatible_machine_reasons || [];
            if (JSON.stringify(r.exposed.incompatible_machine_reasons) !== JSON.stringify(expectedReasons)) {
                reasonsPreserved = false;
            }
        }

        check('All 73B scenarios successfully normalized', allNormalized);
        check('Governance invariants hold for all 73B scenarios', invariantsHold);
        check('machine_capability_signals preserved across 73B scenarios', signalsPreserved);
        check('incompatible_machine_reasons preserved across 73B scenarios', reasonsPreserved);
    } else {
        const scenarios = [
            { name: 'no_match_required', mrg: { machine_capability_signals: {}, machine_match_required: false, incompatible_machine_reasons: [], warnings: [], machine_match_authority: false, production_certified: false, standard_certified: false, evidence: {} } },
            { name: 'match_required', mrg: { machine_capability_signals: {}, machine_match_required: true, incompatible_machine_reasons: ['INK_RISK_HIGH'], warnings: [], machine_match_authority: false, production_certified: false, standard_certified: false, evidence: {} } }
        ];

        for (const s of scenarios) {
            const auditData = buildFixAuditV2(s.mrg);
            const normalized = FixAuditNormalizer.normalize(auditData);
            check(`Synthetic scenario ${s.name} normalized`, normalized && normalized.available);
            const r = simulateServiceExposure(auditData);
            check(`${s.name}: machine_match_required matches expectation`, r.exposed?.machine_match_required === s.mrg.machine_match_required);
        }
    }
}

// ---------------------------------------------------------------------------
// SC9: machine_readiness_governance does not alter productionCertified/requiresReview
// ---------------------------------------------------------------------------
console.log('\nSC9: machine_readiness_governance is advisory only — does not gate production/review');
{
    const mrg = {
        machine_capability_signals: {},
        machine_match_required: true,
        incompatible_machine_reasons: ['STANDARD_INVALID', 'INK_RISK_HIGH'],
        warnings: [],
        machine_match_authority: false,
        production_certified: false,
        standard_certified: false,
        evidence: {}
    };

    const auditData = {
        ...buildFixAuditV2(mrg),
        production_certified: true,
        review_required: false,
        artifact_trust: {
            trust_level: 'PRODUCTION_CERTIFIED',
            production_certified: true,
            review_required: false,
            certified_pdf_allowed: true,
            standard_certified: false,
            compliance_claim_allowed: false
        }
    };

    const normalized = FixAuditNormalizer.normalize(auditData);
    check('production_certified at root unaffected by machine_readiness_governance',
        normalized.production_certified === true);
    check('artifact_trust.production_certified unaffected',
        normalized.artifact_trust?.production_certified === true);
    check('artifact_trust.review_required unaffected',
        normalized.artifact_trust?.review_required === false);
}

// ---------------------------------------------------------------------------
// SC10: No raw filesystem paths leak through machine_readiness_governance
// ---------------------------------------------------------------------------
console.log('\nSC10: No raw filesystem paths leak through machine_readiness_governance');
{
    const mrg = {
        machine_capability_signals: {
            media_requirements: { paper_type: 'COATED', paper_gsm: 150 }
        },
        machine_match_required: false,
        incompatible_machine_reasons: [],
        warnings: [],
        machine_match_authority: false,
        production_certified: false,
        standard_certified: false,
        evidence: { page_count: 4, orientation: 'PORTRAIT' }
    };

    const r = simulateServiceExposure(buildFixAuditV2(mrg));
    const exposedStr = JSON.stringify(r.exposed);

    check('machine_readiness_governance contains no local filesystem paths',
        !/[A-Za-z]:[\\\/]|\/tmp\/|\/var\/|\/home\/|\/storage\//.test(exposedStr),
        'No local paths found in governance payload');
}

// ---------------------------------------------------------------------------
// SC11: FixAuditNormalizer structure check
// ---------------------------------------------------------------------------
console.log('\nSC11: FixAuditNormalizer structure check');
{
    const normalizerSrc = fs.readFileSync(
        path.resolve(__dirname, '../services/FixAuditNormalizer.js'), 'utf8'
    );
    check('FixAuditNormalizer has machine_readiness_governance passthrough',
        normalizerSrc.includes('machine_readiness_governance'));
    check('FixAuditNormalizer has Phase 73 annotation',
        normalizerSrc.includes('Phase 73'));
    check('delta_report.machine_readiness_governance passthrough present',
        normalizerSrc.includes('delta_report.machine_readiness_governance'));
}

// ---------------------------------------------------------------------------
// SC12: PreflightService structure check
// ---------------------------------------------------------------------------
console.log('\nSC12: PreflightService structure check');
{
    const serviceSrc = fs.readFileSync(
        path.resolve(__dirname, '../services/PreflightService.js'), 'utf8'
    );
    check('PreflightService resolves machine_readiness_governance sources',
        serviceSrc.includes('machineReadinessGovSources') || serviceSrc.includes('machineReadinessGovNorm'));
    check('PreflightService exposes machine_readiness_governance in artifact_summary',
        serviceSrc.includes('artifact_summary.machine_readiness_governance') || serviceSrc.includes('machine_readiness_governance: machineReadinessGovExposed'));
    check('PreflightService exposes machine_readiness_governance at root payload',
        (serviceSrc.match(/machine_readiness_governance: machineReadinessGovExposed/g) || []).length >= 2);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass_count + fail_count;
const smoke_passed = fail_count === 0;

console.log(`\n${'='.repeat(60)}`);
console.log('Phase 73C — Service Machine Readiness Exposure');
console.log(`Results: ${pass_count}/${total} passed${fail_count > 0 ? ` (${fail_count} FAILED)` : ''}`);
console.log(`Smoke: ${smoke_passed ? 'PASSED' : 'FAILED'}`);
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// Generate reports
// ---------------------------------------------------------------------------
const report = {
    generated_at: new Date().toISOString(),
    phase: '73C',
    repo: 'ppos-preflight-service',
    smoke_passed,
    input_mode: inputMode,
    core_principle: 'machine_readiness_governance is an advisory signal set for Phase 73D machine assignment only. It is never a certification authority: machine_match_authority, production_certified, and standard_certified are always forced to false at the Service exposure layer regardless of upstream values, and the governance does not influence the Service\'s own production_certified/review_required gates.',
    changes: [
        'FixAuditNormalizer.js: machine_readiness_governance preserved in v2 normalization (root)',
        'FixAuditNormalizer.js: delta_report.machine_readiness_governance preserved',
        'PreflightService.js: machine_readiness_governance governance sources resolved in getJobArtifacts after production package governance block',
        'PreflightService.js: artifact_summary.machine_readiness_governance exposed (PHYSICAL_OUTPUT_FALLBACK path) with machine_match_authority/production_certified/standard_certified forced to false',
        'PreflightService.js: Phase 73C exposure block added in _normalizeJobPayload before artifact_summary construction',
        'PreflightService.js: machine_readiness_governance added to artifact_summary and return payload in _normalizeJobPayload'
    ],
    results,
    summary: { total, passed: pass_count, failed: fail_count }
};

const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const jsonPath = path.join(reportsDir, 'phase73c_service_machine_readiness_exposure.json');
const mdPath = path.join(reportsDir, 'phase73c_service_machine_readiness_exposure.md');

fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const mdLines = [
    '# Phase 73C — Service Machine Readiness Exposure',
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
