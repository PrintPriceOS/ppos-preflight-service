const FixCapabilityContract = require('../services/FixCapabilityContract');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');

async function runSmokeTests() {
    console.log("Running Phase 46 Smoke Tests: Service Fix Contract & Policy Governance");
    let passed = 0;
    let failed = 0;

    function assertEq(name, actual, expected) {
        if (actual === expected) {
            console.log(`[PASS] ${name}`);
            passed++;
        } else {
            console.error(`[FAIL] ${name} (Expected ${expected}, got ${actual})`);
            failed++;
        }
    }

    function assertTrue(name, condition) {
        if (condition) {
            console.log(`[PASS] ${name}`);
            passed++;
        } else {
            console.error(`[FAIL] ${name}`);
            failed++;
        }
    }

    // A. Capability Endpoint
    console.log("\n--- Testing FixCapabilityContract ---");
    const caps = FixCapabilityContract.getCapabilities();
    assertEq("Root ok is true", caps.ok, true);
    assertEq("Capability version", caps.version, "46.0");
    assertEq("Policy modes length", caps.policy_modes.length, 3);
    assertTrue("Capabilities count >= 12", caps.capabilities.length >= 12);
    
    const applyBleed = caps.capabilities.find(c => c.fix_id === "APPLY_BLEED");
    assertTrue("APPLY_BLEED found", !!applyBleed);
    assertEq("APPLY_BLEED requires_human_review", applyBleed.requires_human_review, true);
    assertEq("APPLY_BLEED risk_level", applyBleed.risk_level, "MEDIUM");
    assertEq("APPLY_BLEED production_safe", applyBleed.production_safe, false);
    assertTrue("APPLY_BLEED message correct", applyBleed.operator_message.includes("Box expansion only"));

    const trimbox = caps.capabilities.find(c => c.fix_id === "REBUILD_TRIMBOX");
    assertTrue("REBUILD_TRIMBOX found", !!trimbox);
    assertEq("REBUILD_TRIMBOX implemented", trimbox.implemented, true);

    const stripjs = caps.capabilities.find(c => c.fix_id === "STRIP_JAVASCRIPT");
    assertTrue("STRIP_JAVASCRIPT found", !!stripjs);
    assertEq("STRIP_JAVASCRIPT implemented", stripjs.implemented, true);

    const fonts = caps.capabilities.find(c => c.fix_id === "EMBED_FONTS");
    assertTrue("EMBED_FONTS found", !!fonts);
    assertEq("EMBED_FONTS implemented", fonts.implemented, false);

    const cmyk = caps.capabilities.find(c => c.fix_id === "CONVERT_CMYK");
    assertTrue("CONVERT_CMYK found", !!cmyk);
    assertEq("CONVERT_CMYK requires_human_review", cmyk.requires_human_review, true);

    const flattenAnnotations = caps.capabilities.find(c => c.fix_id === "FLATTEN_ANNOTATIONS");
    assertTrue("FLATTEN_ANNOTATIONS found", !!flattenAnnotations);
    assertEq("FLATTEN_ANNOTATIONS implemented", flattenAnnotations.implemented, true);

    const flattenForms = caps.capabilities.find(c => c.fix_id === "FLATTEN_FORMS");
    assertTrue("FLATTEN_FORMS found", !!flattenForms);
    assertEq("FLATTEN_FORMS implemented", flattenForms.implemented, true);

    const rebuildXref = caps.capabilities.find(c => c.fix_id === "REBUILD_XREF");
    assertTrue("REBUILD_XREF found", !!rebuildXref);
    assertEq("REBUILD_XREF implemented", rebuildXref.implemented, true);

    const injectOutputIntent = caps.capabilities.find(c => c.fix_id === "INJECT_OUTPUT_INTENT");
    assertTrue("INJECT_OUTPUT_INTENT found", !!injectOutputIntent);
    assertEq("INJECT_OUTPUT_INTENT implemented", injectOutputIntent.implemented, true);

    const visualBleedExtension = caps.capabilities.find(c => c.fix_id === "VISUAL_BLEED_EXTENSION");
    assertTrue("VISUAL_BLEED_EXTENSION found", !!visualBleedExtension);
    assertEq("VISUAL_BLEED_EXTENSION implemented", visualBleedExtension.implemented, false);

    // B. FixAuditNormalizer
    console.log("\n--- Testing FixAuditNormalizer ---");
    const v2Audit = {
        version: "2.0",
        requested_fixes: ["REBUILD_TRIMBOX"],
        applied_fixes: [{ fix_id: "REBUILD_TRIMBOX", status: "APPLIED" }],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: true,
        production_certified: false,
        highest_risk_level: "LOW"
    };

    const normV2 = FixAuditNormalizer.normalize(v2Audit);
    assertEq("V2 Normalization available", normV2.available, true);
    assertEq("V2 requested count", normV2.requested_count, 1);
    assertEq("V2 review required", normV2.review_required, true);

    const legacyAudit = {
        version: "1.0",
        fixes_applied: ["CONVERT_CMYK"]
    };
    const normLegacy = FixAuditNormalizer.normalize(legacyAudit);
    assertEq("Legacy Normalization available", normLegacy.available, true);
    assertEq("Legacy applied count", normLegacy.applied_count, 1);
    assertEq("Legacy review required (CMYK inferred)", normLegacy.review_required, true);
    assertEq("Legacy highest risk (CMYK inferred)", normLegacy.highest_risk_level, "MEDIUM");

    const missingAudit = FixAuditNormalizer.normalize(null);
    assertEq("Missing Normalization available", missingAudit.available, false);
    assertEq("Missing requested count", missingAudit.requested_count, 0);

    console.log("\n--- Smoke Tests Completed ---");
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    if (failed > 0) {
        process.exit(1);
    }
}

runSmokeTests().catch(e => {
    console.error("Smoke test execution failed:", e);
    process.exit(1);
});
