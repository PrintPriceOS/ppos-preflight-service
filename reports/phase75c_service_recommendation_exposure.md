# Phase 75C — Service Recommendation Exposure

**Generated:** 2026-06-15T20:00:29.715Z  
**Repo:** ppos-preflight-service  
**Input mode:** WORKER_REPORT  
**Smoke:** ✓ PASSED  
**Results:** 56/56 passed

## Core Principle

> recommendation_governance is an advisory signal set summarizing recommended_next_actions, unsafe_auto_actions, and human_review_actions derived from finding-level recommendation signals. It is never an authority: recommendation_authority, auto_apply_authority, production_certified, and standard_certified are always forced to false at the Service exposure layer regardless of upstream values, and the governance does not influence the Service's own production_certified/review_required gates. It is exposed in artifact_summary and the job payload (the source consumed downstream for the Human Report).

## Changes

- FixAuditNormalizer.js: recommendation_governance preserved in v2 normalization (root)
- FixAuditNormalizer.js: delta_report.recommendation_governance preserved
- FixCapabilityContract.js: version bumped to 53.0, engine_registry_compatibility=phase-75
- FixCapabilityContract.js: RECOMMENDATION_CONTRACT and GENERATE_RECOMMENDATION_MANIFEST capabilities added under recommendation category
- PreflightService.js: recommendation_governance governance sources resolved in getJobArtifacts after audit bundle governance block
- PreflightService.js: artifact_summary.recommendation_governance exposed (PHYSICAL_OUTPUT_FALLBACK path) with recommendation_authority/auto_apply_authority/production_certified/standard_certified forced to false
- PreflightService.js: Phase 75C exposure block added in _normalizeJobPayload after audit bundle governance exposure
- PreflightService.js: recommendation_governance added to artifact_summary and root payload in _normalizeJobPayload

## Scenarios

| # | Scenario | Result |
|---|----------|--------|
| 1 | FixCapabilityContract version >= 53.0 | ✓ PASS |
| 2 | engine_registry_compatibility=phase-75 | ✓ PASS |
| 3 | RECOMMENDATION_CONTRACT capability present | ✓ PASS |
| 4 | GENERATE_RECOMMENDATION_MANIFEST capability present | ✓ PASS |
| 5 | RECOMMENDATION_CONTRACT category=recommendation | ✓ PASS |
| 6 | RECOMMENDATION_CONTRACT production_certified=false | ✓ PASS |
| 7 | RECOMMENDATION_CONTRACT standard_certified=false | ✓ PASS |
| 8 | RECOMMENDATION_CONTRACT compliance_claim_allowed=false | ✓ PASS |
| 9 | RECOMMENDATION_CONTRACT requires_human_review=true | ✓ PASS |
| 10 | Phase 74 capabilities still present (regression) | ✓ PASS |
| 11 | Phase 73 capabilities still present (regression) | ✓ PASS |
| 12 | recommendation_governance preserved at root | ✓ PASS |
| 13 | recommendation_signals_available preserved | ✓ PASS |
| 14 | total_findings preserved | ✓ PASS |
| 15 | recommended_next_actions preserved | ✓ PASS |
| 16 | evidence preserved | ✓ PASS |
| 17 | delta_report.recommendation_governance preserved | ✓ PASS |
| 18 | delta_report.recommendation_governance.total_findings preserved | ✓ PASS |
| 19 | delta_report.recommendation_governance.recommended_next_actions preserved | ✓ PASS |
| 20 | exposed present | ✓ PASS |
| 21 | recommendation_signals_available=true | ✓ PASS |
| 22 | total_findings=3 | ✓ PASS |
| 23 | recommended_next_actions exposed | ✓ PASS |
| 24 | unsafe_auto_actions exposed | ✓ PASS |
| 25 | human_review_actions exposed | ✓ PASS |
| 26 | recommendation_authority=false | ✓ PASS |
| 27 | auto_apply_authority=false | ✓ PASS |
| 28 | production_certified=false | ✓ PASS |
| 29 | standard_certified=false | ✓ PASS |
| 30 | exposed present | ✓ PASS |
| 31 | total_findings=0 | ✓ PASS |
| 32 | recommended_next_actions empty | ✓ PASS |
| 33 | unsafe_auto_actions empty | ✓ PASS |
| 34 | human_review_actions empty | ✓ PASS |
| 35 | recommendation_authority forced to false | ✓ PASS |
| 36 | auto_apply_authority forced to false | ✓ PASS |
| 37 | production_certified forced to false | ✓ PASS |
| 38 | standard_certified forced to false | ✓ PASS |
| 39 | no recommendation_governance -> undefined in normalized | ✓ PASS |
| 40 | no recommendation_governance -> exposed undefined | ✓ PASS |
| 41 | Empty audit data → available=false | ✓ PASS |
| 42 | Null audit data → available=false | ✓ PASS |
| 43 | production_certified at root unaffected by recommendation_governance | ✓ PASS |
| 44 | artifact_trust.production_certified unaffected | ✓ PASS |
| 45 | artifact_trust.review_required unaffected | ✓ PASS |
| 46 | recommendation_governance contains no local filesystem paths | ✓ PASS |
| 47 | FixAuditNormalizer has recommendation_governance passthrough | ✓ PASS |
| 48 | FixAuditNormalizer has Phase 75 annotation | ✓ PASS |
| 49 | delta_report.recommendation_governance passthrough present | ✓ PASS |
| 50 | PreflightService resolves recommendation_governance sources | ✓ PASS |
| 51 | PreflightService exposes recommendation_governance in artifact_summary | ✓ PASS |
| 52 | PreflightService exposes recommendation_governance at root payload | ✓ PASS |
| 53 | All 75B scenarios successfully normalized | ✓ PASS |
| 54 | Governance invariants hold for all 75B scenarios | ✓ PASS |
| 55 | total_findings preserved across 75B scenarios | ✓ PASS |
| 56 | action lists preserved across 75B scenarios | ✓ PASS |
