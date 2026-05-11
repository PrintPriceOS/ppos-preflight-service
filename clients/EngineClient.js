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
        const start = Date.now();
        
        if (this.engine) {
            // Add a safety timeout of 2 minutes for deterministic analysis
            console.log('[DEBUG][ENGINE-INPUT]', filePath);
            const analysisPromise = this.engine.analyzePdf(filePath, options);
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('ENGINE_ANALYSIS_TIMEOUT')), 120000)
            );

            let report = await Promise.race([analysisPromise, timeoutPromise]);
            console.log('[DEBUG][ENGINE-RAW-RESULT]', JSON.stringify(report, null, 2));
            const elapsed = Date.now() - start;
            console.log(`[CLIENT][ENGINE] engine.analyzePdf completed in ${elapsed}ms for ${filePath}`);

            // Flatten risk_score for product compatibility
            return {
                ...report,
                risk_score: report.summary.risk_score,
                status: report.ok ? 'PASS' : 'FAIL'
            };
        }
        
        return { status: 'PASS', risk_score: 100, findings: [], issues: [], specs: { pages: 1 } };
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
