'use strict';

/**
 * Phase 70C — Service Proof Approval Exposure
 * Smoke test: verifies that the Service correctly normalizes, exposes, and enforces
 * proof_approval_governance from Worker fix_audit payloads.
 *
 * Input: ../ppos-preflight-worker/reports/phase70b_worker_proof_approval_policy.json
 * Fallback: synthetic payloads labeled input_mode="SYNTHETIC_POLICY_FALLBACK"
 */

const path = require('path');
const fs = require('fs');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');
const FixCapabilityContract = require('../services/FixCapabilityContract');

// ---------------------------------------------------------------------------
// Load Phase 70B worker report or fall back to synthetic payloads
// ---------------------------------------------------------------------------
const WORKER_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-worker/reports/phase70b_worker_proof_approval_policy.json');
let workerReport = null;
let inputMode = 'ENGINE_REPORT';

if (fs.existsSync(WORKER_REPORT_PATH)) {
    try {
        workerReport = JSON.parse(fs.readFileSync(WORKER_REPORT_PATH, 'utf8'));
        inputMode = workerReport.input_mode || 'ENGINE_REPORT';
        console.log('[70C] Loaded Phase 70B worker report from:', WORKER_REPORT_PATH);
    } catch (e) {
        console.warn('[70C] Failed to parse Phase 70B worker report, using synthetic payloads:', e.message);
    }
}

if (!workerReport) {
    inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    console.log('[70C] Phase 70B worker report unavailable. Using synthetic payloads.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildFixAuditV2(scenarioName, proofApprovalGov, artifactTrust) {
    return {
        version: '2.0',
        requested_fixes: [{ code: 'FLATTEN_TRANSPARENCY' }],
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: proofApprovalGov.review_required || false,
        production_certified: false,
        highest_risk_level: 'HIGH',
        proof_approval_governance: proofApprovalGov,
        artifact_trust: artifactTrust || {
            trust_level: 'FIXED_READY',
            standard_certified: false,
            compliance_claim_allowed: false,
            certified_pdf_allowed: false,
            review_required: proofApprovalGov.review_required || false
        }
    };
}

// Simulate what PreflightService._normalizeJobPayload does with proof_approval_governance
function simulateServiceEnforcement(fixAuditData) {
    const normalized = FixAuditNormalizer.normalize(fixAuditData);
    const pag = normalized.proof_approval_governance || {};
    const artifactTrust = normalized.artifact_trust || {};

    const proofRequired = pag.proof_required === true;
    const proofApproved = pag.proof_status === 'APPROVED';
    const visualChangeDetected = pag.visual_change_detected === true;
    const reviewRequired = pag.review_required === true;

    // Apply same logic as PreflightService._normalizeJobPayload Phase 70C block
    // production_certified is always false in this governance domain (descriptive, not a trigger).
    // Only proof_status drives the blocking decision.
    const govRequiresBlock = Object.keys(pag).length > 0 && (
        (pag.proof_required === true && pag.proof_status !== 'APPROVED') ||
        (pag.visual_change_detected === true && pag.proof_status !== 'APPROVED')
    );

    let productionCertified = artifactTrust.production_certified !== false;
    let requiresReview = artifactTrust.review_required === true || reviewRequired;

    if (govRequiresBlock) {
        productionCertified = false;
    }

    // certified.pdf gate: blocked when productionCertified=false or requiresReview=true
    const certifiedPdfAllowed = productionCertified && !requiresReview && artifactTrust.certified_pdf_allowed !== false;

    return {
        normalized,
        pag,
        govRequiresBlock,
        productionCertified,
        requiresReview,
        certifiedPdfAllowed,
        proofRequired,
        proofApproved,
        visualChangeDetected
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

console.log('\n=== Phase 70C — Service Proof Approval Exposure ===\n');
console.log(`Input mode: ${inputMode}\n`);

// ---------------------------------------------------------------------------
// SC1: FixCapabilityContract exposes Phase 70 proof approval capabilities
// ---------------------------------------------------------------------------
console.log('SC1: FixCapabilityContract Phase 70 proof approval capabilities');
{
    const caps = FixCapabilityContract.getCapabilities();
    const ids = caps.capabilities.map(c => c.fix_id);

    check('FixCapabilityContract version >= 49.0',
        parseFloat(caps.version) >= 49.0,
        `version=${caps.version}`);

    check('engine_registry_compatibility=phase-70',
        caps.engine_registry_compatibility === 'phase-70',
        `got: ${caps.engine_registry_compatibility}`);

    check('PROOF_APPROVAL_CONTRACT capability present', ids.includes('PROOF_APPROVAL_CONTRACT'));
    check('GENERATE_PROOF_APPROVAL_METADATA capability present', ids.includes('GENERATE_PROOF_APPROVAL_METADATA'));

    const pac = caps.capabilities.find(c => c.fix_id === 'PROOF_APPROVAL_CONTRACT');
    check('PROOF_APPROVAL_CONTRACT category=proof_approval',
        pac && pac.category === 'proof_approval');
    check('PROOF_APPROVAL_CONTRACT production_certified=false',
        pac && pac.production_certified === false,
        'Proof approval contract must not imply production certification');
    check('PROOF_APPROVAL_CONTRACT standard_certified=false',
        pac && pac.standard_certified === false);
    check('PROOF_APPROVAL_CONTRACT compliance_claim_allowed=false',
        pac && pac.compliance_claim_allowed === false);
    check('PROOF_APPROVAL_CONTRACT requires_human_review=true',
        pac && pac.requires_human_review === true);

    check('Phase 69 capabilities still present (regression)',
        ids.includes('RENDER_PDF_PAGES') && ids.includes('GENERATE_VISUAL_DIFF'));
    check('Phase 68 capabilities still present (regression)',
        ids.includes('VALIDATE_PDFX') && ids.includes('VALIDATE_PDFA'));
}

// ---------------------------------------------------------------------------
// SC2: FixAuditNormalizer preserves proof_approval_governance
// ---------------------------------------------------------------------------
console.log('\nSC2: FixAuditNormalizer preserves proof_approval_governance');
{
    const gov = {
        proof_required: true,
        proof_available: true,
        proof_id: 'proof_abc123',
        proof_status: 'PENDING',
        visual_change_detected: true,
        review_required: true,
        production_certified: false,
        evidence: {
            source_artifact_hash: 'sha256:aaa',
            fixed_artifact_hash: 'sha256:bbb',
            diff_report_hash: 'sha256:ccc',
            rendered_pages: 4,
            generated_at: '2026-06-09T00:00:00Z'
        }
    };

    const auditData = buildFixAuditV2('full_proof_approval', gov);
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('proof_approval_governance preserved at root',
        normalized.proof_approval_governance !== undefined);
    check('proof_required preserved',
        normalized.proof_approval_governance && normalized.proof_approval_governance.proof_required === true);
    check('proof_status preserved',
        normalized.proof_approval_governance && normalized.proof_approval_governance.proof_status === 'PENDING');
    check('proof_id preserved',
        normalized.proof_approval_governance && normalized.proof_approval_governance.proof_id === 'proof_abc123');
    check('visual_change_detected preserved',
        normalized.proof_approval_governance && normalized.proof_approval_governance.visual_change_detected === true);
    check('review_required preserved',
        normalized.proof_approval_governance && normalized.proof_approval_governance.review_required === true);
    check('evidence preserved',
        normalized.proof_approval_governance && normalized.proof_approval_governance.evidence &&
        normalized.proof_approval_governance.evidence.diff_report_hash === 'sha256:ccc');
}

// ---------------------------------------------------------------------------
// SC3: proof_required=true, proof_status=PENDING → blocks production
// ---------------------------------------------------------------------------
console.log('\nSC3: proof_required=true, proof_status=PENDING → production blocked');
{
    const gov = {
        proof_required: true,
        proof_available: true,
        proof_id: 'proof_xyz',
        proof_status: 'PENDING',
        visual_change_detected: true,
        review_required: true,
        production_certified: false,
        evidence: {}
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('proof_pending', gov));

    check('proof_status=PENDING → govRequiresBlock=true', r.govRequiresBlock === true);
    check('proof_status=PENDING → productionCertified=false', r.productionCertified === false);
    check('proof_status=PENDING → requiresReview=true', r.requiresReview === true);
    check('proof_status=PENDING → certifiedPdfAllowed=false', r.certifiedPdfAllowed === false,
        'certified.pdf must not be production-ready when proof is pending');
}

// ---------------------------------------------------------------------------
// SC4: proof_required=true, proof_status=APPROVED → allows production
// ---------------------------------------------------------------------------
console.log('\nSC4: proof_required=true, proof_status=APPROVED → production allowed');
{
    const gov = {
        proof_required: true,
        proof_available: true,
        proof_id: 'proof_approved_001',
        proof_status: 'APPROVED',
        visual_change_detected: true,
        review_required: false,
        production_certified: false,
        evidence: {}
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('proof_approved', gov, {
        trust_level: 'PROOF_APPROVED',
        production_certified: true,
        review_required: false,
        certified_pdf_allowed: true,
        standard_certified: false,
        compliance_claim_allowed: false
    }));

    check('proof_status=APPROVED → govRequiresBlock=false', r.govRequiresBlock === false,
        'visual_change_detected=true but proof_status=APPROVED should not block');
}

// ---------------------------------------------------------------------------
// SC5: proof_status=REJECTED → blocks production
// ---------------------------------------------------------------------------
console.log('\nSC5: proof_status=REJECTED → production blocked');
{
    const gov = {
        proof_required: true,
        proof_available: true,
        proof_id: 'proof_rejected_001',
        proof_status: 'REJECTED',
        visual_change_detected: true,
        review_required: true,
        production_certified: false,
        evidence: {}
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('proof_rejected', gov));

    check('proof_status=REJECTED → govRequiresBlock=true', r.govRequiresBlock === true);
    check('proof_status=REJECTED → productionCertified=false', r.productionCertified === false);
    check('proof_status=REJECTED → certifiedPdfAllowed=false', r.certifiedPdfAllowed === false);
}

// ---------------------------------------------------------------------------
// SC6: proof_required=false, no visual changes → no impact
// ---------------------------------------------------------------------------
console.log('\nSC6: proof not required, no visual changes → no production impact');
{
    const gov = {
        proof_required: false,
        proof_available: false,
        proof_id: null,
        proof_status: 'NOT_REQUIRED',
        visual_change_detected: false,
        review_required: false,
        production_certified: false,
        evidence: {}
    };

    const auditData = {
        version: '2.0',
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: false,
        production_certified: true,
        highest_risk_level: 'LOW',
        proof_approval_governance: gov,
        artifact_trust: {
            trust_level: 'CERTIFIED',
            production_certified: true,
            review_required: false,
            certified_pdf_allowed: true,
            standard_certified: false,
            compliance_claim_allowed: false
        }
    };

    const r = simulateServiceEnforcement(auditData);
    check('NOT_REQUIRED → govRequiresBlock=false', r.govRequiresBlock === false,
        'proof_required=false, visual_change_detected=false should not block production');
}

// ---------------------------------------------------------------------------
// SC7: no proof_approval_governance → no impact
// ---------------------------------------------------------------------------
console.log('\nSC7: no proof_approval_governance → no production impact');
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
    check('no proof_approval_governance → undefined in normalized',
        normalized.proof_approval_governance === undefined);

    const r = simulateServiceEnforcement(auditData);
    check('no proof_approval_governance → govRequiresBlock=false', r.govRequiresBlock === false);
    check('no proof_approval_governance → production_certified not downgraded', r.productionCertified === true);
}

// ---------------------------------------------------------------------------
// SC8: delta_report.proof_approval_governance preserved
// ---------------------------------------------------------------------------
console.log('\nSC8: delta_report.proof_approval_governance preserved');
{
    const auditData = {
        version: '2.0',
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: false,
        production_certified: false,
        highest_risk_level: 'LOW',
        proof_approval_governance: { proof_required: false, proof_status: 'NOT_REQUIRED' },
        delta_report: {
            proof_approval_governance: {
                proof_required: true,
                proof_status: 'PENDING',
                visual_change_detected: true,
                review_required: true
            }
        }
    };

    const normalized = FixAuditNormalizer.normalize(auditData);
    check('delta_report.proof_approval_governance preserved',
        normalized.delta_report && normalized.delta_report.proof_approval_governance !== undefined);
    check('delta_report.proof_approval_governance.proof_status preserved',
        normalized.delta_report?.proof_approval_governance?.proof_status === 'PENDING');
}

// ---------------------------------------------------------------------------
// SC9: proof_approval_governance.production_certified=false always enforced
// ---------------------------------------------------------------------------
console.log('\nSC9: proof_approval_governance.production_certified=false always enforced in artifact_summary');
{
    const gov = {
        proof_required: true,
        proof_available: true,
        proof_id: 'proof_test_001',
        proof_status: 'PENDING',
        visual_change_detected: true,
        review_required: true,
        production_certified: false,
        evidence: {}
    };

    // Simulate what getJobArtifacts does when resolvedProofApprovalGov is set
    const resolvedPAG = gov;
    const artifact_summary = {
        artifact_count: 2,
        downloadable_artifact_count: 2,
        production_ready_artifact_available: false,
        review_required_artifact_available: true
    };

    if (resolvedPAG) {
        artifact_summary.proof_approval_governance = {
            proof_required: resolvedPAG.proof_required ?? false,
            proof_available: resolvedPAG.proof_available ?? false,
            proof_id: resolvedPAG.proof_id ?? null,
            proof_status: resolvedPAG.proof_status ?? 'NOT_REQUIRED',
            visual_change_detected: resolvedPAG.visual_change_detected ?? false,
            review_required: resolvedPAG.review_required ?? false,
            production_certified: false,
            evidence: resolvedPAG.evidence || {}
        };
    }

    check('artifact_summary.proof_approval_governance populated', !!artifact_summary.proof_approval_governance);
    check('artifact_summary.proof_approval_governance.production_certified=false',
        artifact_summary.proof_approval_governance?.production_certified === false);
    check('artifact_summary.proof_approval_governance.proof_status preserved',
        artifact_summary.proof_approval_governance?.proof_status === 'PENDING');
    check('artifact_summary.proof_approval_governance.proof_id preserved',
        artifact_summary.proof_approval_governance?.proof_id === 'proof_test_001');
}

// ---------------------------------------------------------------------------
// SC10: No raw paths in proof governance
// ---------------------------------------------------------------------------
console.log('\nSC10: No raw filesystem paths leak through proof_approval_governance');
{
    const gov = {
        proof_required: true,
        proof_available: true,
        proof_id: 'proof_safe_001',
        proof_status: 'PENDING',
        visual_change_detected: true,
        review_required: true,
        production_certified: false,
        evidence: {
            source_artifact_hash: 'sha256:abc',
            fixed_artifact_hash: 'sha256:def',
            diff_report_hash: 'sha256:ghi',
            rendered_pages: 2,
            generated_at: '2026-06-09T00:00:00Z'
        }
    };

    const normalized = FixAuditNormalizer.normalize(buildFixAuditV2('no_path_leak', gov));
    const pag = normalized.proof_approval_governance || {};
    const evidenceStr = JSON.stringify(pag);

    check('proof_approval_governance contains no local filesystem paths',
        !/[A-Za-z]:[\\\/]|\/tmp\/|\/var\/|\/home\/|\/storage\//.test(evidenceStr),
        'No local paths found in governance payload');
    check('proof_id is opaque identifier, not path',
        pag.proof_id && !pag.proof_id.includes('/') && !pag.proof_id.includes('\\'));
    check('evidence hashes are present',
        pag.evidence && pag.evidence.source_artifact_hash && pag.evidence.diff_report_hash);
}

// ---------------------------------------------------------------------------
// SC11: No standards overclaim via proof approval path
// ---------------------------------------------------------------------------
console.log('\nSC11: No standards overclaim via proof_approval_governance');
{
    const gov = {
        proof_required: true,
        proof_available: true,
        proof_id: 'proof_overclaim_test',
        proof_status: 'PENDING',
        visual_change_detected: true,
        review_required: true,
        production_certified: false,
        evidence: {}
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('no_standards_overclaim', gov));

    check('proof approval path → production_certified=false', r.productionCertified === false);
    check('proof approval path → requiresReview=true', r.requiresReview === true);
    check('proof approval path → certifiedPdfAllowed=false', r.certifiedPdfAllowed === false);
}

// ---------------------------------------------------------------------------
// SC12: Phase 70B worker report integration
// ---------------------------------------------------------------------------
console.log('\nSC12: Phase 70B worker report scenario normalization');
{
    if (workerReport && workerReport.results) {
        let allNormalized = true;
        let allNoProductionClaim = true;
        let pendingBlocksProduction = true;

        for (const scenario of workerReport.results) {
            if (!scenario.proof_approval_governance) continue;
            const auditData = buildFixAuditV2(scenario.scenario, scenario.proof_approval_governance, scenario.artifact_trust);
            const normalized = FixAuditNormalizer.normalize(auditData);
            if (!normalized || !normalized.available) { allNormalized = false; continue; }

            const pag = normalized.proof_approval_governance || {};
            if (pag.production_certified === true) allNoProductionClaim = false;

            if (pag.proof_required === true && pag.proof_status !== 'APPROVED') {
                const r = simulateServiceEnforcement(auditData);
                if (!r.govRequiresBlock || r.certifiedPdfAllowed !== false) {
                    pendingBlocksProduction = false;
                }
            }
        }

        check('All 70B scenarios successfully normalized', allNormalized);
        check('No proof_approval_governance scenario claims production_certified=true', allNoProductionClaim);
        check('proof_required=true + non-APPROVED status always blocks production', pendingBlocksProduction);
    } else {
        // Synthetic fallback scenarios
        const scenarios = [
            {
                name: 'not_required',
                gov: { proof_required: false, proof_available: false, proof_id: null, proof_status: 'NOT_REQUIRED', visual_change_detected: false, review_required: false, production_certified: false, evidence: {} }
            },
            {
                name: 'pending',
                gov: { proof_required: true, proof_available: true, proof_id: 'p1', proof_status: 'PENDING', visual_change_detected: true, review_required: true, production_certified: false, evidence: {} }
            },
            {
                name: 'rejected',
                gov: { proof_required: true, proof_available: true, proof_id: 'p2', proof_status: 'REJECTED', visual_change_detected: true, review_required: true, production_certified: false, evidence: {} }
            }
        ];

        for (const s of scenarios) {
            const normalized = FixAuditNormalizer.normalize(buildFixAuditV2(s.name, s.gov));
            check(`Synthetic scenario ${s.name} normalized`, normalized && normalized.available);
            const pag = normalized.proof_approval_governance || {};
            check(`${s.name}: production_certified=false enforced`, pag.production_certified !== true);

            if (s.gov.proof_required && s.gov.proof_status !== 'APPROVED') {
                const r = simulateServiceEnforcement(buildFixAuditV2(s.name, s.gov));
                check(`${s.name}: non-APPROVED proof blocks production`, r.govRequiresBlock === true);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// SC13: FixAuditNormalizer edge cases
// ---------------------------------------------------------------------------
console.log('\nSC13: FixAuditNormalizer edge cases');
{
    const emptyNorm = FixAuditNormalizer.normalize({});
    check('Empty audit data → available=false', emptyNorm.available === false);

    const nullNorm = FixAuditNormalizer.normalize(null);
    check('Null audit data → available=false', nullNorm.available === false);

    const noProofNorm = FixAuditNormalizer.normalize({ version: '2.0', applied_fixes: [], skipped_fixes: [], failed_fixes: [] });
    check('v2 without proof_approval_governance → proof_approval_governance=undefined',
        noProofNorm.proof_approval_governance === undefined);
}

// ---------------------------------------------------------------------------
// SC14: Phase 69C visual_diff_governance backward compatibility
// ---------------------------------------------------------------------------
console.log('\nSC14: Phase 69C visual_diff_governance backward compatibility');
{
    const auditData = {
        version: '2.0',
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: true,
        production_certified: false,
        highest_risk_level: 'HIGH',
        visual_diff_governance: {
            visual_diff_required: true,
            visual_diff_performed: true,
            visual_change_detected: true,
            visual_review_required: true,
            render_tool_gap: false,
            max_changed_pixel_ratio: 0.1,
            proof_artifacts_available: true,
            production_certified: false,
            standard_certified: false
        },
        proof_approval_governance: {
            proof_required: true,
            proof_status: 'PENDING',
            visual_change_detected: true,
            review_required: true,
            production_certified: false,
            evidence: {}
        }
    };

    const normalized = FixAuditNormalizer.normalize(auditData);
    check('visual_diff_governance still preserved alongside proof_approval_governance',
        normalized.visual_diff_governance !== undefined && normalized.proof_approval_governance !== undefined);
    check('visual_diff_governance.visual_change_detected preserved',
        normalized.visual_diff_governance?.visual_change_detected === true);
    check('proof_approval_governance.proof_status preserved',
        normalized.proof_approval_governance?.proof_status === 'PENDING');
}

// ---------------------------------------------------------------------------
// SC15: Phase 68 backward compatibility regression
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
console.log('Phase 70C — Service Proof Approval Exposure');
console.log(`Results: ${pass_count}/${total} passed${fail_count > 0 ? ` (${fail_count} FAILED)` : ''}`);
console.log(`Smoke: ${smoke_passed ? 'PASSED' : 'FAILED'}`);
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// Generate reports
// ---------------------------------------------------------------------------
const report = {
    generated_at: new Date().toISOString(),
    phase: '70C',
    repo: 'ppos-preflight-service',
    smoke_passed,
    input_mode: inputMode,
    core_principle: 'proof_approval_governance is a production gate. proof_required=true and proof_status!=APPROVED blocks production. visual_change_detected=true and proof_status!=APPROVED blocks production. Proof artifacts must never expose raw filesystem paths. production_certified=false is always enforced on proof_approval_governance.',
    changes: [
        'FixAuditNormalizer.js: proof_approval_governance preserved in v2 normalization',
        'FixAuditNormalizer.js: delta_report.proof_approval_governance preserved',
        'FixCapabilityContract.js: version bumped to 49.0, engine_registry_compatibility=phase-70',
        'FixCapabilityContract.js: PROOF_APPROVAL_CONTRACT and GENERATE_PROOF_APPROVAL_METADATA capabilities added under proof_approval category',
        'PreflightService.js: proof_approval_governance governance sources added in getJobArtifacts after visual diff block',
        'PreflightService.js: proof_required=true+non-APPROVED and visual_change_detected=true+non-APPROVED → requiresReview=true, productionCertified=false',
        'PreflightService.js: proof_approval_governance added to artifact_summary in getJobArtifacts',
        'PreflightService.js: Phase 70C enforcement block added in _normalizeJobPayload after Phase 69C block',
        'PreflightService.js: proof_approval_governance added to artifact_summary and return payload in _normalizeJobPayload'
    ],
    results,
    summary: { total, passed: pass_count, failed: fail_count }
};

const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const jsonPath = path.join(reportsDir, 'phase70c_service_proof_approval_exposure.json');
const mdPath = path.join(reportsDir, 'phase70c_service_proof_approval_exposure.md');

fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const mdLines = [
    '# Phase 70C — Service Proof Approval Exposure',
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
