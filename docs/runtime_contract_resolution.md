# Runtime Contract Resolution: PrintPrice OS Preflight

This document explains how the Preflight Service resolves the **Deployment Contract** at runtime to ensure stability across different environments (Docker vs local development).

## Resolution Strategy

The service uses a **deterministic dual-path fallback strategy** implemented in `loadDeploymentContext.js`. It attempts to load `deployment_contract.json` from the following locations in order:

1.  **Environment Variable**: `PPOS_SHARED_CONTRACTS_PATH` (if defined).
2.  **Primary Canonical Path**: `/app/ppos-shared-contracts/contracts/`
3.  **Docker Build Fallback**: `/app/staged-libs/ppos-shared-contracts/contracts/`
4.  **Local Development Fallback**: Relative path from `src/auth/` (`../../../ppos-shared-contracts/contracts`)

## Container Structure

To minimize reliance on fallbacks, the `Dockerfile` for the Preflight Service has been hardened to normalize the file structure during the build process:

- During the build, `contracts.tgz` is extracted directly into `/app/ppos-shared-contracts/`.
- This ensures that the **Primary Canonical Path** is always populated in the production image.

## Diagnostic Logging

On service startup, the following log marker indicates the resolution result:

```text
[DEPLOYMENT-CONTRACT] Resolved at: /app/ppos-shared-contracts/contracts/deployment_contract.json (fallback_used: false)
```

If resolution fails, the service will throw an explicit error listing all attempted paths and the current process context (`CWD`, `__dirname`) to facilitate rapid debugging.
