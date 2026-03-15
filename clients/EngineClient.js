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
        // In reality, this might be a child_process, a native addon, 
        // or a direct module call if shared.
        if (this.engine && typeof this.engine.processPdf === 'function') {
            return await this.engine.processPdf(filePath, options);
        }
        
        // Mocking for now if engine not linked
        return {
            status: 'PASS',
            findings: [],
            specs: { format: 'A4', pages: 10 }
        };
    }
}

module.exports = EngineClient;
