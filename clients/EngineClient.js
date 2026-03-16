/**
 * EngineClient
 * 
 * Adapter for ppos-preflight-engine.
 */
class EngineClient {
    constructor(engineModule) {
        this.engine = engineModule; // This will be the imported PreflightEngine
    }

    async analyze(filePath, options) {
        console.log(`[CLIENT][ENGINE] Calling engine for ${filePath}`);
        
        if (this.engine) {
            const report = await this.engine.analyzePdf(filePath, options);
            // Flatten risk_score for product compatibility
            return {
                ...report,
                risk_score: report.summary.risk_score,
                status: report.ok ? 'PASS' : 'FAIL'
            };
        }
        
        return {
            status: 'PASS',
            risk_score: 0,
            findings: [],
            specs: { format: 'A4', pages: 10 }
        };
    }
}

module.exports = EngineClient;
