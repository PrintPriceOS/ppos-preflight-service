# Phase 62F-C — Service Heavy PDF Probe Exposure

**Generated:** 2026-06-09T23:15:24.648Z  
**Repo:** ppos-preflight-service  
**Input mode:** ENGINE_62F_REPORT_AUGMENTED  
**Smoke:** ✓ PASSED  
**Results:** 65/65 passed

## Core Principle

> heavy_pdf_probe_governance explains analysis quality. It does not certify the PDF, does not override artifact_trust, and does not allow production by itself. review_required=true and fatal_document_failure=true always degrade; they never upgrade certification. Customer payloads never see raw stderr, local paths, or object IDs; only safe warning classes are preserved.

## Changes

- FixAuditNormalizer.js: heavy_pdf_probe_governance preserved at root and in delta_report
- FixAuditNormalizer.js: analysisIntegrity, degraded_reasons, extractionErrors, analysis_status, certifiable, strict_forensic_mode preserved
- FixAuditNormalizer.js: new normalizeHeavyPdfProbeGovernance(gov, audience) helper for customer/operator sanitization
- FixCapabilityContract.js: version bumped to 50.0
- FixCapabilityContract.js: HEAVY_PDF_PROBE_SEMANTICS, QPDF_WARNING_CLASSIFICATION, PDFIMAGES_WARNING_CLASSIFICATION capabilities added under heavy_pdf_probe category (analysis capabilities, not fixes)
- PreflightService.js: getJobArtifacts resolves heavy_pdf_probe_governance from fix_audit/delta_report sources, applies review_required/fatal wins to productionCertified/requiresReview
- PreflightService.js: artifact_summary.heavy_pdf_probe_governance exposed (customer-sanitized), downgrades production_ready_artifact_available when review required
- PreflightService.js: _normalizeJobPayload Phase 62F-C enforcement block added after Phase 70C block
- PreflightService.js: heavy_pdf_probe_governance (customer) and heavy_pdf_probe_governance_operator (operator) exposed in artifact_summary and root payload

## Scenarios

| # | Scenario | Result |
|---|----------|--------|
| 1 | FixCapabilityContract version >= 50.0 | ✓ PASS |
| 2 | HEAVY_PDF_PROBE_SEMANTICS capability present | ✓ PASS |
| 3 | QPDF_WARNING_CLASSIFICATION capability present | ✓ PASS |
| 4 | PDFIMAGES_WARNING_CLASSIFICATION capability present | ✓ PASS |
| 5 | HEAVY_PDF_PROBE_SEMANTICS category=heavy_pdf_probe | ✓ PASS |
| 6 | HEAVY_PDF_PROBE_SEMANTICS production_certified=false | ✓ PASS |
| 7 | HEAVY_PDF_PROBE_SEMANTICS standard_certified=false | ✓ PASS |
| 8 | HEAVY_PDF_PROBE_SEMANTICS compliance_claim_allowed=false | ✓ PASS |
| 9 | HEAVY_PDF_PROBE_SEMANTICS not exposed as a fix (analysis_capability=true, autofixable=false) | ✓ PASS |
| 10 | Phase 70 capabilities still present (regression) | ✓ PASS |
| 11 | heavy_pdf_probe_governance preserved at root | ✓ PASS |
| 12 | qpdf semantic_status=WARNING_ONLY preserved | ✓ PASS |
| 13 | qpdf not classified as fatal | ✓ PASS |
| 14 | WARNING_ONLY → review_required=true | ✓ PASS |
| 15 | WARNING_ONLY → production_certified=false | ✓ PASS |
| 16 | WARNING_ONLY → fatal_document_failure=false preserved | ✓ PASS |
| 17 | pdfimages semantic_status=WARNING_ONLY preserved | ✓ PASS |
| 18 | pdfimages not classified as fatal | ✓ PASS |
| 19 | PDF_FONT_WEIGHT_WARNING preserved in customer view (safe class) | ✓ PASS |
| 20 | FAILED_FATAL preserved as fatal | ✓ PASS |
| 21 | fatal_document_failure=true → degraded_but_usable forced false | ✓ PASS |
| 22 | fatal_document_failure=true → review_required=true | ✓ PASS |
| 23 | fatal_document_failure=true → production_certified=false | ✓ PASS |
| 24 | fatal_document_failure=true → certified.pdf not allowed | ✓ PASS |
| 25 | degraded_but_usable=true preserved (not fatal) | ✓ PASS |
| 26 | degraded_but_usable=true → review_required=true (review route, not auto-fail) | ✓ PASS |
| 27 | degraded_but_usable=true → production_certified=false (no auto-certify) | ✓ PASS |
| 28 | customer payload has no evidence field content | ✓ PASS |
| 29 | customer payload contains no local filesystem paths | ✓ PASS |
| 30 | customer payload contains no raw object IDs | ✓ PASS |
| 31 | customer payload production_certified=false | ✓ PASS |
| 32 | customer payload standard_certified=false | ✓ PASS |
| 33 | customer payload compliance_claim_allowed=false | ✓ PASS |
| 34 | operator payload preserves raw_status | ✓ PASS |
| 35 | operator payload preserves all warning_classes | ✓ PASS |
| 36 | operator payload includes evidence excerpt | ✓ PASS |
| 37 | operator payload has more detail than customer payload | ✓ PASS |
| 38 | review_required=true → certified.pdf downgraded (certifiedPdfAllowed=false) | ✓ PASS |
| 39 | review_required=true → production_certified=false even if artifact_trust said true | ✓ PASS |
| 40 | review_required=true → standard_certified=false even if artifact_trust said true | ✓ PASS |
| 41 | customer: production_certified=false | ✓ PASS |
| 42 | customer: standard_certified=false | ✓ PASS |
| 43 | customer: pdfx_compliance_claimed=false | ✓ PASS |
| 44 | customer: pdfa_compliance_claimed=false | ✓ PASS |
| 45 | customer: compliance_claim_allowed=false | ✓ PASS |
| 46 | operator: production_certified=false | ✓ PASS |
| 47 | operator: compliance_claim_allowed=false | ✓ PASS |
| 48 | raw transcript exceeds 500 chars (sanity check) | ✓ PASS |
| 49 | customer payload contains no evidence at all | ✓ PASS |
| 50 | operator payload truncates huge transcript | ✓ PASS |
| 51 | operator payload truncation marker present | ✓ PASS |
| 52 | operator payload redacts local paths from transcript | ✓ PASS |
| 53 | legacy payload normalizes without error | ✓ PASS |
| 54 | legacy payload heavy_pdf_probe_governance=undefined | ✓ PASS |
| 55 | normalizeHeavyPdfProbeGovernance(undefined) returns null | ✓ PASS |
| 56 | normalizeHeavyPdfProbeGovernance({}) returns null | ✓ PASS |
| 57 | legacy payload → no heavy PDF block | ✓ PASS |
| 58 | legacy payload → production_certified unchanged (true) | ✓ PASS |
| 59 | empty audit data → available=false | ✓ PASS |
| 60 | null audit data → available=false | ✓ PASS |
| 61 | delta_report.heavy_pdf_probe_governance preserved | ✓ PASS |
| 62 | delta_report.heavy_pdf_probe_governance.review_required preserved | ✓ PASS |
| 63 | All 62F-B scenarios successfully normalized | ✓ PASS |
| 64 | No heavy_pdf_probe_governance scenario overclaims production/standards | ✓ PASS |
| 65 | fatal_document_failure=true always blocks production end-to-end | ✓ PASS |
