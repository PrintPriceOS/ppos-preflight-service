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
            const preserveFixFields = (fixes) => {
                return (fixes || []).map(fix => {
                    if (!fix || typeof fix !== 'object') return fix;
                    return {
                        ...fix,
                        code: fix.code,
                        status: fix.status,
                        reason: fix.reason,
                        risk_level: fix.risk_level,
                        requires_human_review: fix.requires_human_review,
                        production_safe: fix.production_safe,
                        evidence: fix.evidence,
                        visually_sensitive: fix.visually_sensitive,
                        destructive: fix.destructive,
                        moved_from_applied_to_skipped: fix.moved_from_applied_to_skipped,
                        moved_from_applied_to_review_reason: fix.moved_from_applied_to_review_reason
                    };
                });
            };

            const ret = {
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
                applied_fixes: preserveFixFields(auditData.applied_fixes),
                skipped_fixes: preserveFixFields(auditData.skipped_fixes),
                failed_fixes: preserveFixFields(auditData.failed_fixes),
                fix_results: auditData.fix_results || []
            };

            if (auditData.color_governance) ret.color_governance = auditData.color_governance;
            if (auditData.highest_color_risk) ret.highest_color_risk = auditData.highest_color_risk;
            if (auditData.destructive_color_fix_applied !== undefined) ret.destructive_color_fix_applied = auditData.destructive_color_fix_applied;
            if (auditData.unsupported_color_fixes) ret.unsupported_color_fixes = auditData.unsupported_color_fixes;
            if (auditData.review_required_color_reasons) ret.review_required_color_reasons = auditData.review_required_color_reasons;
            if (auditData.color_changed !== undefined) ret.color_changed = auditData.color_changed;
            if (auditData.output_intent_changed !== undefined) ret.output_intent_changed = auditData.output_intent_changed;
            if (auditData.color_conversion_applied !== undefined) ret.color_conversion_applied = auditData.color_conversion_applied;
            if (auditData.certified_pdf_allowed !== undefined) ret.certified_pdf_allowed = auditData.certified_pdf_allowed;
            
            // Transparency / Overprint Governance
            if (auditData.transparency_overprint_governance) ret.transparency_overprint_governance = auditData.transparency_overprint_governance;
            if (auditData.highest_transparency_overprint_risk) ret.highest_transparency_overprint_risk = auditData.highest_transparency_overprint_risk;
            if (auditData.visual_rewrite_fix_applied !== undefined) ret.visual_rewrite_fix_applied = auditData.visual_rewrite_fix_applied;
            if (auditData.unsupported_transparency_overprint_fixes) ret.unsupported_transparency_overprint_fixes = auditData.unsupported_transparency_overprint_fixes;
            if (auditData.transparency_present !== undefined) ret.transparency_present = auditData.transparency_present;
            if (auditData.overprint_present !== undefined) ret.overprint_present = auditData.overprint_present;
            if (auditData.soft_masks_present !== undefined) ret.soft_masks_present = auditData.soft_masks_present;
            if (auditData.blend_modes_present !== undefined) ret.blend_modes_present = auditData.blend_modes_present;
            if (auditData.rasterization_risk !== undefined) ret.rasterization_risk = auditData.rasterization_risk;
            if (auditData.pdfx_compliance_claimed !== undefined) ret.pdfx_compliance_claimed = auditData.pdfx_compliance_claimed;
            if (auditData.pdfx_generation_performed !== undefined) ret.pdfx_generation_performed = auditData.pdfx_generation_performed;

            // Preserve Engine/Worker Gaps and Inputs
            if (auditData.detector_gap !== undefined) ret.detector_gap = auditData.detector_gap;
            if (auditData.deferred !== undefined) ret.deferred = auditData.deferred;
            if (auditData.fixture_gap !== undefined) ret.fixture_gap = auditData.fixture_gap;
            if (auditData.input_mode !== undefined) ret.input_mode = auditData.input_mode;
            if (auditData.engine_real_detection !== undefined) ret.engine_real_detection = auditData.engine_real_detection;

            // Image Quality Governance
            if (auditData.image_quality_governance) ret.image_quality_governance = auditData.image_quality_governance;
            if (auditData.highest_image_quality_risk) ret.highest_image_quality_risk = auditData.highest_image_quality_risk;
            if (auditData.visual_image_rewrite_applied !== undefined) ret.visual_image_rewrite_applied = auditData.visual_image_rewrite_applied;
            if (auditData.unsupported_image_quality_fixes) ret.unsupported_image_quality_fixes = auditData.unsupported_image_quality_fixes;
            if (auditData.low_res_images_present !== undefined) ret.low_res_images_present = auditData.low_res_images_present;
            if (auditData.excessive_resolution_present !== undefined) ret.excessive_resolution_present = auditData.excessive_resolution_present;
            if (auditData.jpeg_artifacts_present !== undefined) ret.jpeg_artifacts_present = auditData.jpeg_artifacts_present;
            if (auditData.image_replacement_required !== undefined) ret.image_replacement_required = auditData.image_replacement_required;
            if (auditData.bitmap_text_risk !== undefined) ret.bitmap_text_risk = auditData.bitmap_text_risk;
            if (auditData.rasterized_vector_risk !== undefined) ret.rasterized_vector_risk = auditData.rasterized_vector_risk;
            if (auditData.image_object_damaged !== undefined) ret.image_object_damaged = auditData.image_object_damaged;
            if (auditData.image_rewrite_performed !== undefined) ret.image_rewrite_performed = auditData.image_rewrite_performed;

            if (auditData.delta_report) {
                ret.delta_report = ret.delta_report || {};
                if (auditData.delta_report.color_governance) ret.delta_report.color_governance = auditData.delta_report.color_governance;
                if (auditData.delta_report.transparency_overprint_governance) ret.delta_report.transparency_overprint_governance = auditData.delta_report.transparency_overprint_governance;
                if (auditData.delta_report.image_quality_governance) ret.delta_report.image_quality_governance = auditData.delta_report.image_quality_governance;
            }

            return ret;
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
