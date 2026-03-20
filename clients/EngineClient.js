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
        console.log(`[CLIENT][ENGINE] Calling engine.analyze for ${filePath}`);
        
        if (this.engine) {
            const report = await this.engine.analyzePdf(filePath, options);
            // Flatten risk_score for product compatibility
            return {
                ...report,
                risk_score: report.summary.risk_score,
                status: report.ok ? 'PASS' : 'FAIL'
            };
        }
        
        return { status: 'PASS', risk_score: 0, findings: [], specs: { pages: 1 } };
    }

    async autofix(filePath, fixPlan, options) {
        console.log(`[CLIENT][ENGINE] Calling engine.autofix for ${filePath}`);
        if (this.engine) {
            return await this.engine.autofixPdf(filePath, fixPlan, options);
        }
        throw new Error('Engine not initialized');
    }

    async renderPage(filePath, outputPath, page, options) {
        console.log(`[CLIENT][ENGINE] Calling engine.renderPage p${page}`);
        if (this.engine) {
            return await this.engine.renderPage(filePath, outputPath, page, options);
        }
        throw new Error('Engine not initialized');
    }
}

module.exports = EngineClient;
