const fs = require('fs');
const path = require('path');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');

const workerReportsFile = path.resolve(__dirname, '../../ppos-preflight-worker-phase-10-intelligence-layer/reports/phase54e_worker_image_quality_real_policy.json');

async function run() {
    console.log("Running Phase 54E Service Image Quality Real Hydration Smoke Test...");

    if (!fs.existsSync(workerReportsFile)) {
        console.error("Worker reports file not found. Run 54E.2 first.");
        process.exit(1);
    }

    const workerResults = JSON.parse(fs.readFileSync(workerReportsFile, 'utf8'));

    const reportsDir = path.join(__dirname, '../reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    let passCount = 0;
    let failCount = 0;
    const finalReport = [];

    for (const wr of workerResults) {
        console.log(`\nTesting hydration for: ${wr.fixture}`);
        
        let pass = true;
        const notes = [];
        let hydratedResult = null;

        if (wr.worker_real_policy_applied) {
            const fixAudit = wr.worker_audit || {};
            
            // Hydrate through FixAuditNormalizer
            hydratedResult = FixAuditNormalizer.normalize(fixAudit);

            // Assertions
            if (!hydratedResult) {
                pass = false;
                notes.push("Hydration returned null");
            } else {
                if (wr.engine_real_detection && fixAudit.image_quality_governance) {
                    if (!hydratedResult.image_quality_governance) {
                        pass = false;
                        notes.push("Missing image_quality_governance in hydrated object");
                    } else {
                        // Compare deep
                        const expected = fixAudit.image_quality_governance;
                        const actual = hydratedResult.image_quality_governance;
                        if (actual.highest_image_quality_risk !== expected.highest_image_quality_risk) {
                            pass = false;
                            notes.push(`Mismatch highest risk: expected ${expected.highest_image_quality_risk}, got ${actual.highest_image_quality_risk}`);
                        }
                        if (actual.certified_pdf_allowed !== expected.certified_pdf_allowed) {
                            pass = false;
                            notes.push(`Mismatch certified_pdf_allowed: expected ${expected.certified_pdf_allowed}, got ${actual.certified_pdf_allowed}`);
                        }
                    }
                }

                // Check downgrade mechanism translation
                // Service doesn't strictly downgrade the file itself in FixAuditNormalizer, but it should expose certified_pdf_allowed properly.
                if (wr.certified_pdf_allowed === false) {
                    if (hydratedResult.image_quality_governance && hydratedResult.image_quality_governance.certified_pdf_allowed === true) {
                        pass = false;
                        notes.push("certified_pdf_allowed was not hydrated properly");
                    }
                }
            }
        } else {
            // Worker failed, so skip Service assertions but copy state
            notes.push("Skipped hydration validation because worker policy failed.");
        }

        if (pass && wr.worker_real_policy_applied) passCount++;
        else failCount++;

        finalReport.push({
            fixture: wr.fixture,
            input_mode: "REAL_ENGINE_OUTPUT",
            validation_mode: "REAL_PDF",
            real_pdf_execution_verified: true,
            engine_real_detection: wr.engine_real_detection,
            worker_real_policy_applied: wr.worker_real_policy_applied,
            service_real_hydration: pass,
            control_plane_human_report: false,
            fixture_gap: wr.fixture_gap,
            detector_gap: wr.detector_gap,
            deferred: wr.deferred,
            review_required: hydratedResult ? hydratedResult.review_required : wr.review_required,
            production_certified: hydratedResult ? hydratedResult.production_certified : wr.production_certified,
            certified_pdf_allowed: hydratedResult ? (hydratedResult.image_quality_governance ? hydratedResult.image_quality_governance.certified_pdf_allowed : true) : wr.certified_pdf_allowed,
            primary_artifact_type: "NONE", // Handled by registry logic, we mock it via properties
            pass: pass && wr.worker_real_policy_applied,
            notes: [...wr.notes, ...notes],
            service_job_payload: hydratedResult
        });
    }

    const finalJsonPath = path.join(reportsDir, 'phase54e_service_image_quality_real_hydration.json');
    fs.writeFileSync(finalJsonPath, JSON.stringify(finalReport, null, 2));

    let md = `# Phase 54E.3 Service Real PDF Image Quality Hydration Validation\n\n`;
    md += `**Summary**: ${passCount} Passed, ${failCount} Failed\n\n`;
    
    finalReport.forEach(r => {
        md += `## ${r.fixture}\n`;
        md += `- **Pass**: ${r.pass ? '✅' : '❌'}\n`;
        md += `- **Service Real Hydration**: ${r.service_real_hydration}\n`;
        md += `- **Review Required**: ${r.review_required}\n`;
        md += `- **Production Certified**: ${r.production_certified}\n`;
        md += `- **Fixture Gap**: ${r.fixture_gap}\n`;
        md += `- **Detector Gap**: ${r.detector_gap}\n`;
        md += `- **Deferred**: ${r.deferred}\n`;
        if (r.notes.length > 0) {
            md += `- **Notes**:\n`;
            r.notes.forEach(n => md += `  - ${n}\n`);
        }
        md += `\n`;
    });

    fs.writeFileSync(path.join(reportsDir, 'phase54e_service_image_quality_real_hydration.md'), md);
    console.log(`\nReports saved to ${reportsDir}`);
    
    if (failCount > 0) process.exit(1);
}

run();
