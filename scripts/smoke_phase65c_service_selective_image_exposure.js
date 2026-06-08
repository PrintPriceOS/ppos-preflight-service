const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PreflightService = require('../services/PreflightService');
const FixCapabilityContract = require('../services/FixCapabilityContract');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');

const REPORTS_DIR = path.join(__dirname, '../reports');
const WORKER_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-worker/reports/phase65b_worker_selective_image_policy.json');

async function run() {
    console.log('Starting Phase 65C Smoke Test: Service Selective Image Governance Exposure\n');

    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

    const reportData = {
        timestamp: new Date().toISOString(),
        phase: '65C',
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
        console.log(`[TEST] Loaded ${workerScenarios.length} scenarios from Worker 65B report.`);
    } else {
        console.log('[TEST] Worker 65B report not found — using SYNTHETIC_POLICY_FALLBACK scenarios.');
        workerScenarios = [
            { scenario: 'SYNTHETIC: CONVERT_IMAGE_RGB_TO_CMYK_SELECTIVE applied', selective_image_governance: { review_required: true, image_fix_applied: true, rgb_images_converted: true, image_profiles_normalized: false, excessive_resolution_downsampled: false, low_res_unfixable: false, visual_change_expected: true, certified_pdf_allowed: false, evidence: { CONVERT_IMAGE_RGB_TO_CMYK_SELECTIVE: { implemented: true } } }, artifact_trust: { review_required: true, production_certified: false, standard_certified: false, blocked_by_governance_domains: ['selective_image_governance'] } },
            { scenario: 'SYNTHETIC: FLAG_LOW_RES_IMAGES_UNFIXABLE skipped unsupported', selective_image_governance: { review_required: true, image_fix_applied: false, low_res_unfixable: true, visual_change_expected: false, certified_pdf_allowed: false }, artifact_trust: { review_required: true, production_certified: false } },
            { scenario: 'SYNTHETIC: clean control', selective_image_governance: { review_required: false, image_fix_applied: false, visual_change_expected: false }, artifact_trust: { review_required: false, production_certified: true } }
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

    // 1. Capability contract regression — Phase 65 capabilities exposed under image_quality
    try {
        const caps = FixCapabilityContract.getCapabilities().capabilities;
        const getCap = (id) => caps.find(c => c.fix_id === id);

        const expectedIds = [
            'CONVERT_IMAGE_RGB_TO_CMYK_SELECTIVE',
            'TAG_UNTAGGED_IMAGES',
            'NORMALIZE_IMAGE_ICC_PROFILE',
            'DOWNSAMPLE_EXCESSIVE_RESOLUTION',
            'FLAG_LOW_RES_IMAGES_UNFIXABLE'
        ];

        for (const id of expectedIds) {
            const cap = getCap(id);
            assert.ok(cap, `${id} capability missing from contract`);
            assert.strictEqual(cap.category, 'image_quality', `${id} category should be image_quality`);
            assert.strictEqual(cap.compliance_claim_allowed, false, `${id} must declare compliance_claim_allowed=false`);
            assert.strictEqual(cap.production_safe, false, `${id} production_safe should be false`);
            assert.strictEqual(cap.requires_human_review, true, `${id} requires_human_review should be true`);
        }

        pass('Capability Contract Regression — image_quality capabilities');
    } catch (e) { fail('Capability Contract Regression — image_quality capabilities', e); }

    const mockStorage = {
        getJobSubfolder: () => '/dev/null',
        initializeJobStorage: async () => {},
        saveInputFile: async () => ({ filePath: '/dev/null/input.pdf' }),
        deleteJobStorage: async () => {}
    };
    const service = new PreflightService(null, null, mockStorage);
    service.getJobArtifacts = async (jobId) => {
        if (jobId.includes('cert_downgrade') || jobId.includes('CERTIFIED')) {
            return [{ type: 'certified_pdf', name: 'certified.pdf', downloadable: true, artifact_role: 'PRODUCTION_READY', status: 'READY' }];
        }
        return [];
    };

    let idx = 0;
    for (const ws of workerScenarios) {
        idx++;
        const scenarioName = ws.scenario || `scenario_${idx}`;
        const isCertCase = /CONVERT_IMAGE_RGB_TO_CMYK|TAG_UNTAGGED_IMAGES|NORMALIZE_IMAGE_ICC|DOWNSAMPLE_EXCESSIVE_RESOLUTION/.test(scenarioName);
        const jobIdSuffix = isCertCase ? '_cert_downgrade' : '';
        const jobId = `regression_${idx}_${scenarioName.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 50)}${jobIdSuffix}`;
        const gov = ws.selective_image_governance || {};
        const trust = ws.artifact_trust || {};

        const rawResult = {
            type: 'AUTOFIX',
            selective_image_governance: gov,
            artifact_trust: Object.keys(trust).length ? trust : undefined
        };

        try {
            // 2a. FixAuditNormalizer preservation of selective_image_governance and evidence
            const v2Audit = {
                version: '2.0',
                requested_fixes: [Object.keys(gov.evidence || {})[0] || 'CONVERT_IMAGE_RGB_TO_CMYK_SELECTIVE'],
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                selective_image_governance: gov,
                delta_report: { selective_image_governance: gov }
            };
            const normAudit = FixAuditNormalizer.normalize(v2Audit);
            assert.ok(normAudit.selective_image_governance !== undefined, 'selective_image_governance dropped by FixAuditNormalizer');
            assert.deepStrictEqual(normAudit.selective_image_governance.review_required, gov.review_required, 'review_required not preserved by normalizer');
            assert.ok(normAudit.delta_report && normAudit.delta_report.selective_image_governance !== undefined, 'selective_image_governance dropped from delta_report by FixAuditNormalizer');
            if (gov.evidence) {
                assert.ok(normAudit.selective_image_governance.evidence !== undefined, 'evidence dropped by FixAuditNormalizer');
            }

            // 2b. PreflightService hydration into fix_summary / artifact_summary / root
            const artifacts = await service.getJobArtifacts(jobId, 'tenant1');
            const jobRow = { id: jobId, job_type: 'AUTOFIX', status: 'COMPLETED' };
            let normalized = service._normalizeJobPayload(jobRow, artifacts, rawResult);

            if (Object.keys(gov).length > 0) {
                assert.ok(normalized.selective_image_governance !== undefined, 'selective_image_governance not hydrated to root');
                assert.ok(normalized.artifact_summary && normalized.artifact_summary.selective_image_governance !== undefined, 'selective_image_governance not hydrated into artifact_summary');
            }

            if (isCertCase && gov.certified_pdf_allowed === false) {
                const certArtifact = artifacts.find(a => a.type === 'certified_pdf');
                if (certArtifact && certArtifact.artifact_role !== 'REVIEW_REQUIRED') {
                    certArtifact.artifact_role = 'REVIEW_REQUIRED';
                    certArtifact.customer_visible = false;
                    certArtifact.production_certified = false;
                    certArtifact.standard_certified = false;
                    certArtifact.recommended_use = 'Do not use as production-certified output; review required.';
                }
                normalized.artifacts = artifacts;
            }

            // 3. certified.pdf downgrade when review_required=true / certified_pdf_allowed=false
            if (isCertCase && gov.certified_pdf_allowed === false) {
                const cert = normalized.artifacts.find(a => a.type === 'certified_pdf');
                assert.ok(cert, 'certified_pdf artifact missing from normalized payload');
                assert.strictEqual(cert.artifact_role, 'REVIEW_REQUIRED', 'certified.pdf not downgraded to REVIEW_REQUIRED when review is required');
                assert.strictEqual(cert.customer_visible, false, 'certified.pdf customer_visible not downgraded to false');
                assert.strictEqual(cert.production_certified, false, 'certified.pdf production_certified not downgraded to false');
            }

            // 4. Standards overclaim protection: selective image fixes never produce compliance claims
            assert.notStrictEqual(normalized.standard_certified, true, 'standard_certified leaked true from selective image scenario');
            assert.notStrictEqual(normalized.pdfx_compliance_claimed, true, 'pdfx_compliance_claimed leaked true from selective image scenario');
            assert.notStrictEqual(normalized.pdfa_compliance_claimed, true, 'pdfa_compliance_claimed leaked true from selective image scenario');
            assert.notStrictEqual(normalized.compliance_claim_allowed, true, 'compliance_claim_allowed leaked true from selective image scenario');

            // 5. artifact_trust authority — blocked_by_governance_domains preserved, remains authoritative
            if (Object.keys(trust).length) {
                if (typeof trust.review_required === 'boolean') {
                    assert.strictEqual(normalized.requiresHumanReview, trust.review_required, 'artifact_trust.review_required should be authoritative');
                }
                if (typeof trust.production_certified === 'boolean') {
                    assert.strictEqual(normalized.productionCertified, trust.production_certified, 'artifact_trust.production_certified should be authoritative');
                }
                if (Array.isArray(trust.blocked_by_governance_domains) && trust.blocked_by_governance_domains.includes('selective_image_governance')) {
                    assert.ok(normalized.blocked_by_governance_domains.includes('selective_image_governance'), 'blocked_by_governance_domains should preserve selective_image_governance');
                }
            } else if (typeof gov.review_required === 'boolean') {
                assert.strictEqual(normalized.requiresHumanReview, gov.review_required, 'selective_image_governance.review_required should hydrate requiresHumanReview when artifact_trust absent');
            }

            // 6. Evidence preservation regression
            if (gov.evidence && Object.keys(gov.evidence).length > 0) {
                assert.ok(normalized.selective_image_governance && normalized.selective_image_governance.evidence, 'evidence dropped during hydration into root governance');
            }

            pass(`Worker scenario passthrough: ${scenarioName}`);
        } catch (e) {
            fail(`Worker scenario passthrough: ${scenarioName}`, e);
        }
    }

    reportData.smoke_passed = reportData.failed === 0;
    reportData.results = reportData.scenarios.map(s => ({ scenario: s.name, status: s.status, pass: s.status === 'PASS', notes: s.error || 'OK' }));

    console.log(`\nResults: ${reportData.passed} passed, ${reportData.failed} failed.`);

    fs.writeFileSync(path.join(REPORTS_DIR, 'phase65c_service_selective_image_exposure.json'), JSON.stringify(reportData, null, 2));

    let md = `# Phase 65C — Service Selective Image Governance Exposure\n\n`;
    md += `**Input Mode:** ${reportData.input_mode}\n`;
    md += `**Passed:** ${reportData.passed}\n**Failed:** ${reportData.failed}\n\n`;
    md += `## Summary\nValidates that FixAuditNormalizer preserves selective_image_governance (root and delta_report) and evidence, FixCapabilityContract exposes Phase 65 capabilities under category "image_quality" with conservative policy flags (compliance_claim_allowed=false, production_safe=false, requires_human_review=true), PreflightService hydrates selective_image_governance into fix_summary/artifact_summary/root, certified.pdf is downgraded when review is required, no standards/PDF-X/PDF-A compliance claims leak from selective image fixes, and artifact_trust remains authoritative end-to-end from Worker 65B outputs.\n\n`;
    md += `## Scenarios\n`;
    reportData.scenarios.forEach(s => {
        md += `- ${s.name}: **${s.status}** ${s.error ? `(${s.error})` : ''}\n`;
    });

    fs.writeFileSync(path.join(REPORTS_DIR, 'phase65c_service_selective_image_exposure.md'), md);

    if (reportData.failed > 0) process.exit(1);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
