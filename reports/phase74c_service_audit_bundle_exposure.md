# Phase 74C — Service Audit Bundle Exposure

**Generated:** 2026-06-15T18:50:50.642Z  
**Repo:** ppos-preflight-service  
**Input mode:** WORKER_REPORT  
**Smoke:** ✓ PASSED  
**Results:** 60/60 passed

## Core Principle

> audit_bundle_governance is a defensible compliance/export manifest summarizing fix_audit/delta_report hashes, governance domain coverage, and artifact_trust. It is never a certification authority: production_certified and standard_certified are always forced to false at the Service exposure layer regardless of upstream values, and the governance does not influence the Service's own production_certified/review_required gates. The audit_bundle.json artifact (when present) is exposed as a downloadable governed artifact via the existing artifact endpoint.

## Changes

- FixAuditNormalizer.js: audit_bundle_governance preserved in v2 normalization (root)
- FixAuditNormalizer.js: delta_report.audit_bundle_governance preserved
- FixCapabilityContract.js: version bumped to 52.0, engine_registry_compatibility=phase-74
- FixCapabilityContract.js: AUDIT_BUNDLE_CONTRACT and GENERATE_AUDIT_BUNDLE_MANIFEST capabilities added under audit_bundle category
- PreflightService.js: audit_bundle_governance governance sources resolved in getJobArtifacts after machine readiness governance block
- PreflightService.js: audit_bundle.json recognized as a governed AUDIT_BUNDLE artifact in getJobArtifacts file discovery
- PreflightService.js: artifact_summary.audit_bundle_available and artifact_summary.audit_bundle_governance exposed (PHYSICAL_OUTPUT_FALLBACK path) with production_certified/standard_certified forced to false
- PreflightService.js: Phase 74C exposure block added in _normalizeJobPayload before artifact_summary construction
- PreflightService.js: audit_bundle_governance and audit_bundle_available added to artifact_summary and return payload in _normalizeJobPayload
- routes/preflight.js: resolveArtifactByAlias extended with audit_bundle -> audit_bundle.json for governed artifact download

## Scenarios

| # | Scenario | Result |
|---|----------|--------|
| 1 | FixCapabilityContract version >= 52.0 | ✓ PASS |
| 2 | engine_registry_compatibility=phase-74 | ✓ PASS |
| 3 | AUDIT_BUNDLE_CONTRACT capability present | ✓ PASS |
| 4 | GENERATE_AUDIT_BUNDLE_MANIFEST capability present | ✓ PASS |
| 5 | AUDIT_BUNDLE_CONTRACT category=audit_bundle | ✓ PASS |
| 6 | AUDIT_BUNDLE_CONTRACT production_certified=false | ✓ PASS |
| 7 | AUDIT_BUNDLE_CONTRACT standard_certified=false | ✓ PASS |
| 8 | AUDIT_BUNDLE_CONTRACT compliance_claim_allowed=false | ✓ PASS |
| 9 | AUDIT_BUNDLE_CONTRACT requires_human_review=true | ✓ PASS |
| 10 | Phase 71 capabilities still present (regression) | ✓ PASS |
| 11 | Phase 70 capabilities still present (regression) | ✓ PASS |
| 12 | Phase 68 capabilities still present (regression) | ✓ PASS |
| 13 | audit_bundle_governance preserved at root | ✓ PASS |
| 14 | bundle_ready preserved | ✓ PASS |
| 15 | fix_audit_hash preserved | ✓ PASS |
| 16 | delta_report_hash preserved | ✓ PASS |
| 17 | governance_domains_included preserved | ✓ PASS |
| 18 | artifact_trust preserved | ✓ PASS |
| 19 | evidence preserved | ✓ PASS |
| 20 | delta_report.audit_bundle_governance preserved | ✓ PASS |
| 21 | delta_report.audit_bundle_governance.fix_audit_hash preserved | ✓ PASS |
| 22 | delta_report.audit_bundle_governance.governance_domains_included preserved | ✓ PASS |
| 23 | exposed present | ✓ PASS |
| 24 | bundle_ready=true | ✓ PASS |
| 25 | fix_audit_hash exposed | ✓ PASS |
| 26 | delta_report_hash exposed | ✓ PASS |
| 27 | governance_domains_included exposed | ✓ PASS |
| 28 | artifact_trust exposed | ✓ PASS |
| 29 | production_certified=false | ✓ PASS |
| 30 | standard_certified=false | ✓ PASS |
| 31 | exposed present | ✓ PASS |
| 32 | bundle_ready=false | ✓ PASS |
| 33 | fix_audit_hash=null | ✓ PASS |
| 34 | delta_report_hash=null | ✓ PASS |
| 35 | governance_domains_included empty | ✓ PASS |
| 36 | warnings preserved | ✓ PASS |
| 37 | production_certified forced to false | ✓ PASS |
| 38 | standard_certified forced to false | ✓ PASS |
| 39 | no audit_bundle_governance -> undefined in normalized | ✓ PASS |
| 40 | no audit_bundle_governance -> exposed undefined | ✓ PASS |
| 41 | Empty audit data → available=false | ✓ PASS |
| 42 | Null audit data → available=false | ✓ PASS |
| 43 | production_certified at root unaffected by audit_bundle_governance | ✓ PASS |
| 44 | artifact_trust.production_certified unaffected | ✓ PASS |
| 45 | artifact_trust.review_required unaffected | ✓ PASS |
| 46 | audit_bundle_governance contains no local filesystem paths | ✓ PASS |
| 47 | FixAuditNormalizer has audit_bundle_governance passthrough | ✓ PASS |
| 48 | FixAuditNormalizer has Phase 74 annotation | ✓ PASS |
| 49 | delta_report.audit_bundle_governance passthrough present | ✓ PASS |
| 50 | PreflightService resolves audit_bundle_governance sources | ✓ PASS |
| 51 | PreflightService exposes audit_bundle_governance in artifact_summary | ✓ PASS |
| 52 | PreflightService exposes audit_bundle_governance at root payload | ✓ PASS |
| 53 | PreflightService recognizes audit_bundle.json as a governed artifact | ✓ PASS |
| 54 | PreflightService exposes audit_bundle_available in artifact_summary | ✓ PASS |
| 55 | resolveArtifactByAlias candidateTypes includes audit_bundle | ✓ PASS |
| 56 | resolveArtifactByAlias candidateFilenames includes audit_bundle.json | ✓ PASS |
| 57 | All 74B scenarios successfully normalized | ✓ PASS |
| 58 | Governance invariants hold for all 74B scenarios | ✓ PASS |
| 59 | hashes preserved across 74B scenarios | ✓ PASS |
| 60 | governance_domains_included preserved across 74B scenarios | ✓ PASS |
