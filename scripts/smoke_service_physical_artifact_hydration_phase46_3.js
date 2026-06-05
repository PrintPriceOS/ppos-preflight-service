const fs = require('fs/promises');
const path = require('path');
const PreflightService = require('../services/PreflightService');
const db = require('../src/services/db');

async function setupFixtures() {
    const tempRoot = path.join(__dirname, '..', '.tmp_smoke_hydration_3');
    process.env.PPOS_STORAGE_BASE = tempRoot;

    const tenantId = 'ppos-production';
    const jobId = 'fix_test_3';
    const outputDir = path.join(tempRoot, 'tenants', tenantId, 'jobs', jobId, 'output');
    
    await fs.mkdir(outputDir, { recursive: true });

    await fs.writeFile(path.join(outputDir, 'fixed.pdf'), Buffer.from('%PDF-1.4\n...'));
    await fs.writeFile(path.join(outputDir, 'certified.pdf'), Buffer.from('%PDF-1.4\n...'));

    const fixAudit = {
        version: "2.0",
        requested_fixes: ["APPLY_BLEED"],
        applied_fixes: [{ code: "APPLY_BLEED", status: "APPLIED" }],
        skipped_fixes: [],
        failed_fixes: [],
        review_required: true,
        production_certified: false,
        artifact_policy: {
            certified_pdf: false,
            delta_report: true
        }
    };
    await fs.writeFile(path.join(outputDir, 'fix_audit.json'), JSON.stringify(fixAudit, null, 2));

    const deltaReport = {
        changed: true,
        changes: []
    };
    await fs.writeFile(path.join(outputDir, 'delta_report.json'), JSON.stringify(deltaReport, null, 2));

    return tempRoot;
}

function resolveTenantId(request, auth) {
    const tenantId = request.headers['x-tenant-id'] || 
                     request.headers['X-Tenant-ID'] || 
                     auth?.tenantId || 
                     auth?.tenant_id || 
                     request.user?.tenant_id || 
                     request.user?.tenantId || 
                     "ppos-production";
    return tenantId;
}

function resolveArtifactByAlias({ artifacts, artifactList, requestedKey, requiresReview, productionCertified }) {
    const candidateTypes = {
        review_pdf: ['review_pdf', 'final_fixed_pdf', 'fixed_pdf', 'normalized_pdf'],
        final_fixed_pdf: ['final_fixed_pdf', 'fixed_pdf', 'normalized_pdf', 'certified_pdf'],
        fixed_pdf: ['fixed_pdf', 'final_fixed_pdf'],
        normalized_pdf: ['normalized_pdf', 'fixed_pdf', 'final_fixed_pdf'],
        certified_pdf: ['certified_pdf'],
        fix_audit: ['fix_audit'],
        analysis_report: ['analysis_report', 'report_json'],
        report_json: ['analysis_report', 'report_json'],
        delta_report: ['delta_report']
    };

    const candidateFilenames = {
        review_pdf: ['fixed.pdf', 'normalized.pdf'],
        final_fixed_pdf: ['fixed.pdf', 'normalized.pdf', 'certified.pdf'],
        fixed_pdf: ['fixed.pdf', 'normalized.pdf'],
        normalized_pdf: ['normalized.pdf', 'fixed.pdf'],
        certified_pdf: ['certified.pdf'],
        fix_audit: ['fix_audit.json'],
        analysis_report: ['report.json'],
        report_json: ['report.json'],
        delta_report: ['delta_report.json']
    };

    let resolvedType = null;
    let resolvedFilename = null;

    const types = candidateTypes[requestedKey];
    const filenames = candidateFilenames[requestedKey];

    if (types && filenames) {
        if (artifacts && typeof artifacts === 'object') {
            for (const t of types) {
                if (artifacts[t]) {
                    resolvedType = t;
                    resolvedFilename = artifacts[t];
                    break;
                }
            }
        }
        if (!resolvedFilename && artifactList && Array.isArray(artifactList)) {
            for (const t of types) {
                const found = artifactList.find(a => a.type === t);
                if (found) {
                    resolvedType = t;
                    resolvedFilename = found.name;
                    break;
                }
            }
        }
        if (!resolvedFilename && artifactList && Array.isArray(artifactList)) {
            for (const f of filenames) {
                const found = artifactList.find(a => a.name === f);
                if (found) {
                    resolvedType = found.type;
                    resolvedFilename = f;
                    break;
                }
            }
        }
    }

    if (!resolvedFilename && artifactList && Array.isArray(artifactList)) {
        const found = artifactList.find(a => a.id === requestedKey || a.name === requestedKey || a.type === requestedKey);
        if (found) {
            resolvedType = found.type;
            resolvedFilename = found.name;
        }
    }

    if (requestedKey === 'review_pdf' && requiresReview && resolvedFilename === 'certified.pdf') {
        resolvedFilename = null;
        resolvedType = null;
    }
    if (requestedKey === 'review_pdf' && productionCertified === false && resolvedFilename === 'certified.pdf') {
        resolvedFilename = null;
        resolvedType = null;
    }
    if (requestedKey === 'certified_pdf' && requiresReview && resolvedFilename === 'fixed.pdf') {
        resolvedFilename = null;
        resolvedType = null;
    }

    if (resolvedFilename) {
        return {
            requestedKey,
            resolvedKey: resolvedType || requestedKey,
            filename: resolvedFilename,
            name: resolvedFilename,
            type: resolvedType || requestedKey,
            source: 'artifacts'
        };
    }
    return null;
}

function assertTrue(label, condition) {
    if (!condition) {
        console.error(`[FAIL] ${label}`);
        throw new Error(`Assertion failed: ${label}`);
    }
    console.log(`[PASS] ${label}`);
}

async function runSmokeTests() {
    let passed = 0;
    const tempRoot = await setupFixtures();
    const service = new PreflightService();

    const originalQuery = db.query;
    const originalExecute = db.execute;

    db.query = async (sql, params) => {
        if (params && params[0] === 'fix_test_3') return [[]];
        return [[]];
    };
    db.execute = async () => [{}];

    try {
        console.log("Running Phase 46.3 Smoke Tests...");

        // A. Direct service call getJobArtifacts returns >= 4 physical artifacts inside object wrapper
        const artifactRes = await service.getJobArtifacts('fix_test_3', 'ppos-production');
        assertTrue("getJobArtifacts returns an object with ok=true", artifactRes && artifactRes.ok === true);
        assertTrue("getJobArtifacts returns artifacts array", Array.isArray(artifactRes.artifacts));
        assertTrue("getJobArtifacts returned >= 4 artifacts", artifactRes.artifacts.length >= 4);
        assertTrue("getJobArtifacts returned artifact_summary", artifactRes.artifact_summary && typeof artifactRes.artifact_summary === 'object');
        assertTrue("artifact_summary.physical_artifacts_ready = true", artifactRes.artifact_summary.physical_artifacts_ready === true);
        assertTrue("source_status = PHYSICAL_OUTPUT_FALLBACK", artifactRes.source_status === "PHYSICAL_OUTPUT_FALLBACK");

        passed += 6;

        // B. Route-equivalent wrapper
        const req = {
            headers: { 'x-tenant-id': 'custom-tenant-xyz' },
            context: { auth: { tenantId: 'fallback-tenant' } }
        };
        const tenant = resolveTenantId(req, req.context.auth);
        assertTrue("Tenant resolver prioritizes header", tenant === 'custom-tenant-xyz');
        passed++;

        // C. Download alias matching
        const jobStatus = await service.getJobStatus('fix_test_3', { auth: { tenantId: 'ppos-production' } });
        const requiresReview = jobStatus.review_required;
        const productionCertified = jobStatus.production_certified;
        const artifactList = artifactRes.artifacts;

        const aliases = ['fixed_pdf', 'certified_pdf', 'fix_audit', 'delta_report'];
        const resolvedFiles = [];
        
        for (const alias of aliases) {
            const resolved = resolveArtifactByAlias({
                artifacts: jobStatus.artifacts || {},
                artifactList,
                requestedKey: alias,
                requiresReview,
                productionCertified
            });
            assertTrue(`Alias ${alias} resolved to something`, resolved !== null);
            resolvedFiles.push(resolved.filename);
        }

        assertTrue("fixed_pdf resolved to fixed.pdf", resolvedFiles[0] === 'fixed.pdf');
        assertTrue("certified_pdf resolved to certified.pdf", resolvedFiles[1] === 'certified.pdf');
        assertTrue("fix_audit resolved to fix_audit.json", resolvedFiles[2] === 'fix_audit.json');
        assertTrue("delta_report resolved to delta_report.json", resolvedFiles[3] === 'delta_report.json');
        passed += 8;

    } catch (e) {
        console.error("\nSmoke test execution failed:", e);
        process.exitCode = 1;
    } finally {
        db.query = originalQuery;
        db.execute = originalExecute;
        try {
            await fs.rm(tempRoot, { recursive: true, force: true });
        } catch(e) {}
    }

    if (process.exitCode !== 1) {
        console.log(`\n--- Smoke Tests Completed ---`);
        console.log(`Passed: ${passed}`);
        console.log(`Failed: 0\n`);
    }
}

runSmokeTests();
