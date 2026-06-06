# Phase 56E.3 Service Artifact Trust Regression Report

## Summary
- All Passed: true

## Scenario Results
### 1. certified.pdf filename only
- **Pass**: true
- **Primary Artifact**: certified_pdf (undefined)
- **Production Certified**: false
- **Standard Certified**: undefined
- **Notes**: As expected

### 2. review_pdf primary
- **Pass**: true
- **Primary Artifact**: review_pdf (undefined)
- **Production Certified**: false
- **Standard Certified**: false
- **Notes**: As expected

### 3. fixed_pdf primary
- **Pass**: true
- **Primary Artifact**: fixed_pdf (undefined)
- **Production Certified**: false
- **Standard Certified**: false
- **Notes**: As expected

### 4. certified_pdf production-certified but not standards-certified
- **Pass**: true
- **Primary Artifact**: certified_pdf (undefined)
- **Production Certified**: true
- **Standard Certified**: false
- **Notes**: As expected

### 5. certified_pdf standards-certified with complete evidence
- **Pass**: true
- **Primary Artifact**: certified_pdf (undefined)
- **Production Certified**: true
- **Standard Certified**: true
- **Notes**: As expected

### 6. standards claim without evidence
- **Pass**: true
- **Primary Artifact**: certified_pdf (undefined)
- **Production Certified**: true
- **Standard Certified**: false
- **Notes**: As expected

### 7. OutputIntent warning
- **Pass**: true
- **Primary Artifact**: fixed_pdf (undefined)
- **Production Certified**: false
- **Standard Certified**: false
- **Notes**: As expected

### 8. governance blockers
- **Pass**: true
- **Primary Artifact**: review_pdf (undefined)
- **Production Certified**: false
- **Standard Certified**: false
- **Notes**: As expected

### 9. artifact_trust absent
- **Pass**: true
- **Primary Artifact**: certified_pdf (undefined)
- **Production Certified**: false
- **Standard Certified**: false
- **Notes**: As expected

### 10. false incoming metadata conflict
- **Pass**: true
- **Primary Artifact**: fixed_pdf (undefined)
- **Production Certified**: false
- **Standard Certified**: false
- **Notes**: As expected

