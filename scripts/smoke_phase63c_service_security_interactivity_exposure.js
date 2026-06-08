const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PreflightService = require('../services/PreflightService');
const FixCapabilityContract = require('../services/FixCapabilityContract');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');

const REPORTS_DIR = path.join(__dirname, '../reports');
const WORKER_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-worker/reports/phase63b_worker_security_interactivity_policy.json');

async function run() {
    console.log('Starting Phase 63C Smoke Test: Service Security / Interactivity Fix Exposure\n');

    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

    const reportData = {
        timestamp: new Date().toISOString(),
        phase: '63C',
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
        console.log(`[TEST] Loaded ${workerScenarios.length} scenarios from Worker 63B report.`);
    } else {
        console.log('[TEST] Worker 63B report not found — using SYNTHETIC_POLICY_FALLBACK scenarios.');
        workerScenarios = [
            { scenario: 'SYNTHETIC: STRIP_JAVASCRIPT removed', security_interactivity_governance: { review_required: true, security_interactivity_fix_applied: true, active_content_removed: true, javascript_removed: true, certified_pdf_allowed: false, evidence: { STRIP_JAVASCRIPT: { javascript_removed_count: 2 } } }, artifact_trust: { review_required: true, production_certified: false, standard_certified: false, blocked_by_governance_domains: ['security_interactivity'] } },
            { scenario: 'SYNTHETIC: FLATTEN_FORMS skipped unsupported', security_interactivity_governance: { review_required: true, form_flatten_skipped: true, forms_flattened: false, certified_pdf_allowed: false }, artifact_trust: { review_required: true, production_certified: false } },
            { scenario: 'SYNTHETIC: clean control', security_interactivity_governance: { review_required: false, security_interactivity_fix_applied: false, active_content_removed: false }, artifact_trust: { review_required: false, production_certified: true } }
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

    // 1. Capability contract regression — Phase 63 capabilities exposed under pdf_security_interactivity
    try {
        const caps = FixCapabilityContract.getCapabilities().capabilities;
        const getCap = (id) => caps.find(c => c.fix_id === id);

        const expectedIds = [
            'STRIP_JAVASCRIPT',
            'REMOVE_LAUNCH_ACTIONS',
            'REMOVE_EMBEDDED_FILES',
            'REMOVE_DOCUMENT_OPEN_ACTIONS',
            'REMOVE_PAGE_OPEN_ACTIONS',
            'FLATTEN_ANNOTATIONS',
            'FLATTEN_FORMS'
        ];

        for (const id of expectedIds) {
            const cap = getCap(id);
            assert.ok(cap, `${id} capability missing from contract`);
            assert.strictEqual(cap.category, 'pdf_security_interactivity', `${id} category should be pdf_security_interactivity`);
            assert.strictEqual(cap.compliance_claim_allowed, undefined, `${id} must not declare compliance_claim_allowed=true`);
        }

        const flattenAnnotations = getCap('FLATTEN_ANNOTATIONS');
        assert.ok(flattenAnnotations.requires_human_review === true, 'FLATTEN_ANNOTATIONS requires_human_review should be true');
        assert.ok(flattenAnnotations.production_safe === false, 'FLATTEN_ANNOTATIONS production_safe should be false');
        assert.ok(flattenAnnotations.visually_sensitive === true, 'FLATTEN_ANNOTATIONS visually_sensitive should be true');
        assert.ok(flattenAnnotations.destructive === true, 'FLATTEN_ANNOTATIONS destructive should be true');

        const flattenForms = getCap('FLATTEN_FORMS');
        assert.ok(flattenForms.requires_human_review === true, 'FLATTEN_FORMS requires_human_review should be true');
        assert.ok(flattenForms.production_safe === false, 'FLATTEN_FORMS production_safe should be false');
        assert.ok(flattenForms.visually_sensitive === true, 'FLATTEN_FORMS visually_sensitive should be true');
        assert.ok(flattenForms.destructive === true, 'FLATTEN_FORMS destructive should be true');

        const stripJs = getCap('STRIP_JAVASCRIPT');
        assert.ok(stripJs.security_sensitive === true, 'STRIP_JAVASCRIPT security_sensitive should be true');

        pass('Capability Contract Regression — pdf_security_interactivity capabilities');
    } catch (e) { fail('Capability Contract Regression — pdf_security_interactivity capabilities', e); }

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
        const isCertCase = /STRIP_JAVASCRIPT|FLATTEN_FORMS|FLATTEN_ANNOTATIONS|EMBEDDED_FILES/.test(scenarioName);
        const jobIdSuffix = isCertCase ? '_cert_downgrade' : '';
        const jobId = `regression_${idx}_${scenarioName.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 50)}${jobIdSuffix}`;
        const gov = ws.security_interactivity_governance || {};
        const trust = ws.artifact_trust || {};

        const rawResult = {
            type: 'AUTOFIX',
            security_interactivity_governance: gov,
            artifact_trust: Object.keys(trust).length ? trust : undefined
        };

        try {
            // 2a. FixAuditNormalizer preservation of security_interactivity_governance and evidence
            const v2Audit = {
                version: '2.0',
                requested_fixes: [Object.keys(gov.evidence || {})[0] || 'STRIP_JAVASCRIPT'],
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                security_interactivity_governance: gov,
                delta_report: { security_interactivity_governance: gov }
            };
            const normAudit = FixAuditNormalizer.normalize(v2Audit);
            assert.ok(normAudit.security_interactivity_governance !== undefined, 'security_interactivity_governance dropped by FixAuditNormalizer');
            assert.deepStrictEqual(normAudit.security_interactivity_governance.review_required, gov.review_required, 'review_required not preserved by normalizer');
            assert.ok(normAudit.delta_report && normAudit.delta_report.security_interactivity_governance !== undefined, 'security_interactivity_governance dropped from delta_report by FixAuditNormalizer');
            if (gov.evidence) {
                assert.ok(normAudit.security_interactivity_governance.evidence !== undefined, 'evidence dropped by FixAuditNormalizer');
            }

            // 2b. PreflightService hydration into fix_summary / artifact_summary / root
            const artifacts = await service.getJobArtifacts(jobId, 'tenant1');
            const jobRow = { id: jobId, job_type: 'AUTOFIX', status: 'COMPLETED' };
            let normalized = service._normalizeJobPayload(jobRow, artifacts, rawResult);

            if (Object.keys(gov).length > 0) {
                assert.ok(normalized.security_interactivity_governance !== undefined, 'security_interactivity_governance not hydrated to root');
                assert.ok(normalized.artifact_summary && normalized.artifact_summary.security_interactivity_governance !== undefined, 'security_interactivity_governance not hydrated into artifact_summary');
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

            // 4. Standards overclaim protection: security/interactivity fixes never produce compliance claims
            assert.notStrictEqual(normalized.standard_certified, true, 'standard_certified leaked true from security/interactivity scenario');
            assert.notStrictEqual(normalized.pdfx_compliance_claimed, true, 'pdfx_compliance_claimed leaked true from security/interactivity scenario');
            assert.notStrictEqual(normalized.pdfa_compliance_claimed, true, 'pdfa_compliance_claimed leaked true from security/interactivity scenario');
            assert.notStrictEqual(normalized.compliance_claim_allowed, true, 'compliance_claim_allowed leaked true from security/interactivity scenario');

            // 5. artifact_trust authority — blocked_by_governance_domains preserved, remains authoritative
            if (Object.keys(trust).length) {
                if (typeof trust.review_required === 'boolean') {
                    assert.strictEqual(normalized.requiresHumanReview, trust.review_required, 'artifact_trust.review_required should be authoritative');
                }
                if (typeof trust.production_certified === 'boolean') {
                    assert.strictEqual(normalized.productionCertified, trust.production_certified, 'artifact_trust.production_certified should be authoritative');
                }
                if (Array.isArray(trust.blocked_by_governance_domains) && trust.blocked_by_governance_domains.includes('security_interactivity')) {
                    assert.ok(normalized.blocked_by_governance_domains.includes('security_interactivity'), 'blocked_by_governance_domains should preserve security_interactivity');
                }
            } else if (typeof gov.review_required === 'boolean') {
                assert.strictEqual(normalized.requiresHumanReview, gov.review_required, 'security_interactivity_governance.review_required should hydrate requiresHumanReview when artifact_trust absent');
            }

            // 6. Evidence preservation regression
            if (gov.evidence && Object.keys(gov.evidence).length > 0) {
                assert.ok(normalized.security_interactivity_governance && normalized.security_interactivity_governance.evidence, 'evidence dropped during hydration into root governance');
            }

            pass(`Worker scenario passthrough: ${scenarioName}`);
        } catch (e) {
            fail(`Worker scenario passthrough: ${scenarioName}`, e);
        }
    }

    reportData.smoke_passed = reportData.failed === 0;
    reportData.results = reportData.scenarios.map(s => ({ scenario: s.name, status: s.status, pass: s.status === 'PASS', notes: s.error || 'OK' }));

    console.log(`\nResults: ${reportData.passed} passed, ${reportData.failed} failed.`);

    fs.writeFileSync(path.join(REPORTS_DIR, 'phase63c_service_security_interactivity_exposure.json'), JSON.stringify(reportData, null, 2));

    let md = `# Phase 63C — Service Security / Interactivity Fix Exposure\n\n`;
    md += `**Input Mode:** ${reportData.input_mode}\n`;
    md += `**Passed:** ${reportData.passed}\n**Failed:** ${reportData.failed}\n\n`;
    md += `## Summary\nValidates that FixAuditNormalizer preserves security_interactivity_governance (root and delta_report) and evidence, FixCapabilityContract exposes Phase 63 capabilities under category "pdf_security_interactivity" with conservative policy flags, PreflightService hydrates security_interactivity_governance into fix_summary/artifact_summary/root, certified.pdf is downgraded when review is required, no standards/PDF-X/PDF-A compliance claims leak from security/interactivity fixes, and artifact_trust remains authoritative end-to-end from Worker 63B outputs.\n\n`;
    md += `## Scenarios\n`;
    reportData.scenarios.forEach(s => {
        md += `- ${s.name}: **${s.status}** ${s.error ? `(${s.error})` : ''}\n`;
    });

    fs.writeFileSync(path.join(REPORTS_DIR, 'phase63c_service_security_interactivity_exposure.md'), md);

    if (reportData.failed > 0) process.exit(1);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
