# Phase 68C — Service Validator Evidence Exposure

**Generated:** 2026-06-09T02:42:44.595Z  
**Repo:** ppos-preflight-service  
**Input mode:** ENGINE_REPORT  
**Smoke:** ✓ PASSED  
**Results:** 56/56 passed

## Core Principle

> standard_certified=true requires all 7 canonical evidence fields (validation_performed, validation_passed, validator_name, validator_version, standard_detected, validation_report_hash, compliance_claim_allowed). validation_report_path is never exposed publicly — only hash/name/version/standard_detected.

## Required Evidence Fields (7)

- `validation_performed`
- `validation_passed`
- `validator_name`
- `validator_version`
- `standard_detected`
- `validation_report_hash`
- `compliance_claim_allowed`

## Changes

- FixAuditNormalizer.js: standard_detected and validation_report_hash added to preserveFixFields
- FixAuditNormalizer.js: validation_report_sanitized built from standards_certification_governance (hash/name/version/standard_detected only)
- FixCapabilityContract.js: version bumped to 47.0, engine_registry_compatibility=phase-68
- FixCapabilityContract.js: VALIDATE_PDFX and VALIDATE_PDFA updated with required_evidence_fields and category=standards_certification
- FixCapabilityContract.js: CONVERT_TO_PDFX_VALIDATED and CONVERT_TO_PDFA_VALIDATED added
- PreflightService.js: hasValidEvidence tightened — requires validation_report_hash specifically (not validation_report_available or validation_report_path)
- PreflightService.js: validation_report sanitized artifact exposed in return value (hash/name/version/standard_detected, no paths)
- PreflightService.js: artifact_summary.standards_certification_governance added

## Scenarios

| # | Scenario | Result |
|---|----------|--------|
| 1 | FixCapabilityContract version >= 47.0 | ✓ PASS |
| 2 | VALIDATE_PDFX capability present | ✓ PASS |
| 3 | VALIDATE_PDFA capability present | ✓ PASS |
| 4 | CONVERT_TO_PDFX_VALIDATED capability present | ✓ PASS |
| 5 | CONVERT_TO_PDFA_VALIDATED capability present | ✓ PASS |
| 6 | VALIDATE_PDFA has required_evidence_fields | ✓ PASS |
| 7 | VALIDATE_PDFX compliance_claim_allowed=false by default | ✓ PASS |
| 8 | CONVERT_TO_PDFA_VALIDATED compliance_claim_allowed=false | ✓ PASS |
| 9 | GENERATE_STANDARD_VALIDATION_REPORT still present | ✓ PASS |
| 10 | Fix-level standard_detected preserved | ✓ PASS |
| 11 | Fix-level validation_report_hash preserved | ✓ PASS |
| 12 | Fix-level validator_name preserved | ✓ PASS |
| 13 | Fix-level validator_version preserved | ✓ PASS |
| 14 | Fix-level validation_performed preserved | ✓ PASS |
| 15 | Fix-level validation_passed preserved | ✓ PASS |
| 16 | Fix-level compliance_claim_allowed preserved | ✓ PASS |
| 17 | standards_certification_governance preserved at root | ✓ PASS |
| 18 | validation_report_sanitized built in normalizer | ✓ PASS |
| 19 | Complete 7-field evidence → hasValidEvidence=true | ✓ PASS |
| 20 | Complete 7-field evidence → no overclaim rejection | ✓ PASS |
| 21 | Complete 7-field evidence → validation_report artifact exposed | ✓ PASS |
| 22 | validation_report.available=true when all fields present | ✓ PASS |
| 23 | validation_report has no validation_report_path | ✓ PASS |
| 24 | Missing validation_report_hash → hasValidEvidence=false | ✓ PASS |
| 25 | Missing validation_report_hash → overclaim detected | ✓ PASS |
| 26 | validation_passed=false → hasValidEvidence=false | ✓ PASS |
| 27 | validation_passed=false → overclaim detected | ✓ PASS |
| 28 | No evidence → hasValidEvidence=false | ✓ PASS |
| 29 | No evidence → isClaimingCompliance=false (no claim to reject) | ✓ PASS |
| 30 | No evidence → standard_certified_final=false | ✓ PASS |
| 31 | No evidence → validation_report.available=false | ✓ PASS |
| 32 | False claim without evidence → overclaim=true | ✓ PASS |
| 33 | False claim rejected → standard_certified_final=false | ✓ PASS |
| 34 | validation_report_sanitized present | ✓ PASS |
| 35 | validation_report_sanitized has no validation_report_path | ✓ PASS |
| 36 | validation_report_sanitized has hash | ✓ PASS |
| 37 | delta_report.standards_certification_governance preserved | ✓ PASS |
| 38 | All 68B scenarios successfully normalized | ✓ PASS |
| 39 | No validation_report_path leaked in any scenario | ✓ PASS |
| 40 | All 7 evidence fields present in normalized standards_certification_governance | ✓ PASS |
| 41 | artifact_summary.standards_certification_governance is populated | ✓ PASS |
| 42 | False PDF/X claim without evidence → overclaim=true | ✓ PASS |
| 43 | False PDF/X claim → standard_certified_final=false | ✓ PASS |
| 44 | Incomplete evidence → overclaim detected (certified.pdf must be downgraded) | ✓ PASS |
| 45 | Partial gov → validation_report.available=false | ✓ PASS |
| 46 | engine_registry_compatibility=phase-68 | ✓ PASS |
| 47 | VALIDATE_PDFX category=standards_certification | ✓ PASS |
| 48 | VALIDATE_PDFA category=standards_certification | ✓ PASS |
| 49 | All 6 single-field-missing permutations → hasValidEvidence=false | ✓ PASS |
| 50 | GENERATE_STANDARD_VALIDATION_REPORT still present | ✓ PASS |
| 51 | GENERATE_STANDARD_VALIDATION_REPORT compliance_claim_allowed=false | ✓ PASS |
| 52 | Empty audit data → available=false | ✓ PASS |
| 53 | Null audit data → available=false | ✓ PASS |
| 54 | validation_report_sanitized.source = standards_certification_governance | ✓ PASS |
| 55 | delta_report.standards_certification_governance present in normalized output | ✓ PASS |
| 56 | delta_report.standards_certification_governance.review_required preserved | ✓ PASS |
