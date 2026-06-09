# Phase 69C — Service Visual Diff Exposure

**Generated:** 2026-06-09T15:27:47.542Z  
**Repo:** ppos-preflight-service  
**Input mode:** ENGINE_REPORT  
**Smoke:** ✓ PASSED  
**Results:** 61/61 passed

## Core Principle

> visual_diff_governance is evidence — not certification. visual_change_detected=true or visual_review_required=true must block certified.pdf. proof artifacts must never expose local paths. production_certified=false and standard_certified=false are always enforced on visual_diff_governance.

## Changes

- FixAuditNormalizer.js: visual_diff_governance and visual_proof_evidence preserved in v2 normalization
- FixAuditNormalizer.js: delta_report.visual_diff_governance preserved
- FixCapabilityContract.js: version bumped to 48.0, engine_registry_compatibility=phase-69
- FixCapabilityContract.js: RENDER_PDF_PAGES, GENERATE_VISUAL_DIFF, GENERATE_PROOF_THUMBNAILS, COMPARE_ORIGINAL_TO_FIXED, GENERATE_VISUAL_CHANGE_REPORT added under visual_proofing category
- PreflightService.js: visual_diff_governance governance sources added after transparency_overprint_physical block
- PreflightService.js: visual_review_required/visual_change_detected → requiresReview=true, productionCertified=false
- PreflightService.js: certified.pdf downgraded when visual_review_required=true (via requiresReview gate)
- PreflightService.js: visual_diff_governance added to artifact_summary in getJobArtifacts
- PreflightService.js: visual_diff_governance added to artifact_summary and return payload in _normalizeJobPayload

## Scenarios

| # | Scenario | Result |
|---|----------|--------|
| 1 | FixCapabilityContract version >= 48.0 | ✓ PASS |
| 2 | engine_registry_compatibility=phase-69 | ✓ PASS |
| 3 | RENDER_PDF_PAGES capability present | ✓ PASS |
| 4 | GENERATE_VISUAL_DIFF capability present | ✓ PASS |
| 5 | GENERATE_PROOF_THUMBNAILS capability present | ✓ PASS |
| 6 | COMPARE_ORIGINAL_TO_FIXED capability present | ✓ PASS |
| 7 | GENERATE_VISUAL_CHANGE_REPORT capability present | ✓ PASS |
| 8 | GENERATE_VISUAL_DIFF category=visual_proofing | ✓ PASS |
| 9 | GENERATE_VISUAL_DIFF production_certified=false | ✓ PASS |
| 10 | GENERATE_VISUAL_DIFF standard_certified=false | ✓ PASS |
| 11 | GENERATE_VISUAL_DIFF compliance_claim_allowed=false | ✓ PASS |
| 12 | Phase 68 capabilities still present (regression) | ✓ PASS |
| 13 | visual_diff_governance preserved at root | ✓ PASS |
| 14 | visual_change_detected preserved | ✓ PASS |
| 15 | visual_review_required preserved | ✓ PASS |
| 16 | max_changed_pixel_ratio preserved | ✓ PASS |
| 17 | proof_artifacts_available preserved | ✓ PASS |
| 18 | evidence preserved | ✓ PASS |
| 19 | warnings preserved | ✓ PASS |
| 20 | visual_change_detected=true → govRequiresBlock=true | ✓ PASS |
| 21 | visual_change_detected=true → productionCertified=false | ✓ PASS |
| 22 | visual_change_detected=true → requiresReview=true | ✓ PASS |
| 23 | visual_change_detected=true → certifiedPdfAllowed=false | ✓ PASS |
| 24 | visual_review_required=true → requiresReview=true | ✓ PASS |
| 25 | visual_review_required=true → productionCertified=false | ✓ PASS |
| 26 | visual_review_required=true → certifiedPdfAllowed=false | ✓ PASS |
| 27 | render_tool_gap=true preserved | ✓ PASS |
| 28 | proof_artifacts_available=false preserved | ✓ PASS |
| 29 | tool gap → visual_review_required still drives downgrade | ✓ PASS |
| 30 | tool gap → certifiedPdfAllowed=false | ✓ PASS |
| 31 | no visual_diff_governance → undefined in normalized | ✓ PASS |
| 32 | no visual_diff_governance → govRequiresBlock=false | ✓ PASS |
| 33 | no visual_diff_governance → production_certified not downgraded | ✓ PASS |
| 34 | visual_diff_governance preserved even with no flags set | ✓ PASS |
| 35 | delta_report.visual_diff_governance preserved | ✓ PASS |
| 36 | delta_report.visual_diff_governance.visual_change_detected preserved | ✓ PASS |
| 37 | render_performed evidence preserved | ✓ PASS |
| 38 | diff_performed evidence preserved | ✓ PASS |
| 39 | pages_rendered evidence preserved | ✓ PASS |
| 40 | render_tool evidence preserved | ✓ PASS |
| 41 | diff_images evidence preserved | ✓ PASS |
| 42 | thumbnails evidence preserved | ✓ PASS |
| 43 | changed_pixel_ratio_avg preserved | ✓ PASS |
| 44 | All 69B scenarios successfully normalized | ✓ PASS |
| 45 | No visual_diff_governance scenario claims production_certified=true | ✓ PASS |
| 46 | visual_review_required=true always blocks certified.pdf | ✓ PASS |
| 47 | artifact_summary.visual_diff_governance populated | ✓ PASS |
| 48 | artifact_summary.visual_diff_governance.production_certified=false | ✓ PASS |
| 49 | artifact_summary.visual_diff_governance.standard_certified=false | ✓ PASS |
| 50 | artifact_summary.visual_diff_governance.visual_change_detected preserved | ✓ PASS |
| 51 | visual_diff path → production_certified=false | ✓ PASS |
| 52 | visual_diff path → requiresReview=true | ✓ PASS |
| 53 | visual_diff path → certifiedPdfAllowed=false | ✓ PASS |
| 54 | Empty audit data → available=false | ✓ PASS |
| 55 | Null audit data → available=false | ✓ PASS |
| 56 | visual_proof_evidence preserved at root | ✓ PASS |
| 57 | thumbnails array preserved | ✓ PASS |
| 58 | render_tool preserved | ✓ PASS |
| 59 | VALIDATE_PDFA still present | ✓ PASS |
| 60 | VALIDATE_PDFA compliance_claim_allowed=false | ✓ PASS |
| 61 | VALIDATE_PDFA required_evidence_fields includes validation_report_hash | ✓ PASS |
