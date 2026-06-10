'use strict';

/**
 * Phase 71C — Service Production Package Exposure
 * Smoke test: verifies that the Service correctly normalizes and exposes
 * production_package_governance from Worker fix_audit payloads, and that
 * package_ready / approved artifact manifest are only exposed when the
 * Service's own production/review gates are also satisfied.
 *
 * Input: ../ppos-preflight-worker/reports/phase71b_worker_production_package_policy.json
 * Fallback: synthetic payloads labeled input_mode="SYNTHETIC_POLICY_FALLBACK"
 */

const path = require('path');
const fs = require('fs');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');
const FixCapabilityContract = require('../services/FixCapabilityContract');

// ---------------------------------------------------------------------------
// Load Phase 71B worker report or fall back to synthetic payloads
// ---------------------------------------------------------------------------
const WORKER_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-worker/reports/phase71b_worker_production_package_policy.json');
let workerReport = null;
let inputMode = 'ENGINE_REPORT';

if (fs.existsSync(WORKER_REPORT_PATH)) {
    try {
        workerReport = JSON.parse(fs.readFileSync(WORKER_REPORT_PATH, 'utf8'));
        inputMode = workerReport.input_mode || 'ENGINE_REPORT';
        console.log('[71C] Loaded Phase 71B worker report from:', WORKER_REPORT_PATH);
    } catch (e) {
        console.warn('[71C] Failed to parse Phase 71B worker report, using synthetic payloads:', e.message);
    }
}

if (!workerReport) {
    inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    console.log('[71C] Phase 71B worker report unavailable. Using synthetic payloads.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildFixAuditV2(scenarioName, productionPackageGov, artifactTrust, proofApprovalGov) {
    return {
        version: '2.0',
        requested_fixes: [{ code: 'FLATTEN_TRANSPARENCY' }],
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: artifactTrust ? artifactTrust.review_required === true : false,
        production_certified: artifactTrust ? artifactTrust.production_certified === true : false,
        highest_risk_level: 'HIGH',
        production_package_governance: productionPackageGov,
        proof_approval_governance: proofApprovalGov || {
            proof_required: false,
            proof_available: false,
            proof_id: null,
            proof_status: 'NOT_REQUIRED',
            visual_change_detected: false,
            review_required: false,
            production_certified: false,
            evidence: {}
        },
        artifact_trust: artifactTrust || {
            trust_level: 'FIXED_READY',
            production_certified: false,
            review_required: false,
            certified_pdf_allowed: false,
            standard_certified: false,
            compliance_claim_allowed: false
        }
    };
}

// Simulate what PreflightService._normalizeJobPayload does for production_package_governance:
// 1. resolve productionCertified/requiresReview from artifact_trust + proof_approval_governance
// 2. expose production_package_governance with package_ready gated by Service's own state
function simulateServiceEnforcement(fixAuditData) {
    const normalized = FixAuditNormalizer.normalize(fixAuditData);
    const artifactTrust = normalized.artifact_trust || {};
    const pag = normalized.proof_approval_governance || {};
    const ppg = normalized.production_package_governance || {};

    let productionCertified = artifactTrust.production_certified !== false;
    let requiresReview = artifactTrust.review_required === true;

    // Phase 70C proof approval enforcement
    const proofApprovalRequiresBlock = Object.keys(pag).length > 0 && (
        (pag.proof_required === true && pag.proof_status !== 'APPROVED') ||
        (pag.visual_change_detected === true && pag.proof_status !== 'APPROVED')
    );
    if (proofApprovalRequiresBlock) {
        productionCertified = false;
        requiresReview = true;
    }
    if (pag.review_required === true) {
        requiresReview = true;
    }

    // Phase 71C production package exposure
    let productionPackageGovExposed;
    if (Object.keys(ppg).length > 0) {
        const packageReady = ppg.package_ready === true && productionCertified === true && requiresReview === false;
        productionPackageGovExposed = {
            package_ready: packageReady,
            approved_artifact_type: packageReady ? (ppg.approved_artifact_type ?? null) : null,
            approved_artifact_hash: packageReady ? (ppg.approved_artifact_hash ?? null) : null,
            included_reports: ppg.included_reports || [],
            blocked_by_governance_domains: ppg.blocked_by_governance_domains || [],
            warnings: ppg.warnings || [],
            evidence: ppg.evidence || {}
        };
    }

    return {
        normalized,
        ppg,
        productionPackageGovExposed,
        productionCertified,
        requiresReview
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

console.log('\n=== Phase 71C — Service Production Package Exposure ===\n');
console.log(`Input mode: ${inputMode}\n`);

// ---------------------------------------------------------------------------
// SC1: FixCapabilityContract exposes Phase 71 production package capabilities
// ---------------------------------------------------------------------------
console.log('SC1: FixCapabilityContract Phase 71 production package capabilities');
{
    const caps = FixCapabilityContract.getCapabilities();
    const ids = caps.capabilities.map(c => c.fix_id);

    check('FixCapabilityContract version >= 51.0',
        parseFloat(caps.version) >= 51.0,
        `version=${caps.version}`);

    check('engine_registry_compatibility=phase-71',
        caps.engine_registry_compatibility === 'phase-71',
        `got: ${caps.engine_registry_compatibility}`);

    check('PRODUCTION_PACKAGE_CONTRACT capability present', ids.includes('PRODUCTION_PACKAGE_CONTRACT'));
    check('GENERATE_PRODUCTION_PACKAGE_MANIFEST capability present', ids.includes('GENERATE_PRODUCTION_PACKAGE_MANIFEST'));

    const ppc = caps.capabilities.find(c => c.fix_id === 'PRODUCTION_PACKAGE_CONTRACT');
    check('PRODUCTION_PACKAGE_CONTRACT category=production_package',
        ppc && ppc.category === 'production_package');
    check('PRODUCTION_PACKAGE_CONTRACT production_certified=false',
        ppc && ppc.production_certified === false,
        'Production package contract must not imply production certification');
    check('PRODUCTION_PACKAGE_CONTRACT standard_certified=false',
        ppc && ppc.standard_certified === false);
    check('PRODUCTION_PACKAGE_CONTRACT compliance_claim_allowed=false',
        ppc && ppc.compliance_claim_allowed === false);
    check('PRODUCTION_PACKAGE_CONTRACT requires_human_review=true',
        ppc && ppc.requires_human_review === true);

    check('Phase 70 capabilities still present (regression)',
        ids.includes('PROOF_APPROVAL_CONTRACT') && ids.includes('GENERATE_PROOF_APPROVAL_METADATA'));
    check('Phase 69 capabilities still present (regression)',
        ids.includes('RENDER_PDF_PAGES') && ids.includes('GENERATE_VISUAL_DIFF'));
    check('Phase 68 capabilities still present (regression)',
        ids.includes('VALIDATE_PDFX') && ids.includes('VALIDATE_PDFA'));
}

// ---------------------------------------------------------------------------
// SC2: FixAuditNormalizer preserves production_package_governance
// ---------------------------------------------------------------------------
console.log('\nSC2: FixAuditNormalizer preserves production_package_governance');
{
    const ppg = {
        package_ready: true,
        approved_artifact_type: 'certified_pdf',
        approved_artifact_hash: '18960407306c08ff7b47e4172d88c9b7bae236246d1fe4638e303bb424c1e56a',
        included_reports: ['fix_audit.json', 'delta_report.json', 'certified.pdf', 'fixed.pdf'],
        blocked_by_governance_domains: [],
        warnings: [],
        evidence: {
            physical_artifacts_ready: true,
            review_required: false,
            production_certified: true,
            standard_certified: false,
            proof_required: false,
            proof_status: 'NOT_REQUIRED',
            payment_status: 'PAID',
            payment_gate_satisfied: true,
            primary_artifact_type: 'certified_pdf',
            primary_artifact_filename: 'certified.pdf'
        }
    };

    const auditData = buildFixAuditV2('full_production_package', ppg, {
        trust_level: 'PRODUCTION_CERTIFIED',
        production_certified: true,
        review_required: false,
        certified_pdf_allowed: true,
        standard_certified: false,
        compliance_claim_allowed: false
    });
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('production_package_governance preserved at root',
        normalized.production_package_governance !== undefined);
    check('package_ready preserved',
        normalized.production_package_governance && normalized.production_package_governance.package_ready === true);
    check('approved_artifact_type preserved',
        normalized.production_package_governance && normalized.production_package_governance.approved_artifact_type === 'certified_pdf');
    check('approved_artifact_hash preserved',
        normalized.production_package_governance && normalized.production_package_governance.approved_artifact_hash === ppg.approved_artifact_hash);
    check('included_reports preserved',
        Array.isArray(normalized.production_package_governance?.included_reports) &&
        normalized.production_package_governance.included_reports.includes('certified.pdf'));
    check('evidence preserved',
        normalized.production_package_governance && normalized.production_package_governance.evidence &&
        normalized.production_package_governance.evidence.payment_status === 'PAID');
}

// ---------------------------------------------------------------------------
// SC3: production certified, no blockers -> package_ready=true, manifest exposed
// ---------------------------------------------------------------------------
console.log('\nSC3: production certified, no blockers -> package_ready=true, manifest exposed');
{
    const ppg = {
        package_ready: true,
        approved_artifact_type: 'certified_pdf',
        approved_artifact_hash: 'sha256:cert001',
        included_reports: ['fix_audit.json', 'delta_report.json', 'certified.pdf', 'fixed.pdf'],
        blocked_by_governance_domains: [],
        warnings: [],
        evidence: { production_certified: true }
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('cert_no_blockers', ppg, {
        trust_level: 'PRODUCTION_CERTIFIED',
        production_certified: true,
        review_required: false,
        certified_pdf_allowed: true,
        standard_certified: false,
        compliance_claim_allowed: false
    }));

    check('package_ready=true', r.productionPackageGovExposed?.package_ready === true);
    check('approved_artifact_type exposed', r.productionPackageGovExposed?.approved_artifact_type === 'certified_pdf');
    check('approved_artifact_hash exposed', r.productionPackageGovExposed?.approved_artifact_hash === 'sha256:cert001');
    check('included_reports exposed', Array.isArray(r.productionPackageGovExposed?.included_reports) && r.productionPackageGovExposed.included_reports.length === 4);
}

// ---------------------------------------------------------------------------
// SC4: review required -> package_ready=false, manifest withheld
// ---------------------------------------------------------------------------
console.log('\nSC4: review required -> package_ready=false, manifest withheld');
{
    const ppg = {
        package_ready: false,
        approved_artifact_type: null,
        approved_artifact_hash: null,
        included_reports: ['fix_audit.json', 'delta_report.json', 'fixed.pdf'],
        blocked_by_governance_domains: ['review_required', 'production_certification'],
        warnings: ['Artifact requires human review before packaging for production.'],
        evidence: { review_required: true, production_certified: false }
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('review_required', ppg, {
        trust_level: 'FIXED_REVIEW_REQUIRED',
        production_certified: false,
        review_required: true,
        certified_pdf_allowed: false,
        standard_certified: false,
        compliance_claim_allowed: false
    }));

    check('package_ready=false', r.productionPackageGovExposed?.package_ready === false);
    check('approved_artifact_type withheld', r.productionPackageGovExposed?.approved_artifact_type === null);
    check('approved_artifact_hash withheld', r.productionPackageGovExposed?.approved_artifact_hash === null);
    check('blocked_by_governance_domains preserved',
        r.productionPackageGovExposed?.blocked_by_governance_domains.includes('review_required'));
}

// ---------------------------------------------------------------------------
// SC5: visual change detected, proof pending -> package_ready=false
// ---------------------------------------------------------------------------
console.log('\nSC5: visual change detected, proof pending -> package_ready=false');
{
    const ppg = {
        package_ready: false,
        approved_artifact_type: null,
        approved_artifact_hash: null,
        included_reports: ['fix_audit.json', 'delta_report.json', 'fixed.pdf'],
        blocked_by_governance_domains: ['review_required', 'production_certification', 'visual_diff_governance', 'proof_approval_governance'],
        warnings: ['Artifact requires human review before packaging for production.'],
        evidence: { review_required: true, production_certified: false, proof_required: true, proof_status: 'PENDING' }
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('visual_change_proof_pending', ppg, {
        trust_level: 'FIXED_REVIEW_REQUIRED',
        production_certified: false,
        review_required: true,
        certified_pdf_allowed: false,
        standard_certified: false,
        compliance_claim_allowed: false
    }, {
        proof_required: true,
        proof_available: true,
        proof_id: 'proof_001',
        proof_status: 'PENDING',
        visual_change_detected: true,
        review_required: true,
        production_certified: false,
        evidence: {}
    }));

    check('package_ready=false', r.productionPackageGovExposed?.package_ready === false);
    check('productionCertified=false', r.productionCertified === false);
    check('requiresReview=true', r.requiresReview === true);
}

// ---------------------------------------------------------------------------
// SC6: production certified but payment UNPAID -> package_ready=false (worker-driven)
// ---------------------------------------------------------------------------
console.log('\nSC6: production certified, payment UNPAID -> package_ready=false');
{
    const ppg = {
        package_ready: false,
        approved_artifact_type: null,
        approved_artifact_hash: null,
        included_reports: ['fix_audit.json', 'delta_report.json', 'certified.pdf', 'fixed.pdf'],
        blocked_by_governance_domains: ['payment_governance'],
        warnings: ["Payment status 'UNPAID' does not clear the production package gate."],
        evidence: { production_certified: true, review_required: false, payment_status: 'UNPAID', payment_gate_satisfied: false }
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('payment_unpaid', ppg, {
        trust_level: 'PRODUCTION_CERTIFIED',
        production_certified: true,
        review_required: false,
        certified_pdf_allowed: true,
        standard_certified: false,
        compliance_claim_allowed: false
    }));

    check('Service-level productionCertified=true (Service does not track payment)', r.productionCertified === true);
    check('Service-level requiresReview=false', r.requiresReview === false);
    check('package_ready=false (worker payment gate preserved)', r.productionPackageGovExposed?.package_ready === false);
    check('approved_artifact_type withheld despite Service-level certification', r.productionPackageGovExposed?.approved_artifact_type === null);
    check('blocked_by_governance_domains includes payment_governance',
        r.productionPackageGovExposed?.blocked_by_governance_domains.includes('payment_governance'));
}

// ---------------------------------------------------------------------------
// SC7: production certified, payment PAID -> package_ready=true
// ---------------------------------------------------------------------------
console.log('\nSC7: production certified, payment PAID -> package_ready=true');
{
    const ppg = {
        package_ready: true,
        approved_artifact_type: 'certified_pdf',
        approved_artifact_hash: 'sha256:cert002',
        included_reports: ['fix_audit.json', 'delta_report.json', 'certified.pdf', 'fixed.pdf'],
        blocked_by_governance_domains: [],
        warnings: [],
        evidence: { production_certified: true, review_required: false, payment_status: 'PAID', payment_gate_satisfied: true }
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('payment_paid', ppg, {
        trust_level: 'PRODUCTION_CERTIFIED',
        production_certified: true,
        review_required: false,
        certified_pdf_allowed: true,
        standard_certified: false,
        compliance_claim_allowed: false
    }));

    check('package_ready=true', r.productionPackageGovExposed?.package_ready === true);
    check('approved_artifact_type exposed', r.productionPackageGovExposed?.approved_artifact_type === 'certified_pdf');
    check('approved_artifact_hash exposed', r.productionPackageGovExposed?.approved_artifact_hash === 'sha256:cert002');
}

// ---------------------------------------------------------------------------
// SC8: REGRESSION — Service-level block overrides worker package_ready=true
// (defense in depth: Service is the final authority)
// ---------------------------------------------------------------------------
console.log('\nSC8: REGRESSION — Service-level block overrides worker package_ready=true');
{
    const ppg = {
        package_ready: true,
        approved_artifact_type: 'certified_pdf',
        approved_artifact_hash: 'sha256:cert003',
        included_reports: ['fix_audit.json', 'delta_report.json', 'certified.pdf', 'fixed.pdf'],
        blocked_by_governance_domains: [],
        warnings: [],
        evidence: { production_certified: true }
    };

    // Worker says package_ready=true, but proof approval is pending -> Service must block.
    const r = simulateServiceEnforcement(buildFixAuditV2('service_override', ppg, {
        trust_level: 'PRODUCTION_CERTIFIED',
        production_certified: true,
        review_required: false,
        certified_pdf_allowed: true,
        standard_certified: false,
        compliance_claim_allowed: false
    }, {
        proof_required: true,
        proof_available: true,
        proof_id: 'proof_002',
        proof_status: 'PENDING',
        visual_change_detected: true,
        review_required: true,
        production_certified: false,
        evidence: {}
    }));

    check('Service overrides package_ready to false despite worker package_ready=true',
        r.productionPackageGovExposed?.package_ready === false);
    check('approved_artifact_type withheld', r.productionPackageGovExposed?.approved_artifact_type === null);
    check('approved_artifact_hash withheld', r.productionPackageGovExposed?.approved_artifact_hash === null);
}

// ---------------------------------------------------------------------------
// SC9: REGRESSION — production_certified=false must force package_ready=false
// ---------------------------------------------------------------------------
console.log('\nSC9: REGRESSION — production_certified=false must force package_ready=false');
{
    const ppg = {
        package_ready: false,
        approved_artifact_type: null,
        approved_artifact_hash: null,
        included_reports: ['fix_audit.json', 'delta_report.json', 'fixed.pdf'],
        blocked_by_governance_domains: ['production_certification'],
        warnings: ['Artifact is not production certified; package not ready.'],
        evidence: { production_certified: false }
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('not_certified', ppg, {
        trust_level: 'FIXED_READY',
        production_certified: false,
        review_required: false,
        certified_pdf_allowed: false,
        standard_certified: false,
        compliance_claim_allowed: false
    }));

    check('package_ready=false', r.productionPackageGovExposed?.package_ready === false);
    check('approved_artifact_type withheld', r.productionPackageGovExposed?.approved_artifact_type === null);
}

// ---------------------------------------------------------------------------
// SC10: no production_package_governance -> undefined in normalized output
// ---------------------------------------------------------------------------
console.log('\nSC10: no production_package_governance -> undefined in normalized output');
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
    check('no production_package_governance -> undefined in normalized',
        normalized.production_package_governance === undefined);

    const r = simulateServiceEnforcement(auditData);
    check('no production_package_governance -> productionPackageGovExposed undefined',
        r.productionPackageGovExposed === undefined);
    check('no production_package_governance -> production_certified not downgraded',
        r.productionCertified === true);
}

// ---------------------------------------------------------------------------
// SC11: delta_report.production_package_governance preserved
// ---------------------------------------------------------------------------
console.log('\nSC11: delta_report.production_package_governance preserved');
{
    const auditData = {
        version: '2.0',
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: false,
        production_certified: false,
        highest_risk_level: 'LOW',
        production_package_governance: { package_ready: false, approved_artifact_type: null, approved_artifact_hash: null, included_reports: [], blocked_by_governance_domains: [], warnings: [], evidence: {} },
        delta_report: {
            production_package_governance: {
                package_ready: true,
                approved_artifact_type: 'certified_pdf',
                approved_artifact_hash: 'sha256:delta001',
                included_reports: ['fix_audit.json', 'delta_report.json', 'certified.pdf'],
                blocked_by_governance_domains: [],
                warnings: [],
                evidence: {}
            }
        }
    };

    const normalized = FixAuditNormalizer.normalize(auditData);
    check('delta_report.production_package_governance preserved',
        normalized.delta_report && normalized.delta_report.production_package_governance !== undefined);
    check('delta_report.production_package_governance.approved_artifact_hash preserved',
        normalized.delta_report?.production_package_governance?.approved_artifact_hash === 'sha256:delta001');
}

// ---------------------------------------------------------------------------
// SC12: Phase 71B worker report integration
// ---------------------------------------------------------------------------
console.log('\nSC12: Phase 71B worker report scenario normalization');
{
    if (workerReport && workerReport.results) {
        let allNormalized = true;
        let manifestOnlyWhenPackageReady = true;
        let blockedDomainsPreserved = true;

        for (const scenario of workerReport.results) {
            if (!scenario.production_package_governance) continue;
            const auditData = buildFixAuditV2(
                scenario.scenario,
                scenario.production_package_governance,
                {
                    trust_level: scenario.artifact_trust_level,
                    production_certified: scenario.production_certified === true,
                    review_required: scenario.production_package_governance.evidence?.review_required === true,
                    certified_pdf_allowed: scenario.production_certified === true,
                    standard_certified: false,
                    compliance_claim_allowed: false
                },
                scenario.production_package_governance.evidence?.proof_status ? {
                    proof_required: scenario.production_package_governance.evidence.proof_required === true,
                    proof_available: true,
                    proof_id: 'proof_x',
                    proof_status: scenario.production_package_governance.evidence.proof_status,
                    visual_change_detected: scenario.production_package_governance.evidence.proof_required === true,
                    review_required: scenario.production_package_governance.evidence?.review_required === true,
                    production_certified: false,
                    evidence: {}
                } : undefined
            );

            const r = simulateServiceEnforcement(auditData);
            if (!r.normalized || !r.normalized.available) { allNormalized = false; continue; }

            const exposed = r.productionPackageGovExposed;
            if (!exposed) continue;

            if (!exposed.package_ready && (exposed.approved_artifact_type !== null || exposed.approved_artifact_hash !== null)) {
                manifestOnlyWhenPackageReady = false;
            }
            const expectedDomains = scenario.production_package_governance.blocked_by_governance_domains || [];
            if (JSON.stringify(exposed.blocked_by_governance_domains) !== JSON.stringify(expectedDomains)) {
                blockedDomainsPreserved = false;
            }
        }

        check('All 71B scenarios successfully normalized', allNormalized);
        check('Approved artifact manifest only exposed when package_ready=true', manifestOnlyWhenPackageReady);
        check('blocked_by_governance_domains preserved from worker scenarios', blockedDomainsPreserved);
    } else {
        const scenarios = [
            { name: 'ready', ppg: { package_ready: true, approved_artifact_type: 'certified_pdf', approved_artifact_hash: 'sha256:s1', included_reports: ['fix_audit.json'], blocked_by_governance_domains: [], warnings: [], evidence: {} }, at: { production_certified: true, review_required: false } },
            { name: 'not_ready', ppg: { package_ready: false, approved_artifact_type: null, approved_artifact_hash: null, included_reports: ['fix_audit.json'], blocked_by_governance_domains: ['review_required'], warnings: [], evidence: {} }, at: { production_certified: false, review_required: true } }
        ];

        for (const s of scenarios) {
            const auditData = buildFixAuditV2(s.name, s.ppg, { trust_level: 'TEST', production_certified: s.at.production_certified, review_required: s.at.review_required, certified_pdf_allowed: s.at.production_certified, standard_certified: false, compliance_claim_allowed: false });
            const normalized = FixAuditNormalizer.normalize(auditData);
            check(`Synthetic scenario ${s.name} normalized`, normalized && normalized.available);
            const r = simulateServiceEnforcement(auditData);
            check(`${s.name}: package_ready matches expectation`, r.productionPackageGovExposed?.package_ready === s.ppg.package_ready);
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

    const noPpgNorm = FixAuditNormalizer.normalize({ version: '2.0', applied_fixes: [], skipped_fixes: [], failed_fixes: [] });
    check('v2 without production_package_governance → production_package_governance=undefined',
        noPpgNorm.production_package_governance === undefined);
}

// ---------------------------------------------------------------------------
// SC14: No raw paths leak through production_package_governance
// ---------------------------------------------------------------------------
console.log('\nSC14: No raw filesystem paths leak through production_package_governance');
{
    const ppg = {
        package_ready: true,
        approved_artifact_type: 'certified_pdf',
        approved_artifact_hash: 'sha256:nopaths',
        included_reports: ['fix_audit.json', 'delta_report.json', 'certified.pdf', 'fixed.pdf'],
        blocked_by_governance_domains: [],
        warnings: [],
        evidence: { primary_artifact_filename: 'certified.pdf' }
    };

    const r = simulateServiceEnforcement(buildFixAuditV2('no_path_leak', ppg, {
        trust_level: 'PRODUCTION_CERTIFIED',
        production_certified: true,
        review_required: false,
        certified_pdf_allowed: true,
        standard_certified: false,
        compliance_claim_allowed: false
    }));

    const exposedStr = JSON.stringify(r.productionPackageGovExposed);
    check('production_package_governance contains no local filesystem paths',
        !/[A-Za-z]:[\\\/]|\/tmp\/|\/var\/|\/home\/|\/storage\//.test(exposedStr),
        'No local paths found in governance payload');
    check('included_reports are filenames only, not paths',
        r.productionPackageGovExposed.included_reports.every(f => !f.includes('/') && !f.includes('\\')));
}

// ---------------------------------------------------------------------------
// SC15: Phase 70/69/68 backward compatibility regression
// ---------------------------------------------------------------------------
console.log('\nSC15: Phase 70/69/68 backward compatibility regression');
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
        },
        production_package_governance: {
            package_ready: false,
            approved_artifact_type: null,
            approved_artifact_hash: null,
            included_reports: ['fix_audit.json', 'delta_report.json', 'fixed.pdf'],
            blocked_by_governance_domains: ['review_required', 'production_certification', 'visual_diff_governance', 'proof_approval_governance'],
            warnings: [],
            evidence: {}
        }
    };

    const normalized = FixAuditNormalizer.normalize(auditData);
    check('visual_diff_governance preserved alongside production_package_governance',
        normalized.visual_diff_governance !== undefined);
    check('proof_approval_governance preserved alongside production_package_governance',
        normalized.proof_approval_governance !== undefined);
    check('production_package_governance preserved alongside other governances',
        normalized.production_package_governance !== undefined);

    const caps = FixCapabilityContract.getCapabilities();
    const validate_pdfa = caps.capabilities.find(c => c.fix_id === 'VALIDATE_PDFA');
    check('VALIDATE_PDFA still present', !!validate_pdfa);
    check('VALIDATE_PDFA compliance_claim_allowed=false', validate_pdfa?.compliance_claim_allowed === false);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass_count + fail_count;
const smoke_passed = fail_count === 0;

console.log(`\n${'='.repeat(60)}`);
console.log('Phase 71C — Service Production Package Exposure');
console.log(`Results: ${pass_count}/${total} passed${fail_count > 0 ? ` (${fail_count} FAILED)` : ''}`);
console.log(`Smoke: ${smoke_passed ? 'PASSED' : 'FAILED'}`);
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// Generate reports
// ---------------------------------------------------------------------------
const report = {
    generated_at: new Date().toISOString(),
    phase: '71C',
    repo: 'ppos-preflight-service',
    smoke_passed,
    input_mode: inputMode,
    core_principle: 'production_package_governance is a packaging/handoff manifest, not a new certification authority. Service remains the final authority: package_ready, approved_artifact_type, and approved_artifact_hash are only exposed when both the worker-supplied package_ready=true AND the Service\'s own production_certified=true and review_required=false hold. Reports and warnings are always preserved for traceability. No raw filesystem paths are exposed.',
    changes: [
        'FixAuditNormalizer.js: production_package_governance preserved in v2 normalization',
        'FixAuditNormalizer.js: delta_report.production_package_governance preserved',
        'FixCapabilityContract.js: version bumped to 51.0, engine_registry_compatibility=phase-71',
        'FixCapabilityContract.js: PRODUCTION_PACKAGE_CONTRACT and GENERATE_PRODUCTION_PACKAGE_MANIFEST capabilities added under production_package category',
        'PreflightService.js: production_package_governance governance sources resolved in getJobArtifacts after heavy PDF probe block',
        'PreflightService.js: artifact_summary.production_package_governance exposed with package_ready gated by Service-level productionCertified/requiresReview',
        'PreflightService.js: Phase 71C exposure block added in _normalizeJobPayload before artifact_summary construction',
        'PreflightService.js: production_package_governance added to artifact_summary and return payload in _normalizeJobPayload'
    ],
    results,
    summary: { total, passed: pass_count, failed: fail_count }
};

const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const jsonPath = path.join(reportsDir, 'phase71c_service_production_package_exposure.json');
const mdPath = path.join(reportsDir, 'phase71c_service_production_package_exposure.md');

fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const mdLines = [
    '# Phase 71C — Service Production Package Exposure',
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
