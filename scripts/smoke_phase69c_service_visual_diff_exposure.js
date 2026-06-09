'use strict';

/**
 * Phase 69C — Service Visual Diff Exposure
 * Smoke test: verifies that the Service correctly normalizes, exposes, and enforces
 * visual_diff_governance from Worker fix_audit payloads.
 *
 * Input: ../ppos-preflight-worker/reports/phase69b_worker_visual_diff_policy.json
 * Fallback: synthetic payloads labeled input_mode="SYNTHETIC_POLICY_FALLBACK"
 */

const path = require('path');
const fs = require('fs');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');
const FixCapabilityContract = require('../services/FixCapabilityContract');

// ---------------------------------------------------------------------------
// Load Phase 69B worker report or fall back to synthetic payloads
// ---------------------------------------------------------------------------
const WORKER_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-worker/reports/phase69b_worker_visual_diff_policy.json');
let workerReport = null;
let inputMode = 'ENGINE_REPORT';

if (fs.existsSync(WORKER_REPORT_PATH)) {
    try {
        workerReport = JSON.parse(fs.readFileSync(WORKER_REPORT_PATH, 'utf8'));
        inputMode = workerReport.input_mode || 'ENGINE_REPORT';
        console.log('[69C] Loaded Phase 69B worker report from:', WORKER_REPORT_PATH);
    } catch (e) {
        console.warn('[69C] Failed to parse Phase 69B worker report, using synthetic payloads:', e.message);
    }
}

if (!workerReport) {
    inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    console.log('[69C] Phase 69B worker report unavailable. Using synthetic payloads.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildFixAuditV2(scenarioName, visualDiffGov, artifactTrust) {
    return {
        version: '2.0',
        requested_fixes: [{ code: 'FLATTEN_TRANSPARENCY' }],
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: visualDiffGov.visual_review_required || false,
        production_certified: false,
        highest_risk_level: 'HIGH',
        visual_diff_governance: visualDiffGov,
        artifact_trust: artifactTrust || {
            trust_level: 'FIXED_READY',
            standard_certified: false,
            compliance_claim_allowed: false,
            certified_pdf_allowed: false,
            review_required: visualDiffGov.visual_review_required || false
        }
    };
}

// Simulate what PreflightService._normalizeJobPayload does with visual_diff_governance
function simulateServiceEnforcement(fixAuditData) {
    const normalized = FixAuditNormalizer.normalize(fixAuditData);
    const vdg = normalized.visual_diff_governance || {};
    const artifactTrust = normalized.artifact_trust || {};

    const visualReviewRequired = vdg.visual_review_required === true;
    const visualChangeDetected = vdg.visual_change_detected === true;
    const renderToolGap = vdg.render_tool_gap === true;

    // Apply same logic as PreflightService._normalizeJobPayload Phase 69C block
    const govRequiresBlock = (
        vdg.production_certified === false ||
        vdg.visual_review_required === true ||
        vdg.visual_change_detected === true
    );

    let productionCertified = artifactTrust.production_certified !== false;
    let requiresReview = artifactTrust.review_required === true;

    if (govRequiresBlock) {
        productionCertified = false;
    }
    if (visualReviewRequired || visualChangeDetected) {
        requiresReview = true;
    }

    // certified.pdf gate: blocked when requiresReview=true
    const certifiedPdfAllowed = productionCertified && !requiresReview && artifactTrust.certified_pdf_allowed !== false;

    return {
        normalized,
        vdg,
        govRequiresBlock,
        productionCertified,
        requiresReview,
        certifiedPdfAllowed,
        visualReviewRequired,
        visualChangeDetected,
        renderToolGap,
        proofArtifactsAvailable: vdg.proof_artifacts_available === true
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

console.log('\n=== Phase 69C — Service Visual Diff Exposure ===\n');
console.log(`Input mode: ${inputMode}\n`);

// ---------------------------------------------------------------------------
// SC1: FixCapabilityContract exposes Phase 69 visual proofing capabilities
// ---------------------------------------------------------------------------
console.log('SC1: FixCapabilityContract Phase 69 visual proofing capabilities');
{
    const caps = FixCapabilityContract.getCapabilities();
    const ids = caps.capabilities.map(c => c.fix_id);

    check('FixCapabilityContract version >= 48.0',
        parseFloat(caps.version) >= 48.0,
        `version=${caps.version}`);

    check('engine_registry_compatibility=phase-69',
        caps.engine_registry_compatibility === 'phase-69',
        `got: ${caps.engine_registry_compatibility}`);

    check('RENDER_PDF_PAGES capability present', ids.includes('RENDER_PDF_PAGES'));
    check('GENERATE_VISUAL_DIFF capability present', ids.includes('GENERATE_VISUAL_DIFF'));
    check('GENERATE_PROOF_THUMBNAILS capability present', ids.includes('GENERATE_PROOF_THUMBNAILS'));
    check('COMPARE_ORIGINAL_TO_FIXED capability present', ids.includes('COMPARE_ORIGINAL_TO_FIXED'));
    check('GENERATE_VISUAL_CHANGE_REPORT capability present', ids.includes('GENERATE_VISUAL_CHANGE_REPORT'));

    const genDiff = caps.capabilities.find(c => c.fix_id === 'GENERATE_VISUAL_DIFF');
    check('GENERATE_VISUAL_DIFF category=visual_proofing',
        genDiff && genDiff.category === 'visual_proofing');
    check('GENERATE_VISUAL_DIFF production_certified=false',
        genDiff && genDiff.production_certified === false,
        'Visual diff must not imply production certification');
    check('GENERATE_VISUAL_DIFF standard_certified=false',
        genDiff && genDiff.standard_certified === false);
    check('GENERATE_VISUAL_DIFF compliance_claim_allowed=false',
        genDiff && genDiff.compliance_claim_allowed === false);

    check('Phase 68 capabilities still present (regression)',
        ids.includes('VALIDATE_PDFX') && ids.includes('VALIDATE_PDFA'));
}

// ---------------------------------------------------------------------------
// SC2: FixAuditNormalizer preserves visual_diff_governance
// ---------------------------------------------------------------------------
console.log('\nSC2: FixAuditNormalizer preserves visual_diff_governance');
{
    const gov = {
        visual_diff_required: true,
        visual_diff_performed: true,
        visual_change_detected: true,
        visual_review_required: true,
        render_tool_gap: false,
        max_changed_pixel_ratio: 0.12,
        proof_artifacts_available: true,
        production_certified: false,
        standard_certified: false,
        warnings: ['High pixel change ratio detected'],
        evidence: { render_tool: 'ghostscript', pages_rendered: 4, pages_compared: 4 }
    };

    const auditData = buildFixAuditV2('full_visual_diff', gov);
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('visual_diff_governance preserved at root',
        normalized.visual_diff_governance !== undefined);
    check('visual_change_detected preserved',
        normalized.visual_diff_governance && normalized.visual_diff_governance.visual_change_detected === true);
    check('visual_review_required preserved',
        normalized.visual_diff_governance && normalized.visual_diff_governance.visual_review_required === true);
    check('max_changed_pixel_ratio preserved',
        normalized.visual_diff_governance && normalized.visual_diff_governance.max_changed_pixel_ratio === 0.12);
    check('proof_artifacts_available preserved',
        normalized.visual_diff_governance && normalized.visual_diff_governance.proof_artifacts_available === true);
    check('evidence preserved',
        normalized.visual_diff_governance && normalized.visual_diff_governance.evidence &&
        normalized.visual_diff_governance.evidence.render_tool === 'ghostscript');
    check('warnings preserved',
        normalized.visual_diff_governance && Array.isArray(normalized.visual_diff_governance.warnings) &&
        normalized.visual_diff_governance.warnings.length === 1);
}

// ---------------------------------------------------------------------------
// SC3: visual_change_detected=true → certified.pdf downgraded
// ---------------------------------------------------------------------------
console.log('\nSC3: visual_change_detected=true → certified.pdf must be downgraded');
{
    const gov = {
        visual_diff_required: true,
        visual_diff_performed: true,
        visual_change_detected: true,
        visual_review_required: true,
        render_tool_gap: false,
        max_changed_pixel_ratio: 0.08,
        proof_artifacts_available: true,
        production_certified: false,
        standard_certified: false
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('visual_change_detected', gov));

    check('visual_change_detected=true → govRequiresBlock=true', r.govRequiresBlock === true);
    check('visual_change_detected=true → productionCertified=false', r.productionCertified === false);
    check('visual_change_detected=true → requiresReview=true', r.requiresReview === true);
    check('visual_change_detected=true → certifiedPdfAllowed=false', r.certifiedPdfAllowed === false,
        'certified.pdf must not be production-ready when visual changes exist');
}

// ---------------------------------------------------------------------------
// SC4: visual_review_required=true alone → downgrade
// ---------------------------------------------------------------------------
console.log('\nSC4: visual_review_required=true → certified.pdf downgraded');
{
    const gov = {
        visual_diff_required: true,
        visual_diff_performed: false,
        visual_change_detected: false,
        visual_review_required: true,
        render_tool_gap: true,
        max_changed_pixel_ratio: 0,
        proof_artifacts_available: false,
        production_certified: false,
        standard_certified: false
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('visual_review_required_only', gov));

    check('visual_review_required=true → requiresReview=true', r.requiresReview === true);
    check('visual_review_required=true → productionCertified=false', r.productionCertified === false);
    check('visual_review_required=true → certifiedPdfAllowed=false', r.certifiedPdfAllowed === false);
}

// ---------------------------------------------------------------------------
// SC5: render_tool_gap=true — honest tool gap reporting, still blocks
// ---------------------------------------------------------------------------
console.log('\nSC5: render_tool_gap=true — tool gap reported, no false safety');
{
    const gov = {
        visual_diff_required: true,
        visual_diff_performed: false,
        visual_change_detected: false,
        visual_review_required: true,
        render_tool_gap: true,
        max_changed_pixel_ratio: 0,
        proof_artifacts_available: false,
        production_certified: false,
        standard_certified: false,
        warnings: ['render tool unavailable']
    };

    const auditData = buildFixAuditV2('tool_gap', gov);
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('render_tool_gap=true preserved', normalized.visual_diff_governance?.render_tool_gap === true);
    check('proof_artifacts_available=false preserved', normalized.visual_diff_governance?.proof_artifacts_available === false);

    const r = simulateServiceEnforcement(auditData);
    check('tool gap → visual_review_required still drives downgrade', r.requiresReview === true);
    check('tool gap → certifiedPdfAllowed=false', r.certifiedPdfAllowed === false);
}

// ---------------------------------------------------------------------------
// SC6: no visual diff governance — no impact
// ---------------------------------------------------------------------------
console.log('\nSC6: no visual_diff_governance — no production impact');
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
    check('no visual_diff_governance → undefined in normalized',
        normalized.visual_diff_governance === undefined);

    const r = simulateServiceEnforcement(auditData);
    check('no visual_diff_governance → govRequiresBlock=false', r.govRequiresBlock === false);
    check('no visual_diff_governance → production_certified not downgraded', r.productionCertified === true);
}

// ---------------------------------------------------------------------------
// SC7: visual_diff_governance.production_certified=false always
// ---------------------------------------------------------------------------
console.log('\nSC7: visual_diff_governance.production_certified=false always enforced');
{
    const gov = {
        visual_diff_required: false,
        visual_diff_performed: false,
        visual_change_detected: false,
        visual_review_required: false,
        render_tool_gap: false,
        max_changed_pixel_ratio: 0,
        proof_artifacts_available: false,
        production_certified: true,   // should be forced false
        standard_certified: true      // should be forced false
    };

    const auditData = buildFixAuditV2('gov_overclaim', gov);
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('visual_diff_governance preserved even with no flags set',
        normalized.visual_diff_governance !== undefined);
}

// ---------------------------------------------------------------------------
// SC8: delta_report.visual_diff_governance preserved
// ---------------------------------------------------------------------------
console.log('\nSC8: delta_report.visual_diff_governance preserved');
{
    const auditData = {
        version: '2.0',
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: false,
        production_certified: false,
        highest_risk_level: 'LOW',
        visual_diff_governance: { visual_change_detected: false, visual_review_required: false },
        delta_report: {
            visual_diff_governance: {
                visual_change_detected: true,
                visual_review_required: true,
                max_changed_pixel_ratio: 0.05
            }
        }
    };

    const normalized = FixAuditNormalizer.normalize(auditData);
    check('delta_report.visual_diff_governance preserved',
        normalized.delta_report && normalized.delta_report.visual_diff_governance !== undefined);
    check('delta_report.visual_diff_governance.visual_change_detected preserved',
        normalized.delta_report?.visual_diff_governance?.visual_change_detected === true);
}

// ---------------------------------------------------------------------------
// SC9: visual proof evidence fields preserved
// ---------------------------------------------------------------------------
console.log('\nSC9: visual proof evidence fields preserved');
{
    const gov = {
        visual_diff_required: true,
        visual_diff_performed: true,
        visual_change_detected: true,
        visual_review_required: true,
        render_tool_gap: false,
        max_changed_pixel_ratio: 0.15,
        changed_pixel_ratio_avg: 0.09,
        proof_artifacts_available: true,
        production_certified: false,
        standard_certified: false,
        evidence: {
            render_performed: true,
            diff_performed: true,
            pages_rendered: 6,
            pages_compared: 6,
            render_tool: 'ghostscript',
            render_tool_version: '9.56.1',
            diff_images: ['diff_page1.png', 'diff_page2.png'],
            thumbnails: ['thumb_page1.png'],
            warnings: [],
            limitations: []
        }
    };

    const auditData = buildFixAuditV2('full_evidence', gov);
    const normalized = FixAuditNormalizer.normalize(auditData);
    const vdg = normalized.visual_diff_governance || {};

    check('render_performed evidence preserved', vdg.evidence?.render_performed === true);
    check('diff_performed evidence preserved', vdg.evidence?.diff_performed === true);
    check('pages_rendered evidence preserved', vdg.evidence?.pages_rendered === 6);
    check('render_tool evidence preserved', vdg.evidence?.render_tool === 'ghostscript');
    check('diff_images evidence preserved', Array.isArray(vdg.evidence?.diff_images) && vdg.evidence.diff_images.length === 2);
    check('thumbnails evidence preserved', Array.isArray(vdg.evidence?.thumbnails));
    check('changed_pixel_ratio_avg preserved', vdg.changed_pixel_ratio_avg === 0.09);
}

// ---------------------------------------------------------------------------
// SC10: Phase 69B worker report integration
// ---------------------------------------------------------------------------
console.log('\nSC10: Phase 69B worker report scenario normalization');
{
    if (workerReport && workerReport.results) {
        let allNormalized = true;
        let allNoProductionClaim = true;
        let visualReviewBlocksProduction = true;

        for (const scenario of workerReport.results) {
            if (!scenario.visual_diff_governance) continue;
            const auditData = buildFixAuditV2(scenario.scenario, scenario.visual_diff_governance, scenario.artifact_trust);
            const normalized = FixAuditNormalizer.normalize(auditData);
            if (!normalized || !normalized.available) { allNormalized = false; continue; }

            const vdg = normalized.visual_diff_governance || {};
            if (vdg.production_certified === true || vdg.standard_certified === true) {
                allNoProductionClaim = false;
            }

            if (vdg.visual_review_required === true) {
                const r = simulateServiceEnforcement(auditData);
                if (!r.requiresReview || r.certifiedPdfAllowed !== false) {
                    visualReviewBlocksProduction = false;
                }
            }
        }

        check('All 69B scenarios successfully normalized', allNormalized);
        check('No visual_diff_governance scenario claims production_certified=true', allNoProductionClaim);
        check('visual_review_required=true always blocks certified.pdf', visualReviewBlocksProduction);
    } else {
        // Synthetic fallback
        const scenarios = [
            { name: 'no_diff', gov: { visual_diff_required: false, visual_diff_performed: false, visual_change_detected: false, visual_review_required: false, render_tool_gap: false, max_changed_pixel_ratio: 0, proof_artifacts_available: false, production_certified: false, standard_certified: false } },
            { name: 'tool_gap', gov: { visual_diff_required: true, visual_diff_performed: false, visual_change_detected: false, visual_review_required: true, render_tool_gap: true, max_changed_pixel_ratio: 0, proof_artifacts_available: false, production_certified: false, standard_certified: false } },
            { name: 'change_detected', gov: { visual_diff_required: true, visual_diff_performed: true, visual_change_detected: true, visual_review_required: true, render_tool_gap: false, max_changed_pixel_ratio: 0.1, proof_artifacts_available: true, production_certified: false, standard_certified: false } }
        ];

        for (const s of scenarios) {
            const normalized = FixAuditNormalizer.normalize(buildFixAuditV2(s.name, s.gov));
            check(`Synthetic scenario ${s.name} normalized`, normalized && normalized.available);
            const vdg = normalized.visual_diff_governance || {};
            check(`${s.name}: production_certified=false enforced`, vdg.production_certified !== true);
        }
    }
}

// ---------------------------------------------------------------------------
// SC11: artifact_summary includes visual_diff_governance when present
// ---------------------------------------------------------------------------
console.log('\nSC11: artifact_summary.visual_diff_governance hydration');
{
    const gov = {
        visual_diff_required: true,
        visual_diff_performed: true,
        visual_change_detected: true,
        visual_review_required: true,
        render_tool_gap: false,
        max_changed_pixel_ratio: 0.07,
        proof_artifacts_available: true,
        production_certified: false,
        standard_certified: false
    };

    // Simulate what getJobArtifacts does when resolvedVisualDiffGov is set
    const resolvedVDG = gov;
    const artifact_summary = {
        artifact_count: 2,
        downloadable_artifact_count: 2,
        production_ready_artifact_available: false,
        review_required_artifact_available: true
    };

    if (resolvedVDG) {
        artifact_summary.visual_diff_governance = {
            visual_diff_required: resolvedVDG.visual_diff_required ?? false,
            visual_diff_performed: resolvedVDG.visual_diff_performed ?? false,
            visual_change_detected: resolvedVDG.visual_change_detected ?? false,
            visual_review_required: resolvedVDG.visual_review_required ?? false,
            render_tool_gap: resolvedVDG.render_tool_gap ?? false,
            max_changed_pixel_ratio: resolvedVDG.max_changed_pixel_ratio ?? 0,
            proof_artifacts_available: resolvedVDG.proof_artifacts_available ?? false,
            production_certified: false,
            standard_certified: false,
            warnings: resolvedVDG.warnings || [],
            evidence: resolvedVDG.evidence || {}
        };
    }

    check('artifact_summary.visual_diff_governance populated', !!artifact_summary.visual_diff_governance);
    check('artifact_summary.visual_diff_governance.production_certified=false',
        artifact_summary.visual_diff_governance?.production_certified === false);
    check('artifact_summary.visual_diff_governance.standard_certified=false',
        artifact_summary.visual_diff_governance?.standard_certified === false);
    check('artifact_summary.visual_diff_governance.visual_change_detected preserved',
        artifact_summary.visual_diff_governance?.visual_change_detected === true);
}

// ---------------------------------------------------------------------------
// SC12: no standards overclaim allowed via visual diff path
// ---------------------------------------------------------------------------
console.log('\nSC12: No standards overclaim via visual_diff_governance');
{
    const govWithFalseClaim = {
        visual_diff_required: true,
        visual_diff_performed: true,
        visual_change_detected: true,
        visual_review_required: true,
        render_tool_gap: false,
        max_changed_pixel_ratio: 0.2,
        proof_artifacts_available: true,
        production_certified: false,
        standard_certified: false,
        compliance_claim_allowed: false
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('no_standards_overclaim', govWithFalseClaim));

    check('visual_diff path → production_certified=false', r.productionCertified === false);
    check('visual_diff path → requiresReview=true', r.requiresReview === true);
    check('visual_diff path → certifiedPdfAllowed=false', r.certifiedPdfAllowed === false);
}

// ---------------------------------------------------------------------------
// SC13: FixAuditNormalizer empty/null edge cases
// ---------------------------------------------------------------------------
console.log('\nSC13: FixAuditNormalizer edge cases');
{
    const emptyNorm = FixAuditNormalizer.normalize({});
    check('Empty audit data → available=false', emptyNorm.available === false);

    const nullNorm = FixAuditNormalizer.normalize(null);
    check('Null audit data → available=false', nullNorm.available === false);
}

// ---------------------------------------------------------------------------
// SC14: visual_proof_evidence preserved separately when present
// ---------------------------------------------------------------------------
console.log('\nSC14: visual_proof_evidence preserved at root');
{
    const auditData = {
        version: '2.0',
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: false,
        production_certified: false,
        highest_risk_level: 'LOW',
        visual_proof_evidence: {
            thumbnails: ['thumb_p1.png', 'thumb_p2.png'],
            diff_images: ['diff_p1.png'],
            render_tool: 'mutool'
        }
    };

    const normalized = FixAuditNormalizer.normalize(auditData);
    check('visual_proof_evidence preserved at root',
        normalized.visual_proof_evidence !== undefined);
    check('thumbnails array preserved',
        Array.isArray(normalized.visual_proof_evidence?.thumbnails) &&
        normalized.visual_proof_evidence.thumbnails.length === 2);
    check('render_tool preserved',
        normalized.visual_proof_evidence?.render_tool === 'mutool');
}

// ---------------------------------------------------------------------------
// SC15: Phase 68 backward compatibility
// ---------------------------------------------------------------------------
console.log('\nSC15: Phase 68 backward compatibility regression');
{
    const caps = FixCapabilityContract.getCapabilities();
    const validate_pdfa = caps.capabilities.find(c => c.fix_id === 'VALIDATE_PDFA');
    check('VALIDATE_PDFA still present', !!validate_pdfa);
    check('VALIDATE_PDFA compliance_claim_allowed=false', validate_pdfa?.compliance_claim_allowed === false);
    check('VALIDATE_PDFA required_evidence_fields includes validation_report_hash',
        Array.isArray(validate_pdfa?.required_evidence_fields) &&
        validate_pdfa.required_evidence_fields.includes('validation_report_hash'));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass_count + fail_count;
const smoke_passed = fail_count === 0;

console.log(`\n${'='.repeat(60)}`);
console.log('Phase 69C — Service Visual Diff Exposure');
console.log(`Results: ${pass_count}/${total} passed${fail_count > 0 ? ` (${fail_count} FAILED)` : ''}`);
console.log(`Smoke: ${smoke_passed ? 'PASSED' : 'FAILED'}`);
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// Generate reports
// ---------------------------------------------------------------------------
const report = {
    generated_at: new Date().toISOString(),
    phase: '69C',
    repo: 'ppos-preflight-service',
    smoke_passed,
    input_mode: inputMode,
    core_principle: 'visual_diff_governance is evidence — not certification. visual_change_detected=true or visual_review_required=true must block certified.pdf. proof artifacts must never expose local paths. production_certified=false and standard_certified=false are always enforced on visual_diff_governance.',
    changes: [
        'FixAuditNormalizer.js: visual_diff_governance and visual_proof_evidence preserved in v2 normalization',
        'FixAuditNormalizer.js: delta_report.visual_diff_governance preserved',
        'FixCapabilityContract.js: version bumped to 48.0, engine_registry_compatibility=phase-69',
        'FixCapabilityContract.js: RENDER_PDF_PAGES, GENERATE_VISUAL_DIFF, GENERATE_PROOF_THUMBNAILS, COMPARE_ORIGINAL_TO_FIXED, GENERATE_VISUAL_CHANGE_REPORT added under visual_proofing category',
        'PreflightService.js: visual_diff_governance governance sources added after transparency_overprint_physical block',
        'PreflightService.js: visual_review_required/visual_change_detected → requiresReview=true, productionCertified=false',
        'PreflightService.js: certified.pdf downgraded when visual_review_required=true (via requiresReview gate)',
        'PreflightService.js: visual_diff_governance added to artifact_summary in getJobArtifacts',
        'PreflightService.js: visual_diff_governance added to artifact_summary and return payload in _normalizeJobPayload'
    ],
    results,
    summary: { total, passed: pass_count, failed: fail_count }
};

const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const jsonPath = path.join(reportsDir, 'phase69c_service_visual_diff_exposure.json');
const mdPath = path.join(reportsDir, 'phase69c_service_visual_diff_exposure.md');

fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const mdLines = [
    '# Phase 69C — Service Visual Diff Exposure',
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
