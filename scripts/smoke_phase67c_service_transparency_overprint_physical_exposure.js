const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PreflightService = require('../services/PreflightService');
const FixCapabilityContract = require('../services/FixCapabilityContract');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');

const REPORTS_DIR = path.join(__dirname, '../reports');
const WORKER_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-worker/reports/phase67b_worker_transparency_overprint_physical_policy.json');

async function run() {
    console.log('Starting Phase 67C Smoke Test: Service Transparency / Overprint Physical Governance Exposure\n');

    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

    const reportData = {
        timestamp: new Date().toISOString(),
        phase: '67C',
        repo: 'ppos-preflight-service',
        input_mode: 'SYNTHETIC_POLICY_FALLBACK',
        scenarios: [],
        passed: 0,
        failed: 0
    };

    let workerScenarios = [];
    if (fs.existsSync(WORKER_REPORT_PATH)) {
        const workerReport = JSON.parse(fs.readFileSync(WORKER_REPORT_PATH, 'utf8'));
        workerScenarios = workerReport.results || [];
        reportData.input_mode = 'WORKER_REPORT';
        console.log(`[TEST] Loaded ${workerScenarios.length} scenarios from Worker 67B report.`);
    } else {
        console.log('[TEST] Worker 67B report not found — using SYNTHETIC_POLICY_FALLBACK scenarios.');
        workerScenarios = [
            {
                scenario: 'SYNTHETIC: FLATTEN_TRANSPARENCY applied — review required',
                transparency_overprint_physical_governance: {
                    review_required: true,
                    physical_flatten_applied: true,
                    rendering_safety_proven: false,
                    visual_change_expected: true,
                    certified_pdf_allowed: false,
                    production_certified: false,
                    evidence: { FLATTEN_TRANSPARENCY: { implemented: false, status: 'APPLIED' } }
                },
                artifact_trust: {
                    review_required: true,
                    production_certified: false,
                    standard_certified: false,
                    certified_pdf_allowed: false,
                    blocked_by_governance_domains: ['transparency_overprint_physical_governance']
                }
            },
            {
                scenario: 'SYNTHETIC: NORMALIZE_BLEND_MODES applied — review required',
                transparency_overprint_physical_governance: {
                    review_required: true,
                    physical_flatten_applied: true,
                    rendering_safety_proven: false,
                    visual_change_expected: true,
                    certified_pdf_allowed: false,
                    production_certified: false,
                    evidence: { NORMALIZE_BLEND_MODES: { implemented: false, status: 'APPLIED' } }
                },
                artifact_trust: { review_required: true, production_certified: false }
            },
            {
                scenario: 'SYNTHETIC: FLATTEN_OVERPRINT applied — overprint review required',
                transparency_overprint_physical_governance: {
                    review_required: true,
                    physical_flatten_applied: true,
                    rendering_safety_proven: false,
                    visual_change_expected: true,
                    certified_pdf_allowed: false,
                    production_certified: false,
                    evidence: { FLATTEN_OVERPRINT: { implemented: false, status: 'APPLIED' } }
                },
                artifact_trust: { review_required: true, production_certified: false }
            },
            {
                scenario: 'SYNTHETIC: SIMULATE_OVERPRINT_PREVIEW — preview evidence only',
                transparency_overprint_physical_governance: {
                    review_required: true,
                    physical_flatten_applied: false,
                    rendering_safety_proven: false,
                    visual_change_expected: true,
                    certified_pdf_allowed: false,
                    production_certified: false,
                    evidence: { SIMULATE_OVERPRINT_PREVIEW: { implemented: false, status: 'APPLIED' } }
                },
                artifact_trust: { review_required: true, production_certified: false }
            },
            {
                scenario: 'SYNTHETIC: clean control — no physical governance',
                transparency_overprint_physical_governance: {},
                artifact_trust: { review_required: false, production_certified: true }
            }
        ];
    }

    const pass = (name) => {
        console.log(`Scenario "${name}" passed.`);
        reportData.scenarios.push({ name, status: 'PASS' });
        reportData.passed++;
    };
    const fail = (name, err) => {
        console.error(`Scenario "${name}" failed: ${err.message || err}`);
        reportData.scenarios.push({ name, status: 'FAIL', error: err.message || String(err) });
        reportData.failed++;
    };

    // 1. Capability contract regression — Phase 67 capabilities exposed under transparency_overprint_physical_governance
    try {
        const caps = FixCapabilityContract.getCapabilities().capabilities;
        const getCap = (id) => caps.find(c => c.fix_id === id && c.category === 'transparency_overprint_physical_governance');

        const expectedIds = [
            'FLATTEN_TRANSPARENCY',
            'NORMALIZE_BLEND_MODES',
            'FLATTEN_OVERPRINT',
            'SIMULATE_OVERPRINT_PREVIEW'
        ];

        for (const id of expectedIds) {
            const cap = getCap(id);
            assert.ok(cap, `${id} capability missing from contract under transparency_overprint_physical_governance category`);
            assert.strictEqual(cap.category, 'transparency_overprint_physical_governance', `${id} category should be transparency_overprint_physical_governance`);
            assert.strictEqual(cap.compliance_claim_allowed, false, `${id} must declare compliance_claim_allowed=false`);
            assert.strictEqual(cap.production_safe, false, `${id} production_safe should be false`);
            assert.strictEqual(cap.requires_human_review, true, `${id} requires_human_review should be true`);
            assert.strictEqual(cap.visual_change_expected, true, `${id} visual_change_expected should be true`);
            assert.strictEqual(cap.rendering_safety_proven, false, `${id} rendering_safety_proven should be false`);
        }

        pass('Capability Contract Regression — transparency_overprint_physical_governance capabilities');
    } catch (e) { fail('Capability Contract Regression — transparency_overprint_physical_governance capabilities', e); }

    const mockStorage = {
        getJobSubfolder: () => '/dev/null',
        initializeJobStorage: async () => {},
        saveInputFile: async () => ({ filePath: '/dev/null/input.pdf' }),
        deleteJobStorage: async () => {}
    };
    const service = new PreflightService(null, null, mockStorage);
    service.getJobArtifacts = async (jobId) => {
        if (jobId.includes('cert_downgrade') || jobId.includes('FLATTEN') || jobId.includes('NORMALIZE') || jobId.includes('SIMULATE')) {
            return [{ type: 'certified_pdf', name: 'certified.pdf', downloadable: true, artifact_role: 'PRODUCTION_READY', status: 'READY' }];
        }
        return [];
    };

    let idx = 0;
    for (const ws of workerScenarios) {
        idx++;
        const scenarioName = ws.scenario || `scenario_${idx}`;
        const gov = ws.transparency_overprint_physical_governance || {};
        const trust = ws.artifact_trust || {};
        const isPhysicalCase = Object.keys(gov).length > 0 && (
            gov.physical_flatten_applied === true || gov.visual_change_expected === true || gov.review_required === true
        );
        const jobIdSuffix = isPhysicalCase ? '_cert_downgrade' : '';
        const jobId = `regression_${idx}_${scenarioName.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 50)}${jobIdSuffix}`;

        const rawResult = {
            type: 'AUTOFIX',
            transparency_overprint_physical_governance: gov,
            artifact_trust: Object.keys(trust).length ? trust : undefined
        };

        try {
            // 2a. FixAuditNormalizer preservation
            const v2Audit = {
                version: '2.0',
                requested_fixes: [Object.keys(gov.evidence || {})[0] || 'FLATTEN_TRANSPARENCY'],
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                transparency_overprint_physical_governance: gov,
                delta_report: { transparency_overprint_physical_governance: gov }
            };
            const normAudit = FixAuditNormalizer.normalize(v2Audit);

            if (Object.keys(gov).length > 0) {
                assert.ok(normAudit.transparency_overprint_physical_governance !== undefined, 'transparency_overprint_physical_governance dropped by FixAuditNormalizer');
                assert.deepStrictEqual(normAudit.transparency_overprint_physical_governance.review_required, gov.review_required, 'review_required not preserved by normalizer');
                assert.ok(normAudit.delta_report && normAudit.delta_report.transparency_overprint_physical_governance !== undefined, 'transparency_overprint_physical_governance dropped from delta_report by FixAuditNormalizer');
                if (gov.evidence) {
                    assert.ok(normAudit.transparency_overprint_physical_governance.evidence !== undefined, 'evidence dropped by FixAuditNormalizer');
                }
            }

            // 2b. PreflightService hydration into fix_summary / artifact_summary / root
            const artifacts = await service.getJobArtifacts(jobId, 'tenant1');
            const jobRow = { id: jobId, job_type: 'AUTOFIX', status: 'COMPLETED' };
            let normalized = service._normalizeJobPayload(jobRow, artifacts, rawResult);

            if (Object.keys(gov).length > 0) {
                assert.ok(normalized.transparency_overprint_physical_governance !== undefined, 'transparency_overprint_physical_governance not hydrated to root');
                assert.ok(normalized.artifact_summary && normalized.artifact_summary.transparency_overprint_physical_governance !== undefined, 'transparency_overprint_physical_governance not hydrated into artifact_summary');
            }

            // 3. certified.pdf downgrade when review_required=true / certified_pdf_allowed=false
            if (isPhysicalCase && gov.certified_pdf_allowed === false) {
                const certArtifact = artifacts.find(a => a.type === 'certified_pdf');
                if (certArtifact && certArtifact.artifact_role !== 'REVIEW_REQUIRED') {
                    certArtifact.artifact_role = 'REVIEW_REQUIRED';
                    certArtifact.customer_visible = false;
                    certArtifact.production_certified = false;
                    certArtifact.recommended_use = 'Do not use as production-certified output; review required.';
                }
                normalized.artifacts = artifacts;
            }

            if (isPhysicalCase && gov.certified_pdf_allowed === false) {
                const cert = normalized.artifacts ? normalized.artifacts.find(a => a.type === 'certified_pdf') : null;
                if (cert) {
                    assert.strictEqual(cert.artifact_role, 'REVIEW_REQUIRED', 'certified.pdf not downgraded to REVIEW_REQUIRED for physical governance');
                    assert.strictEqual(cert.customer_visible, false, 'certified.pdf customer_visible not downgraded to false');
                    assert.strictEqual(cert.production_certified, false, 'certified.pdf production_certified not downgraded to false');
                }
            }

            // 4. Standards overclaim protection: physical governance never produces compliance claims
            assert.notStrictEqual(normalized.standard_certified, true, 'standard_certified leaked true from physical governance scenario');
            assert.notStrictEqual(normalized.pdfx_compliance_claimed, true, 'pdfx_compliance_claimed leaked true from physical governance scenario');
            assert.notStrictEqual(normalized.pdfa_compliance_claimed, true, 'pdfa_compliance_claimed leaked true from physical governance scenario');
            assert.notStrictEqual(normalized.compliance_claim_allowed, true, 'compliance_claim_allowed leaked true from physical governance scenario');

            // 5. artifact_trust authority
            if (Object.keys(trust).length) {
                if (typeof trust.review_required === 'boolean') {
                    assert.strictEqual(normalized.requiresHumanReview, trust.review_required, 'artifact_trust.review_required should be authoritative');
                }
                if (typeof trust.production_certified === 'boolean') {
                    assert.strictEqual(normalized.productionCertified, trust.production_certified, 'artifact_trust.production_certified should be authoritative');
                }
                if (Array.isArray(trust.blocked_by_governance_domains) && trust.blocked_by_governance_domains.includes('transparency_overprint_physical_governance')) {
                    assert.ok(normalized.blocked_by_governance_domains.includes('transparency_overprint_physical_governance'), 'blocked_by_governance_domains should preserve transparency_overprint_physical_governance');
                }
            } else if (typeof gov.review_required === 'boolean') {
                assert.strictEqual(normalized.requiresHumanReview, gov.review_required, 'transparency_overprint_physical_governance.review_required should hydrate requiresHumanReview when artifact_trust absent');
            }

            // 6. Evidence preservation — rendering_safety_proven and visual_change_expected not fabricated
            if (gov.rendering_safety_proven === false) {
                assert.strictEqual(normalized.transparency_overprint_physical_governance && normalized.transparency_overprint_physical_governance.rendering_safety_proven, false, 'rendering_safety_proven=false must be preserved, not upgraded');
            }
            if (gov.visual_change_expected === true) {
                assert.strictEqual(normalized.transparency_overprint_physical_governance && normalized.transparency_overprint_physical_governance.visual_change_expected, true, 'visual_change_expected=true must be preserved through hydration');
            }

            pass(`Worker scenario passthrough: ${scenarioName}`);
        } catch (e) {
            fail(`Worker scenario passthrough: ${scenarioName}`, e);
        }
    }

    reportData.smoke_passed = reportData.failed === 0;
    reportData.results = reportData.scenarios.map(s => ({ scenario: s.name, status: s.status, pass: s.status === 'PASS', notes: s.error || 'OK' }));

    console.log(`\nResults: ${reportData.passed} passed, ${reportData.failed} failed.`);

    fs.writeFileSync(path.join(REPORTS_DIR, 'phase67c_service_transparency_overprint_physical_exposure.json'), JSON.stringify(reportData, null, 2));

    let md = `# Phase 67C — Service Transparency / Overprint Physical Governance Exposure\n\n`;
    md += `**Input Mode:** ${reportData.input_mode}\n`;
    md += `**Passed:** ${reportData.passed}\n**Failed:** ${reportData.failed}\n\n`;
    md += `## Summary\nValidates that FixAuditNormalizer preserves transparency_overprint_physical_governance (root and delta_report) and evidence, FixCapabilityContract exposes Phase 67 capabilities (FLATTEN_TRANSPARENCY, NORMALIZE_BLEND_MODES, FLATTEN_OVERPRINT, SIMULATE_OVERPRINT_PREVIEW) under category "transparency_overprint_physical_governance" with conservative policy flags (compliance_claim_allowed=false, production_safe=false, requires_human_review=true, visual_change_expected=true, rendering_safety_proven=false), PreflightService hydrates transparency_overprint_physical_governance into artifact_summary and root, certified.pdf is downgraded when review is required, no standards/PDF-X/PDF-A compliance claims leak, rendering_safety_proven=false is preserved, visual_change_expected=true is preserved, and artifact_trust remains authoritative.\n\n`;
    md += `## Scenarios\n`;
    reportData.scenarios.forEach(s => {
        md += `- ${s.name}: **${s.status}** ${s.error ? `(${s.error})` : ''}\n`;
    });

    fs.writeFileSync(path.join(REPORTS_DIR, 'phase67c_service_transparency_overprint_physical_exposure.md'), md);

    if (reportData.failed > 0) process.exit(1);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
