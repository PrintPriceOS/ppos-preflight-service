# PRINTPRICE OS — Certification & Verification Guide (v2.0.0)

## 🎯 Objective
Certify that the **Enterprise Governance & Traceability Baseline** (Phase 1-7) is production-hardened, isolated, and resilient.

---

## 🛠️ Environment Setup & Safety

### 1. Test Isolation
- Always use specific test tenants (`tenant-a`, `tenant-b`) to avoid production data corruption.
- The certification runner uses mock tokens with these specifically scoped identities.

### 2. Prerequisites
- `node` 18+
- `fastify`, `axios`, `form-data`, `fs-extra` installed (`npm install`).
- MySQL running with the Phase 3+ schema.
- `ppos-preflight-service` and `ppos-preflight-worker` active (ports 8001/8002).

---

## 🚀 Execution Workflow

### Batch 1 (Core Integrity)
```bash
node certification/scripts/cert-runner.js
```
*Evaluates: Isolation, Auth, Authz, Governance.*

### Batch 2 (Traceability & Forensics)
```bash
node certification/scripts/traceability-verif.js
```
*Evaluates: Audit lifecycle integrity and forensic readiness.*

### Batch 3 (Chaos & Storage)
```bash
# Verify resilience under process restarts
node certification/scripts/chaos-verif.js

# Verify storage boundaries
node certification/scripts/storage-verif.js
```
*Evaluates: PM2 recovery, path traversal, tenant-escape.*

---

## 📦 Final Certification Verdict
To run a consolidated evaluation of ALL metrics and produce the final status:
```bash
node certification/scripts/final-evaluator.js
```

### Verdict Taxonomy:
- **🌟 CERTIFIED (Level 1 Foundation)**: All core metrics pass.
- **⚠️ CONDITIONAL PASS**: Minor gaps or non-critical audit issues.
- **❌ FAILED (Non-Compliant)**: Any isolation breach, auth bypass, or orphan detected.

---
*Signed by PrintPrice OS Infrastructure Team*
