const db = require('./db');

/**
 * PrintPrice OS — Admin Service (v1.9.6)
 * Handles aggregation of metrics, tenants, and job history for the Control Plane.
 */
class AdminService {
    /**
     * Lists tenants with basic status and tier information.
     */
    async listTenants() {
        return await db.query(
            "SELECT id, name, service_tier, isolation_mode, status, created_at FROM tenants"
        );
    }

    /**
     * Aggregates usage metrics for a specific tenant.
     */
    async getTenantUsage(tenantId) {
        return await db.query(
            `SELECT metric, SUM(value) as total_value, COUNT(*) as event_count 
             FROM usage_events 
             WHERE tenant_id = ? 
             GROUP BY metric`,
            [tenantId]
        );
    }

    /**
     * Retrieves global job metrics.
     */
    async getGlobalJobMetrics() {
        const rows = await db.query(
            `SELECT status, COUNT(*) as count, SUM(input_bytes) as total_bytes 
             FROM jobs 
             GROUP BY status`
        );
        return rows;
    }

    /**
     * Lists recent jobs across all tenants (for global admins).
     */
    async listRecentJobs(limit = 100) {
        return await db.query(
            "SELECT id, tenant_id, job_type, status, created_at FROM jobs ORDER BY created_at DESC LIMIT ?",
            [limit]
        );
    }

    /**
     * Mock worker visibility.
     * In a full implementation, this would poll RedisEmpty or a specific metrics endpoint.
     */
    async getWorkerStatus() {
        // This is a placeholder for real-time worker health
        return [
            { id: 'worker-a-01', status: 'ACTIVE', queue: 'preflight', processed: 1250 },
            { id: 'worker-b-01', status: 'ACTIVE', queue: 'preflight', processed: 980 }
        ];
    }
}

module.exports = new AdminService();
