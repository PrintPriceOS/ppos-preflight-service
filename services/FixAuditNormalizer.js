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
                        moved_from_applied_to_review_reason: fix.moved_from_applied_to_review_reason,
                        validator_required: fix.validator_required,
                        validator_available: fix.validator_available,
                        compliance_claim_allowed: fix.compliance_claim_allowed,
                        standard_claimed: fix.standard_claimed,
                        standard_detected: fix.standard_detected,
                        validation_performed: fix.validation_performed,
                        validation_passed: fix.validation_passed,
                        validator_name: fix.validator_name,
                        validator_version: fix.validator_version,
                        validation_report_hash: fix.validation_report_hash,
                        pages_processed: fix.pages_processed,
                        page_boxes_before: fix.page_boxes_before,
                        page_boxes_after: fix.page_boxes_after,
                        mark_geometry: fix.mark_geometry,
                        safety_checks: fix.safety_checks,
                        detection_confidence: fix.detection_confidence,
                        warnings: fix.warnings,
                        limitations: fix.limitations,
                        skip_reason: fix.skip_reason,
                        capability: fix.capability
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
            if (auditData.validator_gap !== undefined) ret.validator_gap = auditData.validator_gap;
            if (auditData.input_mode !== undefined) ret.input_mode = auditData.input_mode;
            if (auditData.engine_real_detection !== undefined) ret.engine_real_detection = auditData.engine_real_detection;
            if (auditData.qpdf_warnings !== undefined) ret.qpdf_warnings = auditData.qpdf_warnings;
            if (auditData.metadata_cleanup_warnings !== undefined) ret.metadata_cleanup_warnings = auditData.metadata_cleanup_warnings;
            if (auditData.internal_report_markers !== undefined) ret.internal_report_markers = auditData.internal_report_markers;

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

            // Standards Certification Governance
            if (auditData.standards_certification_governance) ret.standards_certification_governance = auditData.standards_certification_governance;
            if (auditData.standard_certified !== undefined) ret.standard_certified = auditData.standard_certified;
            if (auditData.pdfa_compliance_claimed !== undefined) ret.pdfa_compliance_claimed = auditData.pdfa_compliance_claimed;
            if (auditData.compliance_claim_allowed !== undefined) ret.compliance_claim_allowed = auditData.compliance_claim_allowed;
            if (auditData.validator_required !== undefined) ret.validator_required = auditData.validator_required;
            if (auditData.validator_available !== undefined) ret.validator_available = auditData.validator_available;
            if (auditData.validation_performed !== undefined) ret.validation_performed = auditData.validation_performed;
            if (auditData.validation_passed !== undefined) ret.validation_passed = auditData.validation_passed;
            if (auditData.validator_name !== undefined) ret.validator_name = auditData.validator_name;
            if (auditData.validator_version !== undefined) ret.validator_version = auditData.validator_version;
            if (auditData.validation_report_available !== undefined) ret.validation_report_available = auditData.validation_report_available;
            if (auditData.validation_report_path !== undefined) ret.validation_report_path = auditData.validation_report_path;
            if (auditData.validation_report_hash !== undefined) ret.validation_report_hash = auditData.validation_report_hash;
            if (auditData.standard_claimed !== undefined) ret.standard_claimed = auditData.standard_claimed;
            if (auditData.standard_detected !== undefined) ret.standard_detected = auditData.standard_detected;
            if (auditData.standard_validation_report !== undefined) ret.standard_validation_report = auditData.standard_validation_report;
            if (auditData.outputintent_only !== undefined) ret.outputintent_only = auditData.outputintent_only;
            if (auditData.outputintent_does_not_prove_pdfx !== undefined) ret.outputintent_does_not_prove_pdfx = auditData.outputintent_does_not_prove_pdfx;
            if (auditData.unsupported_standards_fixes !== undefined) ret.unsupported_standards_fixes = auditData.unsupported_standards_fixes;
            if (auditData.standard_claim_without_validator_evidence !== undefined) ret.standard_claim_without_validator_evidence = auditData.standard_claim_without_validator_evidence;

            // Artifact Trust Governance (Phase 56)
            if (auditData.artifact_trust) {
                ret.artifact_trust = auditData.artifact_trust; // Preserve as is, including nested fields
            }

            // Structural Metadata Governance (Phase 61)
            if (auditData.structural_metadata_governance) {
                ret.structural_metadata_governance = auditData.structural_metadata_governance;
            }

            // Page Marks Governance (Phase 62)
            if (auditData.page_marks_governance) {
                ret.page_marks_governance = auditData.page_marks_governance;
            }

            // Security / Interactivity Governance (Phase 63)
            if (auditData.security_interactivity_governance) {
                ret.security_interactivity_governance = auditData.security_interactivity_governance;
            }

            // Ink / TAC / Black / Registration Color Governance (Phase 64)
            if (auditData.ink_governance) {
                ret.ink_governance = auditData.ink_governance;
            }

            // Selective Image Governance (Phase 65)
            if (auditData.selective_image_governance) {
                ret.selective_image_governance = auditData.selective_image_governance;
            }

            // Font Governance (Phase 66)
            if (auditData.font_governance) {
                ret.font_governance = auditData.font_governance;
            }

            // Transparency / Overprint Physical Governance (Phase 67)
            if (auditData.transparency_overprint_physical_governance) {
                ret.transparency_overprint_physical_governance = auditData.transparency_overprint_physical_governance;
            }

            // Visual Diff Governance (Phase 69)
            if (auditData.visual_diff_governance) {
                ret.visual_diff_governance = auditData.visual_diff_governance;
            }
            if (auditData.visual_proof_evidence) {
                ret.visual_proof_evidence = auditData.visual_proof_evidence;
            }

            // Proof Approval Governance (Phase 70)
            if (auditData.proof_approval_governance) {
                ret.proof_approval_governance = auditData.proof_approval_governance;
            }

            // Phase 68C: sanitized validation_report artifact (hash/name/version/standard_detected only — no local paths)
            if (auditData.standards_certification_governance || auditData.validation_report_hash) {
                const scg = auditData.standards_certification_governance || {};
                const hash = scg.validation_report_hash || auditData.validation_report_hash;
                const name = scg.validator_name || auditData.validator_name;
                const version = scg.validator_version || auditData.validator_version;
                const detected = scg.standard_detected || auditData.standard_detected;
                if (hash || name || version || detected) {
                    ret.validation_report_sanitized = {
                        validation_report_hash: hash || null,
                        validator_name: name || null,
                        validator_version: version || null,
                        standard_detected: detected || null,
                        source: 'standards_certification_governance'
                    };
                }
            }

            if (auditData.delta_report) {
                ret.delta_report = ret.delta_report || {};
                if (auditData.delta_report.color_governance) ret.delta_report.color_governance = auditData.delta_report.color_governance;
                if (auditData.delta_report.transparency_overprint_governance) ret.delta_report.transparency_overprint_governance = auditData.delta_report.transparency_overprint_governance;
                if (auditData.delta_report.image_quality_governance) ret.delta_report.image_quality_governance = auditData.delta_report.image_quality_governance;
                if (auditData.delta_report.standards_certification_governance) ret.delta_report.standards_certification_governance = auditData.delta_report.standards_certification_governance;
                if (auditData.delta_report.structural_metadata_governance) ret.delta_report.structural_metadata_governance = auditData.delta_report.structural_metadata_governance;
                if (auditData.delta_report.artifact_trust) ret.delta_report.artifact_trust = auditData.delta_report.artifact_trust;
                if (auditData.delta_report.page_marks_governance) ret.delta_report.page_marks_governance = auditData.delta_report.page_marks_governance;
                if (auditData.delta_report.security_interactivity_governance) ret.delta_report.security_interactivity_governance = auditData.delta_report.security_interactivity_governance;
                if (auditData.delta_report.ink_governance) ret.delta_report.ink_governance = auditData.delta_report.ink_governance;
                if (auditData.delta_report.selective_image_governance) ret.delta_report.selective_image_governance = auditData.delta_report.selective_image_governance;
                if (auditData.delta_report.font_governance) ret.delta_report.font_governance = auditData.delta_report.font_governance;
                if (auditData.delta_report.transparency_overprint_physical_governance) ret.delta_report.transparency_overprint_physical_governance = auditData.delta_report.transparency_overprint_physical_governance;
                if (auditData.delta_report.visual_diff_governance) ret.delta_report.visual_diff_governance = auditData.delta_report.visual_diff_governance;
                if (auditData.delta_report.proof_approval_governance) ret.delta_report.proof_approval_governance = auditData.delta_report.proof_approval_governance;
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
