const assert = require('assert');
const FixCapabilityContract = require('../services/FixCapabilityContract');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');
const PreflightService = require('../services/PreflightService');
const fs = require('fs-extra');
const path = require('path');

async function runSmokeTests() {
    console.log("=== Running Phase 52C Smoke Tests ===");

    // Scenario A: Capability contract
    console.log("Test A: Capability contract...");
    const caps = FixCapabilityContract.getCapabilities().capabilities;
    const convertCmyk = caps.find(c => c.fix_id === "CONVERT_CMYK");
    assert.strictEqual(convertCmyk.implemented, true);
    assert.strictEqual(convertCmyk.production_safe, false);
    assert.strictEqual(convertCmyk.requires_human_review, true);
    assert.strictEqual(convertCmyk.visually_sensitive, true);

    const reduceTac = caps.find(c => c.fix_id === "REDUCE_TAC");
    assert.strictEqual(reduceTac.implemented, false);

    const mapRichBlack = caps.find(c => c.fix_id === "MAP_RICH_BLACK_TEXT_TO_K_ONLY");
    assert.strictEqual(mapRichBlack.implemented, false);

    const mapRegColor = caps.find(c => c.fix_id === "MAP_REGISTRATION_COLOR_TO_BLACK");
    assert.strictEqual(mapRegColor.implemented, false);

    const injectOutputIntent = caps.find(c => c.fix_id === "INJECT_OUTPUT_INTENT");
    assert.strictEqual(injectOutputIntent.implemented, true);
    assert.strictEqual(injectOutputIntent.production_safe, true);

    // Scenario B: Normalize CONVERT_CMYK applied
    console.log("Test B: Normalize CONVERT_CMYK applied...");
    const inputBAudit = {
        version: "2.0",
        applied_fixes: [{ code: "CONVERT_CMYK", status: "APPLIED" }],
        production_certified: false,
        color_governance: {
            destructive_color_fix_applied: true,
            certified_pdf_allowed: false
        }
    };
    const normB = FixAuditNormalizer.normalize(inputBAudit);
    assert.strictEqual(normB.production_certified, false);
    assert.strictEqual(normB.color_governance.destructive_color_fix_applied, true);

    // Scenario C: Normalize INJECT_OUTPUT_INTENT only
    console.log("Test C: Normalize INJECT_OUTPUT_INTENT only...");
    const inputCAudit = {
        version: "2.0",
        applied_fixes: [{ code: "INJECT_OUTPUT_INTENT", status: "APPLIED" }],
        production_certified: true,
        review_required: false,
        color_governance: {
            output_intent_changed: true,
            certified_pdf_allowed: true,
            review_required_color_reasons: []
        }
    };
    const normC = FixAuditNormalizer.normalize(inputCAudit);
    assert.strictEqual(normC.production_certified, true);
    assert.strictEqual(normC.review_required, false);

    // Scenario D: Normalize unsupported REDUCE_TAC
    console.log("Test D: Normalize unsupported REDUCE_TAC...");
    const inputDAudit = {
        version: "2.0",
        skipped_fixes: [{ code: "REDUCE_TAC", status: "SKIPPED", reason: "UNSUPPORTED_COLOR_FIX" }],
        color_governance: {
            unsupported_color_fixes: ["REDUCE_TAC"]
        }
    };
    const normD = FixAuditNormalizer.normalize(inputDAudit);
    assert.ok(normD.skipped_fixes.find(f => f.code === "REDUCE_TAC"));
    assert.deepStrictEqual(normD.color_governance.unsupported_color_fixes, ["REDUCE_TAC"]);

    // Scenarios E & F: Artifact Downgrade & Summary logic
    console.log("Test E & F: Artifact Downgrade & Summary logic...");
    const mockStorage = {
        getJobSubfolder: () => '/tmp/mock_output_dir',
        getBaseDir: () => '/tmp',
        initializeJobStorage: async () => {},
        saveInputFile: async () => ({ filePath: '/tmp/mock.pdf' }),
        deleteJobStorage: async () => {}
    };

    const mockDb = {
        query: async () => [[{ id: "mock_job", tenant_id: "t1", status: "COMPLETED", result: "{}" }]],
        execute: async () => {}
    };

    // Replace db for the test
    const db = require('../src/services/db');
    db.query = mockDb.query;
    db.execute = mockDb.execute;

    const svc = new PreflightService(null, null, mockStorage);
    
    // Create mock output directory with files
    await fs.ensureDir('/tmp/mock_output_dir');
    await fs.writeFile('/tmp/mock_output_dir/certified.pdf', 'mock content');
    
    // Write fix_audit with color_governance blocking certification
    const fixAuditE = {
        version: "2.0",
        production_certified: true, // But we override with color_gov
        review_required: false,
        color_governance: {
            certified_pdf_allowed: false,
            review_required_color_reasons: ["RICH_BLACK_TEXT"],
            destructive_color_fix_applied: true
        }
    };
    await fs.writeJson('/tmp/mock_output_dir/fix_audit.json', fixAuditE);

    const artifactsRes = await svc.getJobArtifacts('mock_job', 't1');
    const certifiedArtifact = artifactsRes.artifacts.find(a => a.type === 'certified_pdf');
    
    assert.strictEqual(certifiedArtifact.artifact_role, 'REVIEW_REQUIRED');
    assert.strictEqual(certifiedArtifact.production_certified, false);
    assert.strictEqual(certifiedArtifact.customer_visible, false);

    assert.strictEqual(artifactsRes.artifact_summary.production_ready_artifact_available, false);
    assert.strictEqual(artifactsRes.artifact_summary.review_required_artifact_available, true);

    // Clean up
    await fs.remove('/tmp/mock_output_dir');

    console.log("All Smoke Tests Passed!");
}

runSmokeTests().catch(err => {
    console.error(err);
    process.exit(1);
});
