class FixAuditNormalizer {
    static normalize(auditData) {
        // Handle missing or empty data
        if (!auditData || Object.keys(auditData).length === 0) {
            return {
                available: false,
                version: null,
                requested_count: 0,
                applied_count: 0,
                skipped_count: 0,
                failed_count: 0,
                review_required: false,
                production_certified: false,
                highest_risk_level: "UNKNOWN",
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                fix_results: []
            };
        }

        // v2 handling
        if (auditData.version === "2.0") {
            return {
                available: true,
                version: "2.0",
                requested_count: auditData.requested_fixes ? auditData.requested_fixes.length : 0,
                applied_count: auditData.applied_fixes ? auditData.applied_fixes.length : 0,
                skipped_count: auditData.skipped_fixes ? auditData.skipped_fixes.length : 0,
                failed_count: auditData.failed_fixes ? auditData.failed_fixes.length : 0,
                review_required: auditData.review_required || false,
                review_required_reasons: auditData.review_required_reasons || [],
                production_certified: auditData.production_certified || false,
                highest_risk_level: auditData.highest_risk_level || "UNKNOWN",
                applied_fixes: auditData.applied_fixes || [],
                skipped_fixes: auditData.skipped_fixes || [],
                failed_fixes: auditData.failed_fixes || [],
                fix_results: auditData.fix_results || []
            };
        }

        // Legacy handling (best-effort)
        const applied = auditData.applied_fixes || auditData.fixes_applied || [];
        const skipped = auditData.skipped_fixes || auditData.fixes_skipped || [];
        const failed = auditData.failed_fixes || auditData.fixes_failed || [];
        
        let highestRisk = "LOW";
        if (applied.some(f => f && (typeof f === 'object' ? String(f.code || f.fix_id || "").toUpperCase() === "CONVERT_CMYK" : String(f).toUpperCase() === "CONVERT_CMYK"))) {
            highestRisk = "MEDIUM";
        }
        
        const reviewReq = auditData.review_required === true || highestRisk !== "LOW";

        return {
            available: true,
            version: auditData.version || "legacy",
            requested_count: (auditData.requested_fixes || []).length,
            applied_count: applied.length,
            skipped_count: skipped.length,
            failed_count: failed.length,
            review_required: reviewReq,
            review_required_reasons: auditData.review_required_reasons || (reviewReq ? ["Legacy output triggered review requirement"] : []),
            production_certified: auditData.production_certified === true,
            highest_risk_level: auditData.highest_risk_level || highestRisk,
            applied_fixes: applied,
            skipped_fixes: skipped,
            failed_fixes: failed,
            fix_results: auditData.fix_results || []
        };
    }
}

module.exports = FixAuditNormalizer;
