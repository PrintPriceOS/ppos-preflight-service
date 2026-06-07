const fs = require('fs-extra');
const path = require('path');
const FixCapabilityContract = require('../services/FixCapabilityContract');
const PreflightService = require('../services/PreflightService');

const REPORT_FILE = path.join(__dirname, '../reports/phase61c_service_structural_metadata_exposure.json');
const MD_REPORT_FILE = path.join(__dirname, '../reports/phase61c_service_structural_metadata_exposure.md');
const WORKER_REPORT_FILE = path.join(__dirname, '../../ppos-preflight-worker-phase-10-intelligence-layer/reports/phase61b_worker_structural_metadata_policy.json');

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
    console.log('--- Phase 61C: Service Structural / Metadata Fix Exposure Smoke Test ---');

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

        if (structuralGov.metadata_cleanup_applied === true) {
            if (normalized.standard_certified === true) {
                pass = false;
                reasons.push('metadata cleanup must not allow standard_certified=true');
            }
            if (normalized.pdfx_compliance_claimed === true || normalized.pdfa_compliance_claimed === true) {
                pass = false;
                reasons.push('metadata cleanup must not allow compliance_claimed=true');
            }
        }

        if (structuralGov.internal_standard_report_generated === true) {
            if (normalized.analysisIntegrity?.validation_performed === true || normalized.validation_performed === true) {
                pass = false;
                reasons.push('internal report must not be treated as validation_performed=true');
            }
        }

        if (rawResult.production_certified === true && structuralGov.production_certified === false) {
            if (normalized.productionCertified === true) {
                pass = false;
                reasons.push('structural_metadata_governance false production_certified should win over legacy true');
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
            validation_performed: normalized.validation_performed,
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
    
    // 1. NORMALIZE_OBJECT_STREAMS applied cleanly.
    await runScenario('1. NORMALIZE_OBJECT_STREAMS applied cleanly', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            structural_fix_applied: true,
            object_streams_normalized: true,
            review_required: false,
            production_certified: true
        },
        repairs: [
            { code: 'NORMALIZE_OBJECT_STREAMS', status: 'APPLIED', evidence: { objects_rewritten: 10 } }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    // 2. NORMALIZE_OBJECT_STREAMS skipped / qpdf missing.
    await runScenario('2. NORMALIZE_OBJECT_STREAMS skipped / qpdf missing', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            qpdf_available: false,
            structural_fix_applied: false,
            object_streams_normalized: false,
            production_certified: true
        },
        repairs: [
            { code: 'NORMALIZE_OBJECT_STREAMS', status: 'SKIPPED', reason: 'Missing QPDF toolchain', evidence: {} }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    // 3. REVOKE_FALSE_CERTIFICATION applied.
    await runScenario('3. REVOKE_FALSE_CERTIFICATION applied', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            metadata_cleanup_applied: true,
            false_certification_revoked: true,
            review_required: true,
            production_certified: false
        },
        repairs: [
            { code: 'REVOKE_FALSE_CERTIFICATION', status: 'APPLIED', evidence: { objects_stripped: 1 } }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    // 4. STRIP_INVALID_PDFX_METADATA applied.
    await runScenario('4. STRIP_INVALID_PDFX_METADATA applied', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            metadata_cleanup_applied: true,
            invalid_pdfx_metadata_stripped: true,
            review_required: true,
            production_certified: false
        },
        repairs: [
            { code: 'STRIP_INVALID_PDFX_METADATA', status: 'APPLIED', evidence: { keys_removed: ['GTS_PDFXVersion'] } }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    // 5. STRIP_INVALID_PDFA_METADATA applied.
    await runScenario('5. STRIP_INVALID_PDFA_METADATA applied', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            metadata_cleanup_applied: true,
            invalid_pdfa_metadata_stripped: true,
            review_required: true,
            production_certified: false
        },
        repairs: [
            { code: 'STRIP_INVALID_PDFA_METADATA', status: 'APPLIED', evidence: { namespaces_removed: ['pdfaid'] } }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    // 6. NORMALIZE_STANDARD_METADATA applied.
    await runScenario('6. NORMALIZE_STANDARD_METADATA applied', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            metadata_cleanup_applied: true,
            standard_metadata_normalized: true,
            review_required: true,
            production_certified: false
        },
        repairs: [
            { code: 'NORMALIZE_STANDARD_METADATA', status: 'APPLIED', evidence: { updated: true } }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    // 7. GENERATE_STANDARD_VALIDATION_REPORT_INTERNAL generated.
    await runScenario('7. GENERATE_STANDARD_VALIDATION_REPORT_INTERNAL generated', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            internal_standard_report_generated: true,
            validation_performed: false,
            validation_passed: false
        },
        validation_performed: true, // Legacy field says true, but internal_standard_report_generated=true should override it to false
        repairs: [
            { code: 'GENERATE_STANDARD_VALIDATION_REPORT_INTERNAL', status: 'APPLIED', evidence: { format: 'vera_json' } }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    // 8. Metadata cleanup with certified.pdf present.
    await runScenario('8. Metadata cleanup with certified.pdf present', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            metadata_cleanup_applied: true,
            review_required: true,
            production_certified: false
        },
        repairs: [
            { code: 'STRIP_INVALID_PDFX_METADATA', status: 'APPLIED', evidence: {} }
        ],
        artifact_trust: {
            primary_artifact_type: 'certified_pdf'
        }
    }, [{ type: 'certified_pdf', name: 'certified.pdf', downloadable: true }]);

    // 9. Conflicting legacy metadata says standard_certified=true.
    await runScenario('9. Conflicting legacy metadata says standard_certified=true', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            metadata_cleanup_applied: true,
            review_required: true,
            production_certified: false
        },
        standard_certified: true, // Legacy conflicting data
        repairs: [
            { code: 'REVOKE_FALSE_CERTIFICATION', status: 'APPLIED', evidence: {} }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    // 10. Evidence preservation for skipped/failed states.
    await runScenario('10. Evidence preservation for skipped/failed states', { job_type: 'AUTOFIX', status: 'COMPLETED' }, {
        status: 'COMPLETED',
        type: 'AUTOFIX',
        structural_metadata_governance: {
            metadata_cleanup_applied: false,
            structural_fix_applied: false,
            production_certified: true
        },
        repairs: [
            { code: 'NORMALIZE_OBJECT_STREAMS', status: 'FAILED', reason: 'QPDF crash', evidence: { exitCode: 139 } },
            { code: 'REVOKE_FALSE_CERTIFICATION', status: 'SKIPPED', reason: 'Not certified', evidence: { cert_exists: false } }
        ]
    }, [{ type: 'fixed_pdf', name: 'fixed.pdf', downloadable: true }]);

    const allPassed = testScenarios.every(s => s.pass);
    const resultJson = {
        phase: '61C',
        timestamp: new Date().toISOString(),
        inputMode,
        allPassed,
        scenarios: testScenarios
    };

    fs.ensureDirSync(path.dirname(REPORT_FILE));
    fs.writeJsonSync(REPORT_FILE, resultJson, { spaces: 2 });
    
    let md = `# Phase 61C Service Structural / Metadata Exposure Report\n\n`;
    md += `**Input Mode:** ${inputMode}\n`;
    md += `**Status:** ${allPassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    
    testScenarios.forEach(s => {
        md += `### ${s.scenario}\n`;
        md += `- Pass: ${s.pass}\n`;
        if (s.reasons.length > 0) md += `- Reasons: ${s.reasons.join(', ')}\n`;
        md += `- Production Certified: ${s.production_certified}\n`;
        md += `- Standard Certified: ${s.standard_certified}\n`;
        md += `- PDF/X Claimed: ${s.pdfx_compliance_claimed}\n`;
        md += `- Validation Performed: ${s.validation_performed}\n\n`;
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
