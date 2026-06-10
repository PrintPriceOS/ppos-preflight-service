# Phase 72C — Service Policy Profile Exposure

**Generated:** 2026-06-10T18:51:29.901Z  
**Smoke:** ✅ PASSED  
**Results:** 36/36 passed

## Changes
- `FixAuditNormalizer.js` — `policy_profile_governance` passthrough added (primary + `delta_report`)

## Test Results
| # | Test | Pass |
|---|------|------|
| 1 | 1.1 policy_profile_governance present in normalized output | ✅ |
| 2 | 1.1 profile_id preserved | ✅ |
| 3 | 1.1 profile_passed preserved | ✅ |
| 4 | 1.1 profile_blockers preserved (empty) | ✅ |
| 5 | 1.1 profile_warnings preserved | ✅ |
| 6 | 1.2 blocked profile_id preserved | ✅ |
| 7 | 1.2 profile_passed=false preserved | ✅ |
| 8 | 1.2 PROFILE_BLEED_REQUIRED preserved | ✅ |
| 9 | 1.2 PROFILE_NO_JAVASCRIPT_VIOLATED preserved | ✅ |
| 10 | 1.3 Normalizer returns without crash when policy_profile_governance absent | ✅ |
| 11 | 1.3 policy_profile_governance absent when not in audit data | ✅ |
| 12 | 2.1 delta_report present | ✅ |
| 13 | 2.1 delta_report.policy_profile_governance present | ✅ |
| 14 | 2.1 delta profile_id preserved | ✅ |
| 15 | 2.1 delta profile_passed=false preserved | ✅ |
| 16 | 2.2 Normalizer handles absent delta_report.policy_profile_governance without crash | ✅ |
| 17 | 3.1 OFFSET_STANDARD: production_certified=false after normalization | ✅ |
| 18 | 3.2 OFFSET_STANDARD: standard_certified=false after normalization | ✅ |
| 19 | 3.3 OFFSET_STANDARD: compliance_claim_allowed=false after normalization | ✅ |
| 20 | 3.4 OFFSET_STANDARD: print_ready_claim_allowed=false after normalization | ✅ |
| 21 | 3.1 PDFX4_STRICT: production_certified=false after normalization | ✅ |
| 22 | 3.2 PDFX4_STRICT: standard_certified=false after normalization | ✅ |
| 23 | 3.3 PDFX4_STRICT: compliance_claim_allowed=false after normalization | ✅ |
| 24 | 3.4 PDFX4_STRICT: print_ready_claim_allowed=false after normalization | ✅ |
| 25 | 4.1 profile_id is string | ✅ |
| 26 | 4.2 profile_label is string | ✅ |
| 27 | 4.3 profile_passed is boolean | ✅ |
| 28 | 4.4 profile_blockers is array | ✅ |
| 29 | 4.5 profile_warnings is array | ✅ |
| 30 | 4.6 evaluated_at is string | ✅ |
| 31 | 5.1 Real governance: no production_certified=true | ✅ |
| 32 | 5.2 Real governance: no standard_certified=true | ✅ |
| 33 | 5.3 Real governance: no compliance_claim_allowed=true | ✅ |
| 34 | 6.1 FixAuditNormalizer has policy_profile_governance passthrough | ✅ |
| 35 | 6.2 FixAuditNormalizer has Phase 72 annotation | ✅ |
| 36 | 6.3 delta_report.policy_profile_governance passthrough | ✅ |
