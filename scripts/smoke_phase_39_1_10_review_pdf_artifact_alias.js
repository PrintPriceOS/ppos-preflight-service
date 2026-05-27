const assert = require('assert');

// Simple mock of the function to test its standalone behavior
function resolveArtifactByAlias({ artifacts, artifactList, requestedKey, requiresReview, productionCertified }) {
    const candidateTypes = {
        review_pdf: ['review_pdf', 'final_fixed_pdf', 'fixed_pdf', 'normalized_pdf'],
        final_fixed_pdf: ['final_fixed_pdf', 'fixed_pdf', 'normalized_pdf', 'certified_pdf'],
        fixed_pdf: ['fixed_pdf', 'final_fixed_pdf'],
        normalized_pdf: ['normalized_pdf', 'fixed_pdf', 'final_fixed_pdf'],
        certified_pdf: ['certified_pdf'],
        fix_audit: ['fix_audit'],
        analysis_report: ['analysis_report', 'report_json'],
        report_json: ['analysis_report', 'report_json']
    };

    const candidateFilenames = {
        review_pdf: ['fixed.pdf', 'normalized.pdf'],
        final_fixed_pdf: ['fixed.pdf', 'normalized.pdf', 'certified.pdf'],
        fixed_pdf: ['fixed.pdf', 'normalized.pdf'],
        normalized_pdf: ['normalized.pdf', 'fixed.pdf'],
        certified_pdf: ['certified.pdf'],
        fix_audit: ['fix_audit.json'],
        analysis_report: ['report.json'],
        report_json: ['report.json']
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

const report = {
  type: "AUTOFIX",
  status: "AUTOFIX_PARTIAL",
  productionCertified: false,
  requiresHumanReview: true,
  artifacts: {
    fix_audit: "fix_audit.json",
    fixed_pdf: "fixed.pdf",
    final_fixed_pdf: "fixed.pdf",
    review_pdf: "fixed.pdf"
  },
  artifactList: [
    { type: "fix_audit", name: "fix_audit.json" },
    { type: "fixed_pdf", name: "fixed.pdf" },
    { type: "final_fixed_pdf", name: "fixed.pdf" },
    { type: "review_pdf", name: "fixed.pdf" }
  ]
};

console.log('Running resolver regression tests...');

// A. resolveArtifactByAlias returns fixed.pdf
const resA = resolveArtifactByAlias({ 
    artifacts: report.artifacts, 
    artifactList: report.artifactList, 
    requestedKey: "review_pdf", 
    requiresReview: report.requiresHumanReview, 
    productionCertified: report.productionCertified 
});
assert.strictEqual(resA.filename, "fixed.pdf", "A failed");

// B. review_pdf is missing but fixed_pdf exists
const resB = resolveArtifactByAlias({ 
    artifacts: { fixed_pdf: "fixed.pdf" }, 
    artifactList: [{ type: "fixed_pdf", name: "fixed.pdf" }], 
    requestedKey: "review_pdf", 
    requiresReview: true, 
    productionCertified: false 
});
assert.strictEqual(resB.filename, "fixed.pdf", "B failed");

// C. review_pdf is missing but final_fixed_pdf exists
const resC = resolveArtifactByAlias({ 
    artifacts: { final_fixed_pdf: "fixed.pdf" }, 
    artifactList: [{ type: "final_fixed_pdf", name: "fixed.pdf" }], 
    requestedKey: "review_pdf", 
    requiresReview: true, 
    productionCertified: false 
});
assert.strictEqual(resC.filename, "fixed.pdf", "C failed");

// D. only certified_pdf exists and requiresReview=true -> must not resolve to certified.pdf
const resD = resolveArtifactByAlias({ 
    artifacts: { certified_pdf: "certified.pdf" }, 
    artifactList: [{ type: "certified_pdf", name: "certified.pdf" }], 
    requestedKey: "review_pdf", 
    requiresReview: true, 
    productionCertified: false 
});
assert.strictEqual(resD, null, "D failed");

// E. certified_pdf resolves to certified.pdf only when requested
const resE = resolveArtifactByAlias({ 
    artifacts: { certified_pdf: "certified.pdf" }, 
    artifactList: [{ type: "certified_pdf", name: "certified.pdf" }], 
    requestedKey: "certified_pdf", 
    requiresReview: true, 
    productionCertified: false 
});
assert.strictEqual(resE.filename, "certified.pdf", "E failed");

// F. unknown artifact returns null
const resF = resolveArtifactByAlias({ 
    artifacts: report.artifacts, 
    artifactList: report.artifactList, 
    requestedKey: "unknown_pdf", 
    requiresReview: true, 
    productionCertified: false 
});
assert.strictEqual(resF, null, "F failed");

console.log('All tests passed.');
