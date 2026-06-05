const FixCapabilityContract = require('../services/FixCapabilityContract');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');
const PreflightService = require('../services/PreflightService');
const fs = require('fs');
const path = require('path');

async function run() {
    console.log("Starting Phase 53C Service Transparency / Overprint Capability Exposure Smoke Test...\n");
    let passed = 0;
    let failed = 0;

    const assert = (condition, message) => {
        if (condition) {
            console.log(`✅ PASS: ${message}`);
            passed++;
        } else {
            console.error(`❌ FAIL: ${message}`);
            failed++;
        }
    };

    // A. Capability Contract
    console.log("--- A. Capability Contract ---");
    const caps = FixCapabilityContract.getCapabilities().capabilities;
    const getCap = (id) => caps.find(c => c.fix_id === id);

    const flattenTrans = getCap('FLATTEN_TRANSPARENCY');
    assert(flattenTrans && flattenTrans.production_safe === false, "FLATTEN_TRANSPARENCY is not production_safe");
    assert(flattenTrans && flattenTrans.requires_human_review === true, "FLATTEN_TRANSPARENCY requires human review");
    assert(flattenTrans && flattenTrans.visually_sensitive === true, "FLATTEN_TRANSPARENCY is visually sensitive");

    const flattenPdf = getCap('FLATTEN_PDF');
    assert(flattenPdf && flattenPdf.production_safe === false, "FLATTEN_PDF is not production_safe");
    assert(flattenPdf && flattenPdf.requires_human_review === true, "FLATTEN_PDF requires human review");
    assert(flattenPdf && flattenPdf.visually_sensitive === true, "FLATTEN_PDF is visually sensitive");
    assert(flattenPdf && flattenPdf.destructive === true, "FLATTEN_PDF is destructive");

    const flattenOverprint = getCap('FLATTEN_OVERPRINT');
    assert(flattenOverprint && flattenOverprint.production_safe === false, "FLATTEN_OVERPRINT is not production_safe");
    assert(flattenOverprint && flattenOverprint.visually_sensitive === true, "FLATTEN_OVERPRINT is visually sensitive");

    const convertPdfx = getCap('CONVERT_TO_PDFX_TRANSPARENCY_SAFE');
    assert(convertPdfx && convertPdfx.implemented === false, "CONVERT_TO_PDFX_TRANSPARENCY_SAFE is not implemented");
    assert(convertPdfx && convertPdfx.pdfx_generation_supported === false, "CONVERT_TO_PDFX_TRANSPARENCY_SAFE pdfx_generation_supported=false");
    assert(convertPdfx && convertPdfx.pdfx_compliance_claimed === false, "CONVERT_TO_PDFX_TRANSPARENCY_SAFE pdfx_compliance_claimed=false");

    // B. Normalize transparency finding
    console.log("\n--- B. Normalize transparency finding ---");
    const inputB = {
        version: "2.0",
        transparency_present: true,
        transparency_overprint_governance: {
            review_required: true,
            review_required_reasons: ["TRANSPARENCY_PRESENT"]
        }
    };
    const normB = FixAuditNormalizer.normalize(inputB);
    assert(normB.transparency_overprint_governance.review_required === true, "Preserved transparency review_required=true");
    assert(normB.transparency_present === true, "Preserved transparency_present=true");

    // C. Normalize soft mask / blend mode
    console.log("\n--- C. Normalize soft mask / blend mode ---");
    const inputC = {
        version: "2.0",
        soft_masks_present: true,
        blend_modes_present: true,
        transparency_overprint_governance: {
            review_required: true
        }
    };
    const normC = FixAuditNormalizer.normalize(inputC);
    assert(normC.transparency_overprint_governance.review_required === true, "Preserved soft mask review_required=true");

    // D. Normalize overprint finding
    console.log("\n--- D. Normalize overprint finding ---");
    const inputD = {
        version: "2.0",
        overprint_present: true,
        transparency_overprint_governance: {
            review_required: true
        }
    };
    const normD = FixAuditNormalizer.normalize(inputD);
    assert(normD.overprint_present === true, "Preserved overprint_present=true");

    // E. Unsupported FLATTEN_TRANSPARENCY
    console.log("\n--- E. Unsupported FLATTEN_TRANSPARENCY ---");
    const inputE = {
        version: "2.0",
        skipped_fixes: [
            {
                code: "FLATTEN_TRANSPARENCY",
                status: "SKIPPED",
                reason: "Unsupported transparency fix",
                visually_sensitive: true,
                destructive: true,
                moved_from_applied_to_skipped: true
            }
        ],
        unsupported_transparency_overprint_fixes: ["FLATTEN_TRANSPARENCY"]
    };
    const normE = FixAuditNormalizer.normalize(inputE);
    assert(normE.skipped_fixes.length === 1 && normE.skipped_fixes[0].code === "FLATTEN_TRANSPARENCY", "Preserved FLATTEN_TRANSPARENCY in skipped_fixes");
    assert(normE.skipped_fixes[0].moved_from_applied_to_skipped === true, "Preserved moved_from_applied_to_skipped");
    assert(normE.skipped_fixes[0].visually_sensitive === true, "Preserved visually_sensitive");

    // F. Unsupported CONVERT_TO_PDFX_TRANSPARENCY_SAFE (Service logic)
    console.log("\n--- F. Unsupported CONVERT_TO_PDFX_TRANSPARENCY_SAFE ---");
    const service = new PreflightService({}, {}, { getJobSubfolder: () => '/dev/null' });
    const payloadF = service._normalizeJobPayload({ id: "job123", job_type: "AUTOFIX", status: "COMPLETED" }, [], {
        ok: true,
        type: "AUTOFIX",
        skipped_fixes: [{ code: "CONVERT_TO_PDFX_TRANSPARENCY_SAFE", status: "SKIPPED" }],
        transparency_overprint_governance: { pdfx_compliance_claimed: true }
    });
    assert(payloadF.result.pdfx_compliance_claimed === false, "Forced pdfx_compliance_claimed=false when unsupported PDFX fix is skipped");

    // G. Certified PDF downgrade / H. Future applied visual rewrite fix
    console.log("\n--- G/H. Certified PDF downgrade / Over-certification ---");
    // Mock db and artifacts for getJobArtifacts
    const db = require('../src/services/db');
    const originalQuery = db.query;
    db.query = async (sql, params) => {
        return [[{ id: "job124", tenant_id: "t1", status: "COMPLETED", job_type: "AUTOFIX", result: {} }]];
    };

    const mockStats = { size: 1024, birthtime: new Date() };
    const fsExtra = require('fs-extra');
    const originalPathExists = fsExtra.pathExists;
    const originalReaddir = fsExtra.readdir;
    const originalStat = fsExtra.stat;

    service._resolvePhysicalOutputDir = async () => '/mock/output';
    fsExtra.pathExists = async (p) => true;
    fsExtra.readdir = async (p) => ['certified.pdf', 'report.json', 'fix_audit.json'];
    fsExtra.stat = async (p) => mockStats;
    fsExtra.readJson = async (p) => {
        if (p.endsWith('fix_audit.json')) {
            return {
                version: "2.0",
                transparency_overprint_governance: {
                    certified_pdf_allowed: false,
                    review_required: true,
                    visual_rewrite_fix_applied: true
                }
            };
        }
        return {};
    };

    const artifactsRes = await service.getJobArtifacts("job124", "t1");
    const certPdf = artifactsRes.artifacts.find(a => a.type === 'certified_pdf');
    assert(certPdf, "Certified PDF artifact exists in mock");
    if (certPdf) {
        assert(certPdf.artifact_role === 'REVIEW_REQUIRED', `certified.pdf downgraded to REVIEW_REQUIRED (got ${certPdf.artifact_role})`);
        assert(certPdf.customer_visible === false, "certified.pdf is not customer_visible");
        assert(certPdf.production_certified === false, "certified.pdf is not production_certified");
    }

    // Over-certification detection
    const overCertified = certPdf && certPdf.production_certified === true;
    assert(!overCertified, "Over-certification detector: certified.pdf is NOT incorrectly marked as production_certified=true");

    // Restore mocks
    db.query = originalQuery;
    fsExtra.pathExists = originalPathExists;
    fsExtra.readdir = originalReaddir;
    fsExtra.stat = originalStat;

    console.log(`\nResults: ${passed} passed, ${failed} failed.`);

    const report = {
        phase: "53C",
        passed,
        failed,
        success: failed === 0
    };

    fs.mkdirSync(path.join(__dirname, '../reports'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '../reports/phase53c_service_transparency_overprint_capabilities.json'), JSON.stringify(report, null, 2));

    let md = `# Phase 53C Smoke Test Report\n\n`;
    md += `**Passed:** ${passed}\n`;
    md += `**Failed:** ${failed}\n`;
    md += `**Status:** ${failed === 0 ? 'SUCCESS' : 'FAILED'}\n\n`;
    md += `## Notes\n- Verified capability contract for transparency and overprint fixes.\n`;
    md += `- Verified FixAuditNormalizer preserves transparency governance and fix traceability fields.\n`;
    md += `- Verified PreflightService protects against PDF/X overclaims.\n`;
    md += `- Verified PreflightService correctly downgrades certified.pdf when certified_pdf_allowed=false.\n`;
    fs.writeFileSync(path.join(__dirname, '../reports/phase53c_service_transparency_overprint_capabilities.md'), md);

    if (failed > 0) {
        process.exit(1);
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
