const fs = require('fs-extra');
const path = require('path');
const PreflightService = require('../services/PreflightService');
const FixAuditNormalizer = require('../services/FixAuditNormalizer');

async function run() {
    console.log("Starting Phase 56E.3 Service Artifact Trust Regression Smoke Test...\n");

    const reportsDir = path.join(__dirname, '..', 'reports');
    await fs.ensureDir(reportsDir);

    const mockStorage = {
        getJobSubfolder: (tenantId, jobId, folder) => `/tmp/mock/${tenantId}/${jobId}/${folder}`
    };

    const db = require('../src/services/db');
    
    let mockJob = null;
    let mockResult = null;
    
    db.query = async (sql, params) => {
        if (sql.includes('SELECT id, status, job_type')) {
            return [[{ ...mockJob, result: mockResult }]];
        }
        return [[]];
    };
    db.execute = async () => [[]];

    const service = new PreflightService({}, {}, mockStorage);
    service._resolvePhysicalOutputDir = async () => '/tmp/mock/tenant_123/job_123/output';

    let mockFiles = [];
    let mockFixAudit = null;
    let mockDeltaReport = null;

    const originalReaddir = fs.readdir;
    const originalPathExists = fs.pathExists;
    const originalReadJson = fs.readJson;
    const originalStat = fs.stat;

    const isMockPath = (p) => typeof p === 'string' && (p.includes('/tmp/mock') || p.includes('\\tmp\\mock'));

    fs.readdir = async (p) => {
        if (isMockPath(p)) return mockFiles;
        return originalReaddir(p);
    };
    fs.pathExists = async (p) => {
        if (isMockPath(p)) {
            if (p.endsWith('fix_audit.json')) return !!mockFixAudit;
            if (p.endsWith('delta_report.json')) return !!mockDeltaReport;
            if (p.endsWith('analysis_report.json')) return mockFiles.includes('analysis_report.json');
            return true;
        }
        return originalPathExists(p);
    };
    fs.readJson = async (p) => {
        if (isMockPath(p)) {
            if (p.endsWith('fix_audit.json')) return mockFixAudit;
            if (p.endsWith('delta_report.json')) return mockDeltaReport;
            if (p.endsWith('analysis_report.json')) return {};
        }
        return originalReadJson(p);
    };
    fs.stat = async (p) => {
        if (isMockPath(p)) return { size: 1024, birthtime: new Date(), isDirectory: () => false };
        return originalStat(p);
    };

    const workerReportPath = process.env.PHASE56E_WORKER_REPORT || path.join(__dirname, '../../ppos-preflight-worker-phase-10-intelligence-layer/reports/phase56e_worker_artifact_trust_regression.json');
    let workerReport = [];
    if (await originalPathExists(workerReportPath)) {
        workerReport = await originalReadJson(workerReportPath);
        console.log(`Loaded Worker Report from: ${workerReportPath}`);
    } else {
        console.warn(`Worker report not found at ${workerReportPath}. Proceeding with simulated worker output.`);
    }

    const report = [];
    let allPassed = true;

    const runScenario = async (scenario) => {
        mockFiles = [...(scenario.files || [])];
        mockFixAudit = scenario.fix_audit || null;
        mockDeltaReport = scenario.delta_report || null;
        if (mockFixAudit) mockFiles.push('fix_audit.json');
        if (mockDeltaReport) mockFiles.push('delta_report.json');
        
        mockJob = { id: 'job_123', job_type: scenario.job_type || 'AUTOFIX', status: 'COMPLETED' };
        mockResult = scenario.res || {};

        const payload = await service.getJobStatus('job_123', { auth: { tenantId: 'tenant_123' } });
        
        try {
            const pass = scenario.assertions(payload);
            return {
                scenario: scenario.name,
                primary_artifact_type: payload.primary_artifact_type || null,
                production_certified: payload.production_certified,
                standard_certified: payload.standard_certified,
                customer_visible: payload.customer_visible,
                pass: pass,
                notes: pass ? "As expected" : "Failed assertions"
            };
        } catch (e) {
            console.error(e);
            return { scenario: scenario.name, pass: false, notes: e.message };
        }
    };

    const scenarios = [
        {
            name: "1. certified.pdf filename only",
            job_type: 'ANALYZE',
            files: ['certified.pdf', 'report.json'],
            res: { production_certified: false },
            assertions: (payload) => {
                return payload.primary_artifact_type === 'certified_pdf' &&
                       !payload.production_certified && 
                       !payload.standard_certified;
            }
        },
        {
            name: "2. review_pdf primary",
            job_type: 'AUTOFIX',
            files: ['review.pdf', 'fixed.pdf', 'certified.pdf', 'report.json'],
            fix_audit: {
                version: '2.0',
                artifact_trust: {
                    primary_artifact_type: 'review_pdf',
                    review_required: true,
                    production_certified: false,
                    customer_visible: false
                }
            },
            assertions: (payload) => {
                return payload.primary_artifact_type === 'review_pdf' &&
                       payload.artifact_summary.production_ready_artifact_available === false &&
                       payload.artifact_summary.review_required_artifact_available === true;
            }
        },
        {
            name: "3. fixed_pdf primary",
            job_type: 'AUTOFIX',
            files: ['fixed.pdf', 'certified.pdf', 'report.json'],
            fix_audit: {
                version: '2.0',
                artifact_trust: {
                    primary_artifact_type: 'fixed_pdf',
                    review_required: false,
                    production_certified: false,
                    customer_visible: true
                }
            },
            assertions: (payload) => {
                return payload.primary_artifact_type === 'fixed_pdf';
            }
        },
        {
            name: "4. certified_pdf production-certified but not standards-certified",
            job_type: 'ANALYZE',
            files: ['certified.pdf', 'report.json'],
            fix_audit: {
                version: '2.0',
                artifact_trust: {
                    primary_artifact_type: 'certified_pdf',
                    production_certified: true,
                    standard_certified: false,
                    customer_visible: true
                }
            },
            assertions: (payload) => {
                return payload.production_certified === true && payload.standard_certified === false;
            }
        },
        {
            name: "5. certified_pdf standards-certified with complete evidence",
            job_type: 'ANALYZE',
            files: ['certified.pdf', 'report.json'],
            fix_audit: {
                version: '2.0',
                artifact_trust: {
                    primary_artifact_type: 'certified_pdf',
                    production_certified: true,
                    standard_certified: true,
                    certification_labels: ['PDF/X-4'],
                    evidence: {
                        validation_performed: true,
                        validation_passed: true,
                        validator_name: 'test',
                        validator_version: '1.0',
                        standard_detected: 'PDF/X-4',
                        validation_report_available: true,
                        compliance_claim_allowed: true
                    }
                }
            },
            assertions: (payload) => {
                return payload.standard_certified === true && payload.certification_labels.includes('PDF/X-4');
            }
        },
        {
            name: "6. standards claim without evidence",
            job_type: 'ANALYZE',
            files: ['certified.pdf', 'report.json'],
            fix_audit: {
                version: '2.0',
                artifact_trust: {
                    primary_artifact_type: 'certified_pdf',
                    production_certified: true,
                    standard_certified: true,
                    pdfx_compliance_claimed: true,
                    evidence: {
                        validation_performed: false
                    }
                }
            },
            assertions: (payload) => {
                return payload.standard_certified === false && 
                       payload.pdfx_compliance_claimed === false && 
                       payload.reviewReasons.includes('STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE');
            }
        },
        {
            name: "7. OutputIntent warning",
            job_type: 'AUTOFIX',
            files: ['fixed.pdf', 'report.json'],
            fix_audit: {
                version: '2.0',
                artifact_trust: {
                    primary_artifact_type: 'fixed_pdf',
                    production_certified: false,
                    standard_certified: false
                },
                standards_certification_governance: {
                    outputintent_changed: true,
                    outputintent_does_not_prove_pdfx: true
                }
            },
            assertions: (payload) => {
                return payload.standard_certified === false && 
                       payload.standards_certification_governance.outputintent_does_not_prove_pdfx === true;
            }
        },
        {
            name: "8. governance blockers",
            job_type: 'AUTOFIX',
            files: ['review.pdf', 'fixed.pdf', 'report.json'],
            fix_audit: {
                version: '2.0',
                artifact_trust: {
                    primary_artifact_type: 'review_pdf',
                    production_certified: false,
                    blocked_by_governance_domains: ['transparency_overprint']
                }
            },
            assertions: (payload) => {
                return payload.blocked_by_governance_domains.includes('transparency_overprint') &&
                       payload.production_certified === false &&
                       payload.primary_artifact_type === 'review_pdf';
            }
        },
        {
            name: "9. artifact_trust absent",
            job_type: 'ANALYZE',
            files: ['certified.pdf', 'report.json'],
            fix_audit: {},
            res: {
                production_certified: false,
                standard_certified: false
            },
            assertions: (payload) => {
                return payload.production_certified === false &&
                       payload.standard_certified === false;
            }
        },
        {
            name: "10. false incoming metadata conflict",
            job_type: 'AUTOFIX',
            files: ['fixed.pdf', 'report.json'],
            fix_audit: {
                version: '2.0',
                artifact_trust: {
                    primary_artifact_type: 'fixed_pdf',
                    production_certified: false
                }
            },
            res: {
                production_certified: true
            },
            assertions: (payload) => {
                return payload.production_certified === false;
            }
        }
    ];

    for (const scenario of scenarios) {
        const result = await runScenario(scenario);
        report.push(result);
        if (!result.pass) {
            allPassed = false;
            console.log(`❌ Failed: ${scenario.name}`);
        } else {
            console.log(`✅ Passed: ${scenario.name}`);
        }
    }

    const mdReportPath = path.join(reportsDir, 'phase56e_service_artifact_trust_regression.md');
    const jsonReportPath = path.join(reportsDir, 'phase56e_service_artifact_trust_regression.json');

    await originalReadJson('package.json').catch(() => null); // mock clear

    fs.writeJson = async (p, d, o) => require('fs').writeFileSync(p, JSON.stringify(d, null, o?.spaces));
    fs.writeFile = async (p, d) => require('fs').writeFileSync(p, d);

    await fs.writeJson(jsonReportPath, report, { spaces: 2 });

    let md = `# Phase 56E.3 Service Artifact Trust Regression Report\n\n`;
    md += `## Summary\n- All Passed: ${allPassed}\n\n`;
    md += `## Scenario Results\n`;
    
    report.forEach(r => {
        md += `### ${r.scenario}\n`;
        md += `- **Pass**: ${r.pass}\n`;
        md += `- **Primary Artifact**: ${r.primary_artifact_type} (${r.primary_artifact_filename})\n`;
        md += `- **Production Certified**: ${r.production_certified}\n`;
        md += `- **Standard Certified**: ${r.standard_certified}\n`;
        md += `- **Notes**: ${r.notes}\n\n`;
    });

    await fs.writeFile(mdReportPath, md);
    console.log(`\nReports generated in reports/phase56e_service_artifact_trust_regression.md`);

    if (!allPassed) {
        process.exit(1);
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
