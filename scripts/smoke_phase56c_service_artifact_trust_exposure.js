const PreflightService = require('../services/PreflightService');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');
const HashUtility = require('../src/utils/hashUtility');
const db = require('../src/services/db');
const fs = require('fs-extra');
const path = require('path');

const reportsDir = path.join(__dirname, '../reports');
fs.ensureDirSync(reportsDir);

async function runTests() {
    console.log("=== Phase 56C Service Artifact Trust Exposure Smoke Test ===");
    
    // Global mocks for dependencies to avoid network/fs errors
    HashUtility.computeFileHash = async () => 'mockhash';
    db.query = async () => [[]];
    db.execute = async () => [[]];

    const service = new PreflightService();
    const normalizer = new FixAuditNormalizer();
    
    const results = [];
    let passed = 0;
    let failed = 0;

    const assertCondition = (name, condition, message, actual = undefined) => {
        if (condition) {
            results.push(`✅ [PASS] ${name}`);
            passed++;
        } else {
            const extra = actual !== undefined ? ` (Actual: ${actual})` : '';
            results.push(`❌ [FAIL] ${name} - ${message}${extra}`);
            failed++;
        }
    };

    const testCases = [
        {
            name: "1. Baseline (No artifact_trust)",
            res: {
                version: "2.0",
                artifacts_metadata: {
                    'certified.pdf': { checksum_sha256: 'xyz', size_bytes: 1000 }
                },
                production_certified: true,
                standard_certified: true,
                standards_certification_governance: {
                    standard_certified: true,
                    validation_performed: true,
                    validation_passed: true,
                    validator_name: "MockValidator",
                    validator_version: "1.0",
                    standard_detected: "PDF/X-4",
                    validation_report_available: true,
                    compliance_claim_allowed: true
                }
            },
            files: ['certified.pdf'],
            validate: (result) => {
                console.log(`DEBUG: normalized artifacts test 1 =`, JSON.stringify(result, null, 2));
                const certPdf = result.artifacts.find(a => a.name === 'certified.pdf');
                assertCondition("Baseline: certified.pdf is primary", certPdf && certPdf.is_primary === true, "Must be true", certPdf ? certPdf.is_primary : 'undefined');
                assertCondition("Baseline: production_certified is true", result.production_certified === true, "Must be true", result.production_certified);
                assertCondition("Baseline: standard_certified is true", result.standard_certified === true, "Must be true", result.standard_certified);
            }
        },
        {
            name: "2. artifact_trust production_certified=false overrides metadata",
            res: {
                version: "2.0",
                production_certified: true,
                artifact_trust: {
                    production_certified: false
                }
            },
            files: ['certified.pdf'],
            validate: (result) => {
                assertCondition("Override: production_certified is false", result.production_certified === false, "Must be false", result.production_certified);
            }
        },
        {
            name: "3. artifact_trust standard_certified=false overrides metadata",
            res: {
                version: "2.0",
                standard_certified: true,
                standards_certification_governance: { standard_certified: true },
                artifact_trust: {
                    standard_certified: false
                }
            },
            files: ['certified.pdf'],
            validate: (result) => {
                assertCondition("Override: standard_certified is false", result.standard_certified === false, "Must be false", result.standard_certified);
            }
        },
        {
            name: "4. artifact_trust customer_visible=false overrides metadata",
            res: {
                version: "2.0",
                production_certified: true,
                artifact_trust: {
                    production_certified: true,
                    customer_visible: false
                }
            },
            files: ['certified.pdf'],
            validate: (result) => {
                const certPdf = result.artifacts.find(a => a.type === 'certified_pdf');
                assertCondition("Override: certified.pdf customer_visible is false", certPdf && certPdf.customer_visible === false, "Must be false", certPdf ? certPdf.customer_visible : 'undefined');
                assertCondition("Root: customer_visible is false", result.customer_visible === false, "Must be false", result.customer_visible);
            }
        },
        {
            name: "5. artifact_trust primary_artifact_type=review_pdf wins",
            res: {
                version: "2.0",
                production_certified: true,
                artifact_trust: {
                    primary_artifact_type: 'review_pdf',
                    review_required: true
                }
            },
            files: ['certified.pdf', 'review.pdf', 'fixed.pdf'],
            validate: (result) => {
                const reviewPdf = result.artifacts.find(a => a.type === 'review_pdf');
                const certPdf = result.artifacts.find(a => a.type === 'certified_pdf');
                assertCondition("Primary: review_pdf is primary", reviewPdf && reviewPdf.is_primary === true, "review_pdf must be primary");
                assertCondition("Primary: certified_pdf is not primary", certPdf && certPdf.is_primary === false, "certified_pdf must not be primary");
            }
        },
        {
            name: "6. Valid Standard Evidence is Preserved",
            res: {
                version: "2.0",
                artifact_trust: {
                    standard_certified: true,
                    evidence: {
                        validation_performed: true,
                        validation_passed: true,
                        validator_name: 'veraPDF',
                        validator_version: '1.24',
                        standard_detected: 'PDF/X-4',
                        validation_report_available: true,
                        compliance_claim_allowed: true
                    }
                }
            },
            files: ['certified.pdf'],
            validate: (result) => {
                assertCondition("Standard: standard_certified is true", result.standard_certified === true, "Must be true");
                assertCondition("Standard: no standard warning", !result.warnings || !result.warnings.includes('STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE'), "Must not have warning");
            }
        },
        {
            name: "7. standard_certified downgrade without evidence",
            res: {
                version: "2.0",
                standards_certification_governance: {
                    standard_certified: true,
                    validation_performed: false
                }
            },
            files: ['certified.pdf'],
            validate: (result) => {
                console.log(`DEBUG Test 7 warnings:`, result.result?.warnings);
                assertCondition("Standard Downgrade: standard_certified is false", result.standard_certified === false, "Must be false due to missing evidence");
                const hasWarning = (result.result?.warnings || []).some(w => w.toLowerCase().includes('downgraded') || w.toLowerCase().includes('evidence'));
                assertCondition("Standard Downgrade: warning added", hasWarning, "Must have warning");
            }
        },
        {
            name: "8. FixAuditNormalizer preserves artifact_trust (v2)",
            isNormalizerTest: true,
            auditData: {
                version: "2.0",
                artifact_trust: { production_certified: false },
                delta_report: {
                    artifact_trust: { production_certified: false }
                }
            },
            validate: (result) => {
                assertCondition("Normalizer: Root artifact_trust preserved", !!result.artifact_trust, "Must be preserved");
                assertCondition("Normalizer: Delta report artifact_trust preserved", !!(result.delta_report && result.delta_report.artifact_trust), "Must be preserved");
            }
        },
        {
            name: "9. certified_pdf_allowed=false downgrades certified.pdf",
            res: {
                version: "2.0",
                production_certified: true,
                artifact_trust: {
                    certified_pdf_allowed: false
                }
            },
            files: ['certified.pdf'],
            validate: (result) => {
                console.log(`DEBUG: normalized artifacts test 9 =`, result.artifacts);
                const certPdf = Array.isArray(result.artifacts) ? result.artifacts.find(a => a.type === 'certified_pdf') : null;
                assertCondition("Certified PDF Downgrade: customer_visible=false", certPdf && certPdf.customer_visible === false, "Must be false");
                assertCondition("Certified PDF Downgrade: production_certified=false", certPdf && certPdf.production_certified === false, "Must be false");
                assertCondition("Certified PDF Downgrade: artifact_role=REVIEW_REQUIRED", certPdf && certPdf.artifact_role === 'REVIEW_REQUIRED', "Must be REVIEW_REQUIRED");
                assertCondition("Root Downgrade: production_ready_artifact_available=false", result.result && result.result.artifact_summary ? result.result.artifact_summary.production_ready_artifact_available === false : result.artifact_summary && result.artifact_summary.production_ready_artifact_available === false, "Must be false");
            }
        },
        {
            name: "10. primary_artifact_type=fixed_pdf wins",
            res: {
                version: "2.0",
                artifact_trust: {
                    primary_artifact_type: 'fixed_pdf',
                    production_certified: true
                }
            },
            files: ['fixed.pdf', 'certified.pdf'],
            validate: (result) => {
                const fixedPdf = result.artifacts.find(a => a.type === 'fixed_pdf');
                const certPdf = result.artifacts.find(a => a.type === 'certified_pdf');
                assertCondition("Primary: fixed_pdf is primary", fixedPdf && fixedPdf.is_primary === true, "fixed_pdf must be primary");
                assertCondition("Primary: certified_pdf is not primary", certPdf && certPdf.is_primary === false, "certified_pdf must not be primary");
            }
        }
    ];

    for (const test of testCases) {
        if (test.isNormalizerTest) {
            const res = FixAuditNormalizer.normalize(test.auditData, { formatVersion: '2.0' });
            test.validate(res);
        } else {
            const tmpDir = path.join(__dirname, `../.tmp_smoke_${Date.now()}`);
            await fs.ensureDir(tmpDir);
            for (const f of test.files) {
                await fs.writeFile(path.join(tmpDir, f), 'mock content');
            }
            // Mock fix_audit.json so getJobArtifacts can read the res object from the file system
            await fs.writeJson(path.join(tmpDir, 'fix_audit.json'), test.res);

            try {
                // Mock the directory directly on the service instance
                service._resolvePhysicalOutputDir = async () => tmpDir;

                // Get artifacts
                const artifactsObj = await service.getJobArtifacts('job-123', 'tenant-456');
                console.log(`DEBUG [${test.name}]: artifactsObj =`, JSON.stringify(artifactsObj, null, 2));
                const artifacts = artifactsObj.artifacts || artifactsObj;

                // 3. Normalize
                const jobMock = { id: 'job-123', status: 'COMPLETED' };
                const normalized = service._normalizeJobPayload(jobMock, artifacts, test.res, []);
                test.validate(normalized);
            } finally {
                await fs.remove(tmpDir);
            }
        }
    }

    console.log("\n=== Results ===");
    console.log(results.join('\n'));
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    const reportJsonPath = path.join(reportsDir, 'phase56c_service_artifact_trust_exposure.json');
    const reportMdPath = path.join(reportsDir, 'phase56c_service_artifact_trust_exposure.md');

    await fs.writeJson(reportJsonPath, { passed, failed, results }, { spaces: 2 });
    
    let md = `# Phase 56C Service Artifact Trust Exposure\n\n`;
    md += `**Passed:** ${passed}\n**Failed:** ${failed}\n\n## Details\n\n`;
    results.forEach(r => md += `- ${r}\n`);
    await fs.writeFile(reportMdPath, md);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
