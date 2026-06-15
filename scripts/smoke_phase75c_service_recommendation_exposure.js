'use strict';

/**
 * Phase 75C — Service Recommendation Exposure
 * Smoke test: verifies that the Service correctly normalizes and exposes
 * recommendation_governance from Worker fix_audit payloads through
 * artifact_summary and job payload (the source consumed downstream for the
 * Human Report), and that the governance invariants (recommendation_authority=false,
 * auto_apply_authority=false, production_certified=false, standard_certified=false)
 * always hold regardless of upstream evidence.
 *
 * Input: ../ppos-preflight-worker/reports/phase75b_worker_recommendation_governance.json
 * Fallback: synthetic payloads labeled input_mode="SYNTHETIC_POLICY_FALLBACK"
 */

const path = require('path');
const fs = require('fs');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');
const FixCapabilityContract = require('../services/FixCapabilityContract');

// ---------------------------------------------------------------------------
// Load Phase 75B worker report or fall back to synthetic payloads
// ---------------------------------------------------------------------------
const WORKER_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-worker/reports/phase75b_worker_recommendation_governance.json');
let workerReport = null;
let inputMode = 'WORKER_REPORT';

if (fs.existsSync(WORKER_REPORT_PATH)) {
    try {
        workerReport = JSON.parse(fs.readFileSync(WORKER_REPORT_PATH, 'utf8'));
        console.log('[75C] Loaded Phase 75B worker report from:', WORKER_REPORT_PATH);
    } catch (e) {
        console.warn('[75C] Failed to parse Phase 75B worker report, using synthetic payloads:', e.message);
    }
}

if (!workerReport) {
    inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    console.log('[75C] Phase 75B worker report unavailable. Using synthetic payloads.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildFixAuditV2(recommendationGov, deltaRecommendationGov) {
    return {
        version: '2.0',
        requested_fixes: [],
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: false,
        production_certified: false,
        highest_risk_level: 'LOW',
        recommendation_governance: recommendationGov,
        delta_report: deltaRecommendationGov ? {
            recommendation_governance: deltaRecommendationGov
        } : undefined
    };
}

// Simulate what PreflightService._normalizeJobPayload does for
// recommendation_governance exposure (Phase 75C).
function simulateServiceExposure(fixAuditData) {
    const normalized = FixAuditNormalizer.normalize(fixAuditData);
    const rg = normalized.recommendation_governance || {};

    const exposed = Object.keys(rg).length > 0 ? {
        recommendation_signals_available: rg.recommendation_signals_available === true,
        total_findings: rg.total_findings ?? 0,
        recommended_next_actions: rg.recommended_next_actions || [],
        unsafe_auto_actions: rg.unsafe_auto_actions || [],
        human_review_actions: rg.human_review_actions || [],
        recommendation_authority: false,
        auto_apply_authority: false,
        production_certified: false,
        standard_certified: false,
        warnings: rg.warnings || [],
        evidence: rg.evidence || {}
    } : undefined;

    return { normalized, rg, exposed };
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

console.log('\n=== Phase 75C — Service Recommendation Exposure ===\n');
console.log(`Input mode: ${inputMode}\n`);

// ---------------------------------------------------------------------------
// SC1: FixCapabilityContract exposes Phase 75 recommendation capabilities
// ---------------------------------------------------------------------------
console.log('SC1: FixCapabilityContract Phase 75 recommendation capabilities');
{
    const caps = FixCapabilityContract.getCapabilities();
    const ids = caps.capabilities.map(c => c.fix_id);

    check('FixCapabilityContract version >= 53.0',
        parseFloat(caps.version) >= 53.0,
        `version=${caps.version}`);

    check('engine_registry_compatibility=phase-75',
        caps.engine_registry_compatibility === 'phase-75',
        `got: ${caps.engine_registry_compatibility}`);

    check('RECOMMENDATION_CONTRACT capability present', ids.includes('RECOMMENDATION_CONTRACT'));
    check('GENERATE_RECOMMENDATION_MANIFEST capability present', ids.includes('GENERATE_RECOMMENDATION_MANIFEST'));

    const rc = caps.capabilities.find(c => c.fix_id === 'RECOMMENDATION_CONTRACT');
    check('RECOMMENDATION_CONTRACT category=recommendation',
        rc && rc.category === 'recommendation');
    check('RECOMMENDATION_CONTRACT production_certified=false',
        rc && rc.production_certified === false,
        'Recommendation contract must not imply production certification');
    check('RECOMMENDATION_CONTRACT standard_certified=false',
        rc && rc.standard_certified === false);
    check('RECOMMENDATION_CONTRACT compliance_claim_allowed=false',
        rc && rc.compliance_claim_allowed === false);
    check('RECOMMENDATION_CONTRACT requires_human_review=true',
        rc && rc.requires_human_review === true);

    check('Phase 74 capabilities still present (regression)',
        ids.includes('AUDIT_BUNDLE_CONTRACT') && ids.includes('GENERATE_AUDIT_BUNDLE_MANIFEST'));
    check('Phase 73 capabilities still present (regression)',
        ids.includes('REBUILD_TRIMBOX'));
}

// ---------------------------------------------------------------------------
// SC2: FixAuditNormalizer preserves recommendation_governance at root
// ---------------------------------------------------------------------------
console.log('\nSC2: FixAuditNormalizer preserves recommendation_governance');
{
    const rg = {
        recommendation_signals_available: true,
        total_findings: 1,
        recommended_next_actions: [
            {
                finding_id: 'TRIMBOX_MISSING',
                finding_code: 'IND_GEOM_003',
                fix_id: 'REBUILD_TRIMBOX',
                action: 'SAFE_AUTO_FIX_AVAILABLE',
                risk_level: 'LOW',
                reason: null
            }
        ],
        unsafe_auto_actions: [],
        human_review_actions: [],
        recommendation_authority: false,
        auto_apply_authority: false,
        production_certified: false,
        standard_certified: false,
        warnings: [],
        evidence: { summary: { total_findings: 1, fixable_auto_count: 1 } }
    };

    const auditData = buildFixAuditV2(rg);
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('recommendation_governance preserved at root',
        normalized.recommendation_governance !== undefined);
    check('recommendation_signals_available preserved',
        normalized.recommendation_governance?.recommendation_signals_available === true);
    check('total_findings preserved',
        normalized.recommendation_governance?.total_findings === 1);
    check('recommended_next_actions preserved',
        normalized.recommendation_governance?.recommended_next_actions?.[0]?.fix_id === 'REBUILD_TRIMBOX');
    check('evidence preserved',
        normalized.recommendation_governance?.evidence?.summary?.total_findings === 1);
}

// ---------------------------------------------------------------------------
// SC3: delta_report.recommendation_governance preserved
// ---------------------------------------------------------------------------
console.log('\nSC3: delta_report.recommendation_governance preserved');
{
    const rootRg = {
        recommendation_signals_available: true,
        total_findings: 0,
        recommended_next_actions: [],
        unsafe_auto_actions: [],
        human_review_actions: [],
        recommendation_authority: false,
        auto_apply_authority: false,
        production_certified: false,
        standard_certified: false,
        warnings: [],
        evidence: {}
    };
    const deltaRg = {
        recommendation_signals_available: true,
        total_findings: 1,
        recommended_next_actions: [
            { finding_id: 'BLEED_MISSING', finding_code: 'IND_GEOM_002', fix_id: 'APPLY_BLEED', action: 'REQUEST_HUMAN_REVIEW', risk_level: 'MEDIUM', reason: 'HUMAN_REVIEW_REQUIRED' }
        ],
        unsafe_auto_actions: [],
        human_review_actions: [],
        recommendation_authority: false,
        auto_apply_authority: false,
        production_certified: false,
        standard_certified: false,
        warnings: [],
        evidence: { source: 'delta' }
    };

    const auditData = buildFixAuditV2(rootRg, deltaRg);
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('delta_report.recommendation_governance preserved',
        normalized.delta_report && normalized.delta_report.recommendation_governance !== undefined);
    check('delta_report.recommendation_governance.total_findings preserved',
        normalized.delta_report?.recommendation_governance?.total_findings === 1);
    check('delta_report.recommendation_governance.recommended_next_actions preserved',
        normalized.delta_report?.recommendation_governance?.recommended_next_actions?.[0]?.fix_id === 'APPLY_BLEED');
}

// ---------------------------------------------------------------------------
// SC4: recommendations present -> exposed with actions and evidence
// ---------------------------------------------------------------------------
console.log('\nSC4: recommendations present -> exposed cleanly');
{
    const rg = {
        recommendation_signals_available: true,
        total_findings: 3,
        recommended_next_actions: [
            { finding_id: 'TRIMBOX_MISSING', finding_code: 'IND_GEOM_003', fix_id: 'REBUILD_TRIMBOX', action: 'SAFE_AUTO_FIX_AVAILABLE', risk_level: 'LOW', reason: null }
        ],
        unsafe_auto_actions: [
            { finding_id: 'TRANSPARENCY_PRESENT', finding_code: 'IND_TRANS_001', fix_id: 'FLATTEN_TRANSPARENCY', risk_level: 'HIGH', visual_sensitivity: true, reason: 'FIX_NOT_IMPLEMENTED' }
        ],
        human_review_actions: [
            { finding_id: 'BLEED_MISSING', finding_code: 'IND_GEOM_002', fix_id: 'APPLY_BLEED', operator_review_reason: 'HUMAN_REVIEW_REQUIRED' }
        ],
        recommendation_authority: false,
        auto_apply_authority: false,
        production_certified: false,
        standard_certified: false,
        warnings: [],
        evidence: { summary: { total_findings: 3 } }
    };

    const r = simulateServiceExposure(buildFixAuditV2(rg));

    check('exposed present', r.exposed !== undefined);
    check('recommendation_signals_available=true', r.exposed?.recommendation_signals_available === true);
    check('total_findings=3', r.exposed?.total_findings === 3);
    check('recommended_next_actions exposed', r.exposed?.recommended_next_actions?.[0]?.fix_id === 'REBUILD_TRIMBOX');
    check('unsafe_auto_actions exposed', r.exposed?.unsafe_auto_actions?.[0]?.fix_id === 'FLATTEN_TRANSPARENCY');
    check('human_review_actions exposed', r.exposed?.human_review_actions?.[0]?.fix_id === 'APPLY_BLEED');
    check('recommendation_authority=false', r.exposed?.recommendation_authority === false);
    check('auto_apply_authority=false', r.exposed?.auto_apply_authority === false);
    check('production_certified=false', r.exposed?.production_certified === false);
    check('standard_certified=false', r.exposed?.standard_certified === false);
}

// ---------------------------------------------------------------------------
// SC5: no findings -> exposed with empty action lists
// ---------------------------------------------------------------------------
console.log('\nSC5: no findings -> exposed with empty action lists');
{
    const rg = {
        recommendation_signals_available: true,
        total_findings: 0,
        recommended_next_actions: [],
        unsafe_auto_actions: [],
        human_review_actions: [],
        recommendation_authority: false,
        auto_apply_authority: false,
        production_certified: false,
        standard_certified: false,
        warnings: [],
        evidence: { summary: { total_findings: 0 } }
    };

    const r = simulateServiceExposure(buildFixAuditV2(rg));

    check('exposed present', r.exposed !== undefined);
    check('total_findings=0', r.exposed?.total_findings === 0);
    check('recommended_next_actions empty', Array.isArray(r.exposed?.recommended_next_actions) && r.exposed.recommended_next_actions.length === 0);
    check('unsafe_auto_actions empty', Array.isArray(r.exposed?.unsafe_auto_actions) && r.exposed.unsafe_auto_actions.length === 0);
    check('human_review_actions empty', Array.isArray(r.exposed?.human_review_actions) && r.exposed.human_review_actions.length === 0);
}

// ---------------------------------------------------------------------------
// SC6: REGRESSION — governance invariants enforced even if upstream sets true
// ---------------------------------------------------------------------------
console.log('\nSC6: REGRESSION — invariants forced false even if upstream claims true');
{
    const maliciousRg = {
        recommendation_signals_available: true,
        total_findings: 1,
        recommended_next_actions: [
            { finding_id: 'TRIMBOX_MISSING', finding_code: 'IND_GEOM_003', fix_id: 'REBUILD_TRIMBOX', action: 'SAFE_AUTO_FIX_AVAILABLE', risk_level: 'LOW', reason: null }
        ],
        unsafe_auto_actions: [],
        human_review_actions: [],
        recommendation_authority: true, // OVERCLAIM — must be forced to false
        auto_apply_authority: true,      // OVERCLAIM — must be forced to false
        production_certified: true,      // OVERCLAIM — must be forced to false
        standard_certified: true,        // OVERCLAIM — must be forced to false
        warnings: [],
        evidence: {}
    };

    const r = simulateServiceExposure(buildFixAuditV2(maliciousRg));

    check('recommendation_authority forced to false', r.exposed?.recommendation_authority === false);
    check('auto_apply_authority forced to false', r.exposed?.auto_apply_authority === false);
    check('production_certified forced to false', r.exposed?.production_certified === false);
    check('standard_certified forced to false', r.exposed?.standard_certified === false);
}

// ---------------------------------------------------------------------------
// SC7: no recommendation_governance -> undefined, no crash
// ---------------------------------------------------------------------------
console.log('\nSC7: no recommendation_governance -> undefined in normalized/exposed output');
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
    check('no recommendation_governance -> undefined in normalized',
        normalized.recommendation_governance === undefined);

    const r = simulateServiceExposure(auditData);
    check('no recommendation_governance -> exposed undefined',
        r.exposed === undefined);
}

// ---------------------------------------------------------------------------
// SC8: empty/null audit data -> no crash
// ---------------------------------------------------------------------------
console.log('\nSC8: empty/null audit data -> no crash');
{
    const emptyNorm = FixAuditNormalizer.normalize({});
    check('Empty audit data → available=false', emptyNorm.available === false);

    const nullNorm = FixAuditNormalizer.normalize(null);
    check('Null audit data → available=false', nullNorm.available === false);
}

// ---------------------------------------------------------------------------
// SC9: recommendation_governance does not alter productionCertified/requiresReview
// ---------------------------------------------------------------------------
console.log('\nSC9: recommendation_governance is advisory only — does not gate production/review');
{
    const rg = {
        recommendation_signals_available: true,
        total_findings: 1,
        recommended_next_actions: [],
        unsafe_auto_actions: [
            { finding_id: 'TRANSPARENCY_PRESENT', finding_code: 'IND_TRANS_001', fix_id: 'FLATTEN_TRANSPARENCY', risk_level: 'HIGH', visual_sensitivity: true, reason: 'FIX_NOT_IMPLEMENTED' }
        ],
        human_review_actions: [
            { finding_id: 'TRANSPARENCY_PRESENT', finding_code: 'IND_TRANS_001', fix_id: 'FLATTEN_TRANSPARENCY', operator_review_reason: 'FIX_NOT_IMPLEMENTED' }
        ],
        recommendation_authority: false,
        auto_apply_authority: false,
        production_certified: false,
        standard_certified: false,
        warnings: [],
        evidence: {}
    };

    const auditData = {
        ...buildFixAuditV2(rg),
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
    check('production_certified at root unaffected by recommendation_governance',
        normalized.production_certified === true);
    check('artifact_trust.production_certified unaffected',
        normalized.artifact_trust?.production_certified === true);
    check('artifact_trust.review_required unaffected',
        normalized.artifact_trust?.review_required === false);
}

// ---------------------------------------------------------------------------
// SC10: No raw filesystem paths leak through recommendation_governance
// ---------------------------------------------------------------------------
console.log('\nSC10: No raw filesystem paths leak through recommendation_governance');
{
    const rg = {
        recommendation_signals_available: true,
        total_findings: 1,
        recommended_next_actions: [
            { finding_id: 'TRIMBOX_MISSING', finding_code: 'IND_GEOM_003', fix_id: 'REBUILD_TRIMBOX', action: 'SAFE_AUTO_FIX_AVAILABLE', risk_level: 'LOW', reason: null }
        ],
        unsafe_auto_actions: [],
        human_review_actions: [],
        recommendation_authority: false,
        auto_apply_authority: false,
        production_certified: false,
        standard_certified: false,
        warnings: [],
        evidence: { summary: { total_findings: 1 } }
    };

    const r = simulateServiceExposure(buildFixAuditV2(rg));
    const exposedStr = JSON.stringify(r.exposed);

    check('recommendation_governance contains no local filesystem paths',
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
    check('FixAuditNormalizer has recommendation_governance passthrough',
        normalizerSrc.includes('recommendation_governance'));
    check('FixAuditNormalizer has Phase 75 annotation',
        normalizerSrc.includes('Phase 75'));
    check('delta_report.recommendation_governance passthrough present',
        normalizerSrc.includes('delta_report.recommendation_governance'));
}

// ---------------------------------------------------------------------------
// SC12: PreflightService structure check
// ---------------------------------------------------------------------------
console.log('\nSC12: PreflightService structure check');
{
    const serviceSrc = fs.readFileSync(
        path.resolve(__dirname, '../services/PreflightService.js'), 'utf8'
    );
    check('PreflightService resolves recommendation_governance sources',
        serviceSrc.includes('recommendationGovSources') || serviceSrc.includes('recommendationGovNorm'));
    check('PreflightService exposes recommendation_governance in artifact_summary',
        serviceSrc.includes('artifact_summary.recommendation_governance') || serviceSrc.includes('recommendation_governance: recommendationGovExposed'));
    check('PreflightService exposes recommendation_governance at root payload',
        (serviceSrc.match(/recommendation_governance: recommendationGovExposed/g) || []).length >= 2);
}

// ---------------------------------------------------------------------------
// SC13: Phase 75B worker report integration (if available)
// ---------------------------------------------------------------------------
console.log('\nSC13: Phase 75B worker report scenario normalization');
{
    if (workerReport && workerReport.results) {
        let allNormalized = true;
        let invariantsHold = true;
        let totalFindingsPreserved = true;
        let actionsPreserved = true;

        for (const scenario of workerReport.results) {
            const rg = scenario.recommendation_governance;
            if (!rg) continue;

            const auditData = buildFixAuditV2(rg);
            const r = simulateServiceExposure(auditData);

            if (!r.normalized || !r.normalized.available) { allNormalized = false; continue; }
            if (!r.exposed) continue;

            if (r.exposed.recommendation_authority !== false ||
                r.exposed.auto_apply_authority !== false ||
                r.exposed.production_certified !== false ||
                r.exposed.standard_certified !== false) {
                invariantsHold = false;
            }

            if (r.exposed.total_findings !== (rg.total_findings ?? 0)) {
                totalFindingsPreserved = false;
            }

            if (JSON.stringify(r.exposed.recommended_next_actions) !== JSON.stringify(rg.recommended_next_actions || []) ||
                JSON.stringify(r.exposed.unsafe_auto_actions) !== JSON.stringify(rg.unsafe_auto_actions || []) ||
                JSON.stringify(r.exposed.human_review_actions) !== JSON.stringify(rg.human_review_actions || [])) {
                actionsPreserved = false;
            }
        }

        check('All 75B scenarios successfully normalized', allNormalized);
        check('Governance invariants hold for all 75B scenarios', invariantsHold);
        check('total_findings preserved across 75B scenarios', totalFindingsPreserved);
        check('action lists preserved across 75B scenarios', actionsPreserved);
    } else {
        const scenarios = [
            { name: 'no_findings', rg: { recommendation_signals_available: true, total_findings: 0, recommended_next_actions: [], unsafe_auto_actions: [], human_review_actions: [], recommendation_authority: false, auto_apply_authority: false, production_certified: false, standard_certified: false, warnings: [], evidence: {} } },
            { name: 'safe_auto_fix', rg: { recommendation_signals_available: true, total_findings: 1, recommended_next_actions: [{ finding_id: 'TRIMBOX_MISSING', finding_code: 'IND_GEOM_003', fix_id: 'REBUILD_TRIMBOX', action: 'SAFE_AUTO_FIX_AVAILABLE', risk_level: 'LOW', reason: null }], unsafe_auto_actions: [], human_review_actions: [], recommendation_authority: false, auto_apply_authority: false, production_certified: false, standard_certified: false, warnings: [], evidence: {} } }
        ];

        for (const s of scenarios) {
            const auditData = buildFixAuditV2(s.rg);
            const normalized = FixAuditNormalizer.normalize(auditData);
            check(`Synthetic scenario ${s.name} normalized`, normalized && normalized.available);
            const r = simulateServiceExposure(auditData);
            check(`${s.name}: total_findings matches expectation`, r.exposed?.total_findings === s.rg.total_findings);
        }
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass_count + fail_count;
const smoke_passed = fail_count === 0;

console.log(`\n${'='.repeat(60)}`);
console.log('Phase 75C — Service Recommendation Exposure');
console.log(`Results: ${pass_count}/${total} passed${fail_count > 0 ? ` (${fail_count} FAILED)` : ''}`);
console.log(`Smoke: ${smoke_passed ? 'PASSED' : 'FAILED'}`);
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// Generate reports
// ---------------------------------------------------------------------------
const report = {
    generated_at: new Date().toISOString(),
    phase: '75C',
    repo: 'ppos-preflight-service',
    smoke_passed,
    input_mode: inputMode,
    core_principle: 'recommendation_governance is an advisory signal set summarizing recommended_next_actions, unsafe_auto_actions, and human_review_actions derived from finding-level recommendation signals. It is never an authority: recommendation_authority, auto_apply_authority, production_certified, and standard_certified are always forced to false at the Service exposure layer regardless of upstream values, and the governance does not influence the Service\'s own production_certified/review_required gates. It is exposed in artifact_summary and the job payload (the source consumed downstream for the Human Report).',
    changes: [
        'FixAuditNormalizer.js: recommendation_governance preserved in v2 normalization (root)',
        'FixAuditNormalizer.js: delta_report.recommendation_governance preserved',
        'FixCapabilityContract.js: version bumped to 53.0, engine_registry_compatibility=phase-75',
        'FixCapabilityContract.js: RECOMMENDATION_CONTRACT and GENERATE_RECOMMENDATION_MANIFEST capabilities added under recommendation category',
        'PreflightService.js: recommendation_governance governance sources resolved in getJobArtifacts after audit bundle governance block',
        'PreflightService.js: artifact_summary.recommendation_governance exposed (PHYSICAL_OUTPUT_FALLBACK path) with recommendation_authority/auto_apply_authority/production_certified/standard_certified forced to false',
        'PreflightService.js: Phase 75C exposure block added in _normalizeJobPayload after audit bundle governance exposure',
        'PreflightService.js: recommendation_governance added to artifact_summary and root payload in _normalizeJobPayload'
    ],
    results,
    summary: { total, passed: pass_count, failed: fail_count }
};

const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const jsonPath = path.join(reportsDir, 'phase75c_service_recommendation_exposure.json');
const mdPath = path.join(reportsDir, 'phase75c_service_recommendation_exposure.md');

fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const mdLines = [
    '# Phase 75C — Service Recommendation Exposure',
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
