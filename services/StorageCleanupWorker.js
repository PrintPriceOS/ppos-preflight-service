const fs = require('fs-extra');
const path = require('path');
const db = require('../src/services/db');

/**
 * StorageCleanupWorker (Runbook v1.1)
 * 
 * Enforces TTL on job storage.
 */
class StorageCleanupWorker {
    constructor(storageManager, ttlHours = 24) {
        this.storage = storageManager;
        this.ttlHours = ttlHours;
        this.interval = null;
    }

    start(intervalMs = 3600000) { // Default 1 hour
        console.log(`[CLEANUP] Starting StorageCleanupWorker (TTL: ${this.ttlHours}h, Interval: ${intervalMs}ms)`);
        this.interval = setInterval(() => this.cleanup(), intervalMs);
        this.cleanup(); // Initial run
    }

    async cleanup() {
        console.log('[CLEANUP] Running scheduled storage purge...');
        const startTime = Date.now();
        let purgedCount = 0;

        try {
            // Find expired jobs from DB
            const expiredJobs = await db.query(
                `SELECT id, tenant_id FROM jobs 
                 WHERE status IN ('COMPLETED', 'FAILED') 
                 AND created_at < NOW() - INTERVAL ? HOUR`,
                [this.ttlHours]
            );

            for (const job of expiredJobs) {
                try {
                    await this.storage.deleteJobStorage(job.tenant_id, job.id);
                    // Also delete from DB to keep it clean (optional / soft delete)
                    await db.execute("DELETE FROM jobs WHERE id = ?", [job.id]);
                    purgedCount++;
                } catch (err) {
                    console.error(`[CLEANUP-ERR] Failed to purge job ${job.id}: ${err.message}`);
                }
            }

            const duration = Date.now() - startTime;
            console.log(`[CLEANUP][DONE] Purged ${purgedCount} jobs in ${duration}ms.`);
        } catch (err) {
            console.error(`[CLEANUP-FATAL] Cleanup cycle failed: ${err.message}`);
        }
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
    }
}

module.exports = StorageCleanupWorker;
