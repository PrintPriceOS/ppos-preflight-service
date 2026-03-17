/**
 * PreflightService
 * 
 * Orchestrates the analysis and autofix lifecycle.
 */
class PreflightService {
    constructor(engineClient, workerClient, storage) {
        this.engine = engineClient;
        this.worker = workerClient;
        this.storage = storage;
    }

    async analyze(fileStream, filename, tenantId) {
        // 1. Stage file
        const { filePath, id } = await this.storage.save(fileStream, filename);
        
        // 2. Decide: Synchronous Engine vs Asynchronous Worker
        // For now, we'll try sync engine for small files, worker for large
        const stats = await this.storage.getStats(filePath);
        
        if (stats.size < 5 * 1024 * 1024) { // < 5MB sync
            return await this.engine.analyze(filePath, { tenantId, assetId: id });
        } else {
            return await this.worker.enqueue('ANALYZE', { filePath, tenantId, assetId: id });
        }
    }

    async autofix(assetId, policy, tenantId, options = {}) {
        // Orchestrate autofix job
        return await this.worker.enqueue('AUTOFIX', { assetId, policy, tenantId, ...options });
    }
}

module.exports = PreflightService;
