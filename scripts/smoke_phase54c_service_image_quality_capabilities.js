const fs = require('fs');
const path = require('path');
const FixCapabilityContract = require('../services/FixCapabilityContract');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');
const PreflightService = require('../services/PreflightService');

const MOCK_TENANT = 'tenant_image_qual_001';
const MOCK_JOB_ID = 'job_img_001';
const REPORT_JSON_PATH = path.join(__dirname, '../reports/phase54c_service_image_quality_capabilities.json');
const REPORT_MD_PATH = path.join(__dirname, '../reports/phase54c_service_image_quality_capabilities.md');

// Mock Dependencies
const mockEngine = { analyze: async () => ({}), autofix: async () => ({}) };
const mockWorker = { enqueue: async () => ({}) };
const mockStorage = {
    getJobSubfolder: (tenantId, jobId, folder) => {
        const p = path.join(__dirname, '../.tmp_storage', tenantId, jobId, folder);
        fs.mkdirSync(p, { recursive: true });
        return p;
    },
    getBaseDir: () => path.join(__dirname, '../.tmp_storage'),
    initializeJobStorage: async () => {},
    saveInputFile: async () => ({ filePath: 'dummy.pdf' }),
    deleteJobStorage: async () => {}
};

// Mock DB
const db = require('../src/services/db');
db.query = async (sql, params) => {
    if (sql.includes('SELECT * FROM jobs')) {
        return [[{ id: MOCK_JOB_ID, tenant_id: MOCK_TENANT, status: 'COMPLETED', job_type: 'AUTOFIX', result: '{}' }]];
    }
    return [[]];
};
db.execute = async () => {};

async function runTest() {
    console.log("Starting Phase 54C Service Image Quality Capabilities Smoke Test...");
    let report = {
        scenarios: [],
        summary: {
            total: 0,
            passed: 0,
            failed: 0
        }
    };

    function assertCondition(condition, message) {
        report.summary.total++;
        if (!condition) {
            report.summary.failed++;
            throw new Error(message);
        }
        report.summary.passed++;
    }

    try {
        // Scenario 1: Capability contract matrix
        console.log("Scenario 1: Capability contract matrix");
        const contract = FixCapabilityContract.getCapabilities();
        const requiredCaps = [
            'UPSCALE_LOW_RES_IMAGES',
            'DOWNSAMPLE_EXCESSIVE_RESOLUTION',
            'RECOMPRESS_IMAGES',
            'REPLACE_LOW_RES_IMAGES',
            'REPAIR_JPEG_ARTIFACTS',
            'NORMALIZE_IMAGE_COLORSPACE',
            'REMOVE_IMAGE_ALPHA',
            'REPAIR_DAMAGED_IMAGE_OBJECT',
            'VECTORIZE_BITMAP_TEXT',
            'RESTORE_RASTERIZED_VECTOR'
        ];

        requiredCaps.forEach(fixId => {
            const cap = contract.capabilities.find(c => c.fix_id === fixId);
            assertCondition(cap, `Capability ${fixId} is missing`);
            assertCondition(cap.implemented === false, `${fixId} must not be fully implemented`);
            assertCondition(cap.autofixable === false, `${fixId} must not be autofixable`);
            assertCondition(cap.production_safe === false, `${fixId} must not be production safe`);
            assertCondition(cap.requires_human_review === true, `${fixId} must require review`);
            assertCondition(cap.visually_sensitive === true, `${fixId} must be visually sensitive`);
            assertCondition(cap.destructive === true, `${fixId} must be destructive`);
            assertCondition(cap.supported_modes.includes("EXPERIMENTAL"), `${fixId} must support EXPERIMENTAL mode`);
        });

        report.scenarios.push({
            name: "Capability contract matrix",
            status: "PASS"
        });

        // Scenario 2: Normalize LOW_RES_IMAGES
        console.log("Scenario 2: Normalize LOW_RES_IMAGES");
        const audit2 = {
            version: "2.0",
            image_quality_governance: {
                review_required: true,
                production_certified: false,
                certified_pdf_allowed: false,
                low_res_images_present: true,
                review_required_reasons: ["Low resolution images present"]
            },
            low_res_images_present: true
        };
        const norm2 = FixAuditNormalizer.normalize(audit2);
        assertCondition(norm2.image_quality_governance.review_required === true, "Review must be required");
        assertCondition(norm2.image_quality_governance.certified_pdf_allowed === false, "Certified PDF not allowed");
        assertCondition(norm2.low_res_images_present === true, "low_res_images_present preserved");
        report.scenarios.push({ name: "Normalize LOW_RES_IMAGES", status: "PASS" });

        // Scenario 3: Normalize JPEG_ARTIFACTS
        console.log("Scenario 3: Normalize JPEG_ARTIFACTS");
        const audit3 = {
            version: "2.0",
            image_quality_governance: {
                review_required: true,
                production_certified: false,
                jpeg_artifacts_present: true
            },
            jpeg_artifacts_present: true
        };
        const norm3 = FixAuditNormalizer.normalize(audit3);
        assertCondition(norm3.image_quality_governance.jpeg_artifacts_present === true, "jpeg_artifacts_present preserved");
        report.scenarios.push({ name: "Normalize JPEG_ARTIFACTS", status: "PASS" });

        // Scenario 4: Normalize BITMAP_TEXT_RISK
        console.log("Scenario 4: Normalize BITMAP_TEXT_RISK");
        const audit4 = {
            version: "2.0",
            image_quality_governance: {
                review_required: true,
                production_certified: false,
                bitmap_text_risk: true
            },
            bitmap_text_risk: true
        };
        const norm4 = FixAuditNormalizer.normalize(audit4);
        assertCondition(norm4.image_quality_governance.bitmap_text_risk === true, "bitmap_text_risk preserved");
        report.scenarios.push({ name: "Normalize BITMAP_TEXT_RISK", status: "PASS" });

        // Scenario 5: Normalize unsupported UPSCALE_LOW_RES_IMAGES
        console.log("Scenario 5: Normalize unsupported UPSCALE_LOW_RES_IMAGES");
        const audit5 = {
            version: "2.0",
            applied_fixes: [],
            skipped_fixes: [{
                code: "UPSCALE_LOW_RES_IMAGES",
                status: "SKIPPED",
                reason: "Unsupported fix",
                requires_human_review: true,
                production_safe: false
            }]
        };
        const norm5 = FixAuditNormalizer.normalize(audit5);
        assertCondition(norm5.skipped_fixes.length === 1, "Must have 1 skipped fix");
        assertCondition(norm5.skipped_fixes[0].code === "UPSCALE_LOW_RES_IMAGES", "Fix code must be preserved");
        assertCondition(norm5.skipped_fixes[0].requires_human_review === true, "Requires human review preserved");
        report.scenarios.push({ name: "Normalize unsupported UPSCALE_LOW_RES_IMAGES", status: "PASS" });

        // Scenario 6: Normalize unsupported REPLACE_LOW_RES_IMAGES
        console.log("Scenario 6: Normalize unsupported REPLACE_LOW_RES_IMAGES");
        const audit6 = {
            version: "2.0",
            skipped_fixes: [{
                code: "REPLACE_LOW_RES_IMAGES",
                status: "SKIPPED",
                reason: "Unsupported fix"
            }]
        };
        const norm6 = FixAuditNormalizer.normalize(audit6);
        assertCondition(norm6.skipped_fixes[0].code === "REPLACE_LOW_RES_IMAGES", "Must be REPLACE_LOW_RES_IMAGES");
        report.scenarios.push({ name: "Normalize unsupported REPLACE_LOW_RES_IMAGES", status: "PASS" });

        // Scenario 7: Future applied visual image rewrite
        console.log("Scenario 7: Future applied visual image rewrite");
        const audit7 = {
            version: "2.0",
            visual_image_rewrite_applied: true,
            image_quality_governance: {
                visual_image_rewrite_applied: true,
                review_required: true,
                production_certified: false
            }
        };
        const norm7 = FixAuditNormalizer.normalize(audit7);
        assertCondition(norm7.visual_image_rewrite_applied === true, "visual_image_rewrite_applied preserved");
        report.scenarios.push({ name: "Future applied visual image rewrite", status: "PASS" });

        // Scenario 8: Certified PDF downgrade
        console.log("Scenario 8: Certified PDF downgrade");
        const service = new PreflightService(mockEngine, mockWorker, mockStorage);
        
        const outDir = mockStorage.getJobSubfolder(MOCK_TENANT, MOCK_JOB_ID, 'output');
        fs.writeFileSync(path.join(outDir, 'certified.pdf'), 'dummy');
        fs.writeFileSync(path.join(outDir, 'report.json'), '{}');
        fs.writeFileSync(path.join(outDir, 'fix_audit.json'), JSON.stringify({
            version: "2.0",
            image_quality_governance: {
                certified_pdf_allowed: false,
                review_required: true,
                production_certified: false,
                review_required_reasons: ["Low res images"]
            },
            low_res_images_present: true
        }));

        const artifacts = await service.getJobArtifacts(MOCK_JOB_ID, MOCK_TENANT);
        const certPdf = artifacts.artifacts.find(a => a.type === 'certified_pdf');
        
        assertCondition(certPdf.artifact_role === 'REVIEW_REQUIRED', "Role must be REVIEW_REQUIRED");
        assertCondition(certPdf.customer_visible === false, "Must not be customer visible");
        assertCondition(certPdf.production_certified === false, "Must not be production certified");
        assertCondition(artifacts.artifact_summary.production_ready_artifact_available === false, "No production ready artifact");
        assertCondition(artifacts.artifact_summary.review_required_artifact_available === true, "Review required artifact available");
        
        report.scenarios.push({ name: "Certified PDF downgrade", status: "PASS" });

    } catch (err) {
        console.error("Test failed:", err);
        report.scenarios.push({ name: "TEST_FAILED", status: "FAIL", error: err.message });
        report.summary.failed++;
    }

    fs.mkdirSync(path.dirname(REPORT_JSON_PATH), { recursive: true });
    fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2));

    let md = `# Phase 54C: Service Image Quality Capabilities Report\n\n`;
    md += `Total Scenarios: ${report.summary.total}\nPassed: ${report.summary.passed}\nFailed: ${report.summary.failed}\n\n`;
    report.scenarios.forEach(s => {
        md += `- **${s.name}**: ${s.status}${s.error ? ` (${s.error})` : ''}\n`;
    });
    fs.writeFileSync(REPORT_MD_PATH, md);

    console.log("Done.");
}

runTest();
