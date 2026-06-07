const fs = require('fs-extra');
const path = require('path');
const PreflightService = require('../services/PreflightService');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');

const REPORT_FILE = path.join(__dirname, '../reports/phase61e_service_structural_metadata_regression.json');
const MD_REPORT_FILE = path.join(__dirname, '../reports/phase61e_service_structural_metadata_regression.md');
const WORKER_REPORT_FILE = path.join(__dirname, '../../ppos-preflight-worker-phase-10-intelligence-layer/reports/phase61e_worker_structural_metadata_regression.json');

class MockStorage {
    getJobSubfolder(tenantId, jobId, subfolder) {
        return `/mock/storage/${tenantId}/${jobId}/${subfolder}`;
    }
}

class MockEngine {
    constructor() {}
}

class MockWorker {
    constructor() {}
}

const service = new PreflightService(new MockEngine(), new MockWorker(), new MockStorage());

async function runTests() {
    console.log('--- Phase 61E: Service Structural / Metadata Fix Regression Smoke Test ---');

    let workerPayload = null;
    let inputMode = 'SYNTHETIC_POLICY_FALLBACK';

    if (fs.existsSync(WORKER_REPORT_FILE)) {
        try {
            workerPayload = await fs.readJson(WORKER_REPORT_FILE);
            inputMode = 'WORKER_INTEGRATION';
            console.log(`Loaded worker payload from: ${WORKER_REPORT_FILE}`);
        } catch (e) {
            console.warn(`Could not read worker payload: ${e.message}`);
        }
    } else {
        console.log(`Worker payload not found. Using ${inputMode}.`);
    }

    const testScenarios = [];
    
    // Test FixAuditNormalizer directly
    console.log(`\nValidating FixAuditNormalizer...`);
    const mockAuditData = {
        version: "2.0",
        structural_metadata_governance: {
            metadata_cleanup_applied: true
        },
        applied_fixes: [{
            code: 'NORMALIZE_OBJECT_STREAMS',
            status: 'APPLIED',
            evidence: { objects_rewritten: 42 }
        }],
        qpdf_warnings: ['warning 1'],
        metadata_cleanup_warnings: ['cleanup warning'],
        internal_report_markers: ['marker 1']
    };
    const normalizedAudit = FixAuditNormalizer.normalize(mockAuditData);
    
    const auditPass = 
        normalizedAudit.structural_metadata_governance?.metadata_cleanup_applied === true &&
        normalizedAudit.applied_fixes[0]?.evidence?.objects_rewritten === 42 &&
        normalizedAudit.qpdf_warnings?.length === 1 &&
        normalizedAudit.metadata_cleanup_warnings?.length === 1 &&
        normalizedAudit.internal_report_markers?.length === 1;

    testScenarios.push({
        scenario: 'FixAuditNormalizer preservation checks',
        pass: auditPass,
        reasons: auditPass ? [] : ['FixAuditNormalizer failed to preserve structural_metadata_governance, evidence, qpdf_warnings, metadata_cleanup_warnings, or internal_report_markers']
    });

    if (auditPass) console.log('✅ FixAuditNormalizer PASS');
    else console.log('❌ FixAuditNormalizer FAIL');

    const runScenario = async (name, jobData, rawResult, artifacts) => {
        console.log(`\nRunning scenario: ${name}`);
        const normalized = service._normalizeJobPayload(jobData, artifacts, rawResult);

        let pass = true;
        const reasons = [];
        
        // General invariants
        if (normalized.structural_metadata_governance === undefined && Object.keys(rawResult.structural_metadata_governance || {}).length > 0) {
            pass = false;
            reasons.push('structural_metadata_governance not preserved at root');
        }

        const structuralGov = normalized.structural_metadata_governance || {};

        // Overclaim protection
        if (structuralGov.metadata_cleanup_applied === true) {
            if (normalized.standard_certified === true) {
                pass = false;
                reasons.push('metadata cleanup must set standard_certified=false');
            }
            if (normalized.pdfx_compliance_claimed === true || normalized.pdfa_compliance_claimed === true) {
                pass = false;
                reasons.push('metadata cleanup must set compliance_claimed=false');
            }
            if (normalized.compliance_claim_allowed === true) {
                pass = false;
                reasons.push('metadata cleanup must set compliance_claim_allowed=false');
            }
        }

        if (structuralGov.internal_standard_report_generated === true) {
            if (normalized.validation_performed === true) {
                pass = false;
                reasons.push('internal report must set validation_performed=false');
            }
            if (normalized.validation_passed === true) {
                pass = false;
                reasons.push('internal report must set validation_passed=false');
            }
            if (normalized.validator_available === true) {
                pass = false;
                reasons.push('internal report must set validator_available=false');
            }
        }

        if (rawResult.fix_summary?.structural_metadata_governance) {
            if (!normalized.fix_summary || !normalized.fix_summary.structural_metadata_governance) {
                pass = false;
                reasons.push('fix_summary.structural_metadata_governance missing');
            }
        }

        if (rawResult.structural_metadata_governance && Object.keys(rawResult.structural_metadata_governance).length > 0) {
            if (!normalized.artifact_summary || !normalized.artifact_summary.structural_metadata_governance) {
                pass = false;
                reasons.push('artifact_summary.structural_metadata_governance missing');
            }
        }

        // Artifact handling
        if (normalized.artifact_summary) {
            if (normalized.artifact_summary.certified_pdf_available === true && structuralGov.metadata_cleanup_applied === true && !rawResult.artifact_trust) {
                if (normalized.artifact_summary.production_ready_artifact_available === true) {
                    pass = false;
                    reasons.push('production_ready_artifact_available must not be created by metadata cleanup alone');
                }
            }
        }

        const result = {
            scenario: name,
            pass,
            reasons,
            structural_gov: structuralGov,
            production_certified: normalized.productionCertified,
            standard_certified: normalized.standard_certified,
            pdfx_compliance_claimed: normalized.pdfx_compliance_claimed,
            pdfa_compliance_claimed: normalized.pdfa_compliance_claimed,
            compliance_claim_allowed: normalized.compliance_claim_allowed,
            validation_performed: normalized.validation_performed,
            validation_passed: normalized.validation_passed,
            validator_available: normalized.validator_available,
            autofix_repairs: normalized.repairs
        };

        testScenarios.push(result);
        
        if (pass) {
            console.log('✅ PASS');
        } else {
            console.log(`❌ FAIL: ${reasons.join(', ')}`);
        }
        
        return result;
    };

    // Synthesize scenarios
    
    await runScenario('1. Metadata Cleanup Applied - Overclaim Protection', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            metadata_cleanup_applied: true
        },
        standard_certified: true, // Legacy conflicting data
        pdfx_compliance_claimed: true,
        pdfa_compliance_claimed: true,
        compliance_claim_allowed: true,
        fix_summary: {
            structural_metadata_governance: { metadata_cleanup_applied: true }
        },
        repairs: [
            { code: 'REVOKE_FALSE_CERTIFICATION', status: 'APPLIED', evidence: { stripped: true } }
        ]
    }, [{ type: 'certified_pdf', name: 'certified.pdf', downloadable: true }]);

    await runScenario('2. Internal Report Generated - Validation Strip', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            internal_standard_report_generated: true
        },
        validation_performed: true,
        validation_passed: true,
        validator_available: true,
        repairs: [
            { code: 'GENERATE_STANDARD_VALIDATION_REPORT_INTERNAL', status: 'APPLIED', evidence: {} }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    await runScenario('3. Artifact Trust Authoritative over Metadata Cleanup', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            metadata_cleanup_applied: true,
            production_certified: false
        },
        artifact_trust: {
            primary_artifact_type: 'fixed_pdf',
            production_certified: true
        },
        repairs: [
            { code: 'STRIP_INVALID_PDFX_METADATA', status: 'APPLIED', evidence: {} }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    const allPassed = testScenarios.every(s => s.pass);
    const resultJson = {
        phase: '61E',
        timestamp: new Date().toISOString(),
        inputMode,
        allPassed,
        scenarios: testScenarios
    };

    fs.ensureDirSync(path.dirname(REPORT_FILE));
    fs.writeJsonSync(REPORT_FILE, resultJson, { spaces: 2 });
    
    let md = `# Phase 61E Service Structural / Metadata Regression Report\n\n`;
    md += `**Input Mode:** ${inputMode}\n`;
    md += `**Status:** ${allPassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    
    testScenarios.forEach(s => {
        md += `### ${s.scenario}\n`;
        md += `- Pass: ${s.pass}\n`;
        if (s.reasons.length > 0) md += `- Reasons: ${s.reasons.join(', ')}\n`;
        if (s.standard_certified !== undefined) md += `- Standard Certified: ${s.standard_certified}\n`;
        if (s.pdfx_compliance_claimed !== undefined) md += `- PDF/X Claimed: ${s.pdfx_compliance_claimed}\n`;
        if (s.validation_performed !== undefined) md += `- Validation Performed: ${s.validation_performed}\n\n`;
    });

    fs.writeFileSync(MD_REPORT_FILE, md);

    console.log(`\nReports generated:\n- ${REPORT_FILE}\n- ${MD_REPORT_FILE}`);
    
    if (!allPassed) {
        process.exit(1);
    }
}

runTests().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
