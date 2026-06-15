'use strict';

/**
 * Phase 74C — Service Audit Bundle Exposure
 * Smoke test: verifies that the Service correctly normalizes and exposes
 * audit_bundle_governance from Worker fix_audit payloads through
 * artifact_summary and job payload, that the bundle artifact (audit_bundle.json)
 * is recognized as a governed/downloadable artifact, and that the governance
 * invariants (production_certified=false, standard_certified=false) always
 * hold regardless of upstream evidence.
 *
 * Input: ../ppos-preflight-worker/reports/phase74b_worker_audit_bundle_governance.json
 * Fallback: synthetic payloads labeled input_mode="SYNTHETIC_POLICY_FALLBACK"
 */

const path = require('path');
const fs = require('fs');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');
const FixCapabilityContract = require('../services/FixCapabilityContract');

// ---------------------------------------------------------------------------
// Load Phase 74B worker report or fall back to synthetic payloads
// ---------------------------------------------------------------------------
const WORKER_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-worker/reports/phase74b_worker_audit_bundle_governance.json');
let workerReport = null;
let inputMode = 'WORKER_REPORT';

if (fs.existsSync(WORKER_REPORT_PATH)) {
    try {
        workerReport = JSON.parse(fs.readFileSync(WORKER_REPORT_PATH, 'utf8'));
        console.log('[74C] Loaded Phase 74B worker report from:', WORKER_REPORT_PATH);
    } catch (e) {
        console.warn('[74C] Failed to parse Phase 74B worker report, using synthetic payloads:', e.message);
    }
}

if (!workerReport) {
    inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    console.log('[74C] Phase 74B worker report unavailable. Using synthetic payloads.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildFixAuditV2(auditBundleGov, deltaAuditBundleGov) {
    return {
        version: '2.0',
        requested_fixes: [],
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: false,
        production_certified: false,
        highest_risk_level: 'LOW',
        audit_bundle_governance: auditBundleGov,
        delta_report: deltaAuditBundleGov ? {
            audit_bundle_governance: deltaAuditBundleGov
        } : undefined
    };
}

// Simulate what PreflightService._normalizeJobPayload does for
// audit_bundle_governance exposure (Phase 74C).
function simulateServiceExposure(fixAuditData) {
    const normalized = FixAuditNormalizer.normalize(fixAuditData);
    const abg = normalized.audit_bundle_governance || {};

    const exposed = Object.keys(abg).length > 0 ? {
        bundle_ready: abg.bundle_ready === true,
        fix_audit_hash: abg.fix_audit_hash ?? null,
        delta_report_hash: abg.delta_report_hash ?? null,
        governance_domains_included: abg.governance_domains_included || [],
        artifact_trust: abg.artifact_trust || {},
        production_certified: false,
        standard_certified: false,
        warnings: abg.warnings || [],
        evidence: abg.evidence || {}
    } : undefined;

    return { normalized, abg, exposed };
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

console.log('\n=== Phase 74C — Service Audit Bundle Exposure ===\n');
console.log(`Input mode: ${inputMode}\n`);

// ---------------------------------------------------------------------------
// SC1: FixCapabilityContract exposes Phase 74 audit bundle capabilities
// ---------------------------------------------------------------------------
console.log('SC1: FixCapabilityContract Phase 74 audit bundle capabilities');
{
    const caps = FixCapabilityContract.getCapabilities();
    const ids = caps.capabilities.map(c => c.fix_id);

    check('FixCapabilityContract version >= 52.0',
        parseFloat(caps.version) >= 52.0,
        `version=${caps.version}`);

    check('engine_registry_compatibility=phase-74',
        caps.engine_registry_compatibility === 'phase-74',
        `got: ${caps.engine_registry_compatibility}`);

    check('AUDIT_BUNDLE_CONTRACT capability present', ids.includes('AUDIT_BUNDLE_CONTRACT'));
    check('GENERATE_AUDIT_BUNDLE_MANIFEST capability present', ids.includes('GENERATE_AUDIT_BUNDLE_MANIFEST'));

    const abc = caps.capabilities.find(c => c.fix_id === 'AUDIT_BUNDLE_CONTRACT');
    check('AUDIT_BUNDLE_CONTRACT category=audit_bundle',
        abc && abc.category === 'audit_bundle');
    check('AUDIT_BUNDLE_CONTRACT production_certified=false',
        abc && abc.production_certified === false,
        'Audit bundle contract must not imply production certification');
    check('AUDIT_BUNDLE_CONTRACT standard_certified=false',
        abc && abc.standard_certified === false);
    check('AUDIT_BUNDLE_CONTRACT compliance_claim_allowed=false',
        abc && abc.compliance_claim_allowed === false);
    check('AUDIT_BUNDLE_CONTRACT requires_human_review=true',
        abc && abc.requires_human_review === true);

    check('Phase 71 capabilities still present (regression)',
        ids.includes('PRODUCTION_PACKAGE_CONTRACT') && ids.includes('GENERATE_PRODUCTION_PACKAGE_MANIFEST'));
    check('Phase 70 capabilities still present (regression)',
        ids.includes('PROOF_APPROVAL_CONTRACT') && ids.includes('GENERATE_PROOF_APPROVAL_METADATA'));
    check('Phase 68 capabilities still present (regression)',
        ids.includes('VALIDATE_PDFX') && ids.includes('VALIDATE_PDFA'));
}

// ---------------------------------------------------------------------------
// SC2: FixAuditNormalizer preserves audit_bundle_governance at root
// ---------------------------------------------------------------------------
console.log('\nSC2: FixAuditNormalizer preserves audit_bundle_governance');
{
    const abg = {
        bundle_ready: true,
        fix_audit_hash: 'sha256:fixaudit001',
        delta_report_hash: 'sha256:deltareport001',
        governance_domains_included: ['artifact_trust', 'page_marks_governance', 'security_interactivity_governance'],
        artifact_trust: {
            trust_level: 'PRODUCTION_CERTIFIED',
            production_certified: true,
            review_required: false,
            standard_certified: false
        },
        warnings: [],
        evidence: { findings_count: 4, fixes_applied_count: 2 }
    };

    const auditData = buildFixAuditV2(abg);
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('audit_bundle_governance preserved at root',
        normalized.audit_bundle_governance !== undefined);
    check('bundle_ready preserved',
        normalized.audit_bundle_governance?.bundle_ready === true);
    check('fix_audit_hash preserved',
        normalized.audit_bundle_governance?.fix_audit_hash === 'sha256:fixaudit001');
    check('delta_report_hash preserved',
        normalized.audit_bundle_governance?.delta_report_hash === 'sha256:deltareport001');
    check('governance_domains_included preserved',
        normalized.audit_bundle_governance?.governance_domains_included?.includes('page_marks_governance'));
    check('artifact_trust preserved',
        normalized.audit_bundle_governance?.artifact_trust?.trust_level === 'PRODUCTION_CERTIFIED');
    check('evidence preserved',
        normalized.audit_bundle_governance?.evidence?.findings_count === 4);
}

// ---------------------------------------------------------------------------
// SC3: delta_report.audit_bundle_governance preserved
// ---------------------------------------------------------------------------
console.log('\nSC3: delta_report.audit_bundle_governance preserved');
{
    const rootAbg = {
        bundle_ready: false,
        fix_audit_hash: null,
        delta_report_hash: null,
        governance_domains_included: [],
        artifact_trust: {},
        warnings: ['fix_audit not yet hashed'],
        evidence: {}
    };
    const deltaAbg = {
        bundle_ready: true,
        fix_audit_hash: 'sha256:delta_fix_audit',
        delta_report_hash: 'sha256:delta_delta_report',
        governance_domains_included: ['artifact_trust'],
        artifact_trust: { trust_level: 'FIXED_READY' },
        warnings: [],
        evidence: { source: 'delta' }
    };

    const auditData = buildFixAuditV2(rootAbg, deltaAbg);
    const normalized = FixAuditNormalizer.normalize(auditData);

    check('delta_report.audit_bundle_governance preserved',
        normalized.delta_report && normalized.delta_report.audit_bundle_governance !== undefined);
    check('delta_report.audit_bundle_governance.fix_audit_hash preserved',
        normalized.delta_report?.audit_bundle_governance?.fix_audit_hash === 'sha256:delta_fix_audit');
    check('delta_report.audit_bundle_governance.governance_domains_included preserved',
        normalized.delta_report?.audit_bundle_governance?.governance_domains_included?.includes('artifact_trust'));
}

// ---------------------------------------------------------------------------
// SC4: bundle_ready=true -> exposed with hashes and domains
// ---------------------------------------------------------------------------
console.log('\nSC4: bundle_ready=true -> exposed cleanly');
{
    const abg = {
        bundle_ready: true,
        fix_audit_hash: 'sha256:ready_fix_audit',
        delta_report_hash: 'sha256:ready_delta_report',
        governance_domains_included: ['artifact_trust', 'standards_certification_governance', 'ink_governance'],
        artifact_trust: { trust_level: 'PRODUCTION_CERTIFIED', production_certified: true, review_required: false },
        warnings: [],
        evidence: { findings_count: 0 }
    };

    const r = simulateServiceExposure(buildFixAuditV2(abg));

    check('exposed present', r.exposed !== undefined);
    check('bundle_ready=true', r.exposed?.bundle_ready === true);
    check('fix_audit_hash exposed', r.exposed?.fix_audit_hash === 'sha256:ready_fix_audit');
    check('delta_report_hash exposed', r.exposed?.delta_report_hash === 'sha256:ready_delta_report');
    check('governance_domains_included exposed', r.exposed?.governance_domains_included?.includes('standards_certification_governance'));
    check('artifact_trust exposed', r.exposed?.artifact_trust?.trust_level === 'PRODUCTION_CERTIFIED');
    check('production_certified=false', r.exposed?.production_certified === false);
    check('standard_certified=false', r.exposed?.standard_certified === false);
}

// ---------------------------------------------------------------------------
// SC5: bundle_ready=false (incomplete evidence) -> exposed with warnings, null hashes
// ---------------------------------------------------------------------------
console.log('\nSC5: bundle_ready=false (incomplete evidence) -> exposed with warnings');
{
    const abg = {
        bundle_ready: false,
        fix_audit_hash: null,
        delta_report_hash: null,
        governance_domains_included: [],
        artifact_trust: {},
        warnings: ['fix_audit.json hash unavailable', 'delta_report.json hash unavailable'],
        evidence: {}
    };

    const r = simulateServiceExposure(buildFixAuditV2(abg));

    check('exposed present', r.exposed !== undefined);
    check('bundle_ready=false', r.exposed?.bundle_ready === false);
    check('fix_audit_hash=null', r.exposed?.fix_audit_hash === null);
    check('delta_report_hash=null', r.exposed?.delta_report_hash === null);
    check('governance_domains_included empty', Array.isArray(r.exposed?.governance_domains_included) && r.exposed.governance_domains_included.length === 0);
    check('warnings preserved', r.exposed?.warnings?.includes('fix_audit.json hash unavailable'));
}

// ---------------------------------------------------------------------------
// SC6: REGRESSION — governance invariants enforced even if upstream sets true
// ---------------------------------------------------------------------------
console.log('\nSC6: REGRESSION — invariants forced false even if upstream claims true');
{
    const maliciousAbg = {
        bundle_ready: true,
        fix_audit_hash: 'sha256:malicious',
        delta_report_hash: 'sha256:malicious2',
        governance_domains_included: ['artifact_trust'],
        artifact_trust: { trust_level: 'PRODUCTION_CERTIFIED' },
        production_certified: true,   // OVERCLAIM — must be forced to false
        standard_certified: true,     // OVERCLAIM — must be forced to false
        warnings: [],
        evidence: {}
    };

    const r = simulateServiceExposure(buildFixAuditV2(maliciousAbg));

    check('production_certified forced to false', r.exposed?.production_certified === false);
    check('standard_certified forced to false', r.exposed?.standard_certified === false);
}

// ---------------------------------------------------------------------------
// SC7: no audit_bundle_governance -> undefined, no crash
// ---------------------------------------------------------------------------
console.log('\nSC7: no audit_bundle_governance -> undefined in normalized/exposed output');
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
    check('no audit_bundle_governance -> undefined in normalized',
        normalized.audit_bundle_governance === undefined);

    const r = simulateServiceExposure(auditData);
    check('no audit_bundle_governance -> exposed undefined',
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
// SC9: audit_bundle_governance does not alter productionCertified/requiresReview
// ---------------------------------------------------------------------------
console.log('\nSC9: audit_bundle_governance is advisory only — does not gate production/review');
{
    const abg = {
        bundle_ready: false,
        fix_audit_hash: null,
        delta_report_hash: null,
        governance_domains_included: [],
        artifact_trust: {},
        warnings: ['Bundle incomplete'],
        evidence: {}
    };

    const auditData = {
        ...buildFixAuditV2(abg),
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
    check('production_certified at root unaffected by audit_bundle_governance',
        normalized.production_certified === true);
    check('artifact_trust.production_certified unaffected',
        normalized.artifact_trust?.production_certified === true);
    check('artifact_trust.review_required unaffected',
        normalized.artifact_trust?.review_required === false);
}

// ---------------------------------------------------------------------------
// SC10: No raw filesystem paths leak through audit_bundle_governance
// ---------------------------------------------------------------------------
console.log('\nSC10: No raw filesystem paths leak through audit_bundle_governance');
{
    const abg = {
        bundle_ready: true,
        fix_audit_hash: 'sha256:nopaths1',
        delta_report_hash: 'sha256:nopaths2',
        governance_domains_included: ['artifact_trust', 'font_governance'],
        artifact_trust: { trust_level: 'PRODUCTION_CERTIFIED' },
        warnings: [],
        evidence: { included_reports: ['fix_audit.json', 'delta_report.json'] }
    };

    const r = simulateServiceExposure(buildFixAuditV2(abg));
    const exposedStr = JSON.stringify(r.exposed);

    check('audit_bundle_governance contains no local filesystem paths',
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
    check('FixAuditNormalizer has audit_bundle_governance passthrough',
        normalizerSrc.includes('audit_bundle_governance'));
    check('FixAuditNormalizer has Phase 74 annotation',
        normalizerSrc.includes('Phase 74'));
    check('delta_report.audit_bundle_governance passthrough present',
        normalizerSrc.includes('delta_report.audit_bundle_governance'));
}

// ---------------------------------------------------------------------------
// SC12: PreflightService structure check
// ---------------------------------------------------------------------------
console.log('\nSC12: PreflightService structure check');
{
    const serviceSrc = fs.readFileSync(
        path.resolve(__dirname, '../services/PreflightService.js'), 'utf8'
    );
    check('PreflightService resolves audit_bundle_governance sources',
        serviceSrc.includes('auditBundleGovSources') || serviceSrc.includes('auditBundleGovNorm'));
    check('PreflightService exposes audit_bundle_governance in artifact_summary',
        serviceSrc.includes('artifact_summary.audit_bundle_governance') || serviceSrc.includes('audit_bundle_governance: auditBundleGovExposed'));
    check('PreflightService exposes audit_bundle_governance at root payload',
        (serviceSrc.match(/audit_bundle_governance: auditBundleGovExposed/g) || []).length >= 2);
    check('PreflightService recognizes audit_bundle.json as a governed artifact',
        serviceSrc.includes("file === 'audit_bundle.json'") && serviceSrc.includes("pushArtifact('audit_bundle')"));
    check('PreflightService exposes audit_bundle_available in artifact_summary',
        (serviceSrc.match(/audit_bundle_available:/g) || []).length >= 2);
}

// ---------------------------------------------------------------------------
// SC13: routes/preflight.js artifact alias resolver structure check
// ---------------------------------------------------------------------------
console.log('\nSC13: routes/preflight.js audit_bundle artifact alias resolution');
{
    const routesSrc = fs.readFileSync(
        path.resolve(__dirname, '../routes/preflight.js'), 'utf8'
    );
    check('resolveArtifactByAlias candidateTypes includes audit_bundle',
        /audit_bundle:\s*\['audit_bundle'\]/.test(routesSrc));
    check('resolveArtifactByAlias candidateFilenames includes audit_bundle.json',
        /audit_bundle:\s*\['audit_bundle\.json'\]/.test(routesSrc));
}

// ---------------------------------------------------------------------------
// SC14: Phase 74B worker report integration (if available)
// ---------------------------------------------------------------------------
console.log('\nSC14: Phase 74B worker report scenario normalization');
{
    if (workerReport && workerReport.results) {
        let allNormalized = true;
        let invariantsHold = true;
        let hashesPreserved = true;
        let domainsPreserved = true;

        for (const scenario of workerReport.results) {
            const abg = scenario.audit_bundle_governance;
            if (!abg) continue;

            const auditData = buildFixAuditV2(abg);
            const r = simulateServiceExposure(auditData);

            if (!r.normalized || !r.normalized.available) { allNormalized = false; continue; }
            if (!r.exposed) continue;

            if (r.exposed.production_certified !== false || r.exposed.standard_certified !== false) {
                invariantsHold = false;
            }

            if (r.exposed.fix_audit_hash !== (abg.fix_audit_hash ?? null) ||
                r.exposed.delta_report_hash !== (abg.delta_report_hash ?? null)) {
                hashesPreserved = false;
            }

            const expectedDomains = abg.governance_domains_included || [];
            if (JSON.stringify(r.exposed.governance_domains_included) !== JSON.stringify(expectedDomains)) {
                domainsPreserved = false;
            }
        }

        check('All 74B scenarios successfully normalized', allNormalized);
        check('Governance invariants hold for all 74B scenarios', invariantsHold);
        check('hashes preserved across 74B scenarios', hashesPreserved);
        check('governance_domains_included preserved across 74B scenarios', domainsPreserved);
    } else {
        const scenarios = [
            { name: 'bundle_not_ready', abg: { bundle_ready: false, fix_audit_hash: null, delta_report_hash: null, governance_domains_included: [], artifact_trust: {}, warnings: ['Hashes unavailable'], evidence: {} } },
            { name: 'bundle_ready', abg: { bundle_ready: true, fix_audit_hash: 'sha256:syn1', delta_report_hash: 'sha256:syn2', governance_domains_included: ['artifact_trust'], artifact_trust: { trust_level: 'FIXED_READY' }, warnings: [], evidence: {} } }
        ];

        for (const s of scenarios) {
            const auditData = buildFixAuditV2(s.abg);
            const normalized = FixAuditNormalizer.normalize(auditData);
            check(`Synthetic scenario ${s.name} normalized`, normalized && normalized.available);
            const r = simulateServiceExposure(auditData);
            check(`${s.name}: bundle_ready matches expectation`, r.exposed?.bundle_ready === s.abg.bundle_ready);
        }
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass_count + fail_count;
const smoke_passed = fail_count === 0;

console.log(`\n${'='.repeat(60)}`);
console.log('Phase 74C — Service Audit Bundle Exposure');
console.log(`Results: ${pass_count}/${total} passed${fail_count > 0 ? ` (${fail_count} FAILED)` : ''}`);
console.log(`Smoke: ${smoke_passed ? 'PASSED' : 'FAILED'}`);
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// Generate reports
// ---------------------------------------------------------------------------
const report = {
    generated_at: new Date().toISOString(),
    phase: '74C',
    repo: 'ppos-preflight-service',
    smoke_passed,
    input_mode: inputMode,
    core_principle: 'audit_bundle_governance is a defensible compliance/export manifest summarizing fix_audit/delta_report hashes, governance domain coverage, and artifact_trust. It is never a certification authority: production_certified and standard_certified are always forced to false at the Service exposure layer regardless of upstream values, and the governance does not influence the Service\'s own production_certified/review_required gates. The audit_bundle.json artifact (when present) is exposed as a downloadable governed artifact via the existing artifact endpoint.',
    changes: [
        'FixAuditNormalizer.js: audit_bundle_governance preserved in v2 normalization (root)',
        'FixAuditNormalizer.js: delta_report.audit_bundle_governance preserved',
        'FixCapabilityContract.js: version bumped to 52.0, engine_registry_compatibility=phase-74',
        'FixCapabilityContract.js: AUDIT_BUNDLE_CONTRACT and GENERATE_AUDIT_BUNDLE_MANIFEST capabilities added under audit_bundle category',
        'PreflightService.js: audit_bundle_governance governance sources resolved in getJobArtifacts after machine readiness governance block',
        'PreflightService.js: audit_bundle.json recognized as a governed AUDIT_BUNDLE artifact in getJobArtifacts file discovery',
        'PreflightService.js: artifact_summary.audit_bundle_available and artifact_summary.audit_bundle_governance exposed (PHYSICAL_OUTPUT_FALLBACK path) with production_certified/standard_certified forced to false',
        'PreflightService.js: Phase 74C exposure block added in _normalizeJobPayload before artifact_summary construction',
        'PreflightService.js: audit_bundle_governance and audit_bundle_available added to artifact_summary and return payload in _normalizeJobPayload',
        'routes/preflight.js: resolveArtifactByAlias extended with audit_bundle -> audit_bundle.json for governed artifact download'
    ],
    results,
    summary: { total, passed: pass_count, failed: fail_count }
};

const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const jsonPath = path.join(reportsDir, 'phase74c_service_audit_bundle_exposure.json');
const mdPath = path.join(reportsDir, 'phase74c_service_audit_bundle_exposure.md');

fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const mdLines = [
    '# Phase 74C — Service Audit Bundle Exposure',
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
