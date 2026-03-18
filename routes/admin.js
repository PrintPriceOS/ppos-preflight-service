const adminService = require('../src/services/adminService');
const requireScope = require('../src/middleware/requireScope');

async function adminRoutes(fastify, options) {
    /**
     * GET /api/admin/tenants
     * Global visibility for platform admins.
     */
    fastify.get('/tenants', { preHandler: [requireScope('admin:read')] }, async (request, reply) => {
        const tenants = await adminService.listTenants();
        return { ok: true, tenants };
    });

    /**
     * GET /api/admin/tenants/:id/usage
     * Specific tenant telemetry.
     */
    fastify.get('/tenants/:id/usage', { preHandler: [requireScope('admin:read')] }, async (request, reply) => {
        const { id } = request.params;
        const usage = await adminService.getTenantUsage(id);
        return { ok: true, tenantId: id, usage };
    });

    /**
     * GET /api/admin/jobs
     * Recent jobs across all tenants. 
     * Visibility restricted by supportModel in authorizationService.
     */
    fastify.get('/jobs', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        const jobs = await adminService.listRecentJobs();
        const metrics = await adminService.getGlobalJobMetrics();
        return { ok: true, jobs, metrics };
    });

    /**
     * GET /api/admin/workers
     * Real-time worker health and load.
     */
    fastify.get('/workers', { preHandler: [requireScope('admin:read')] }, async (request, reply) => {
        const workers = await adminService.getWorkerStatus();
        return { ok: true, workers };
    });

    /**
     * GET /api/admin/deployment/context
     * Sanitized diagnostics for the current deployment.
     */
    fastify.get('/deployment/context', { preHandler: [requireScope('governance:read')] }, async (request, reply) => {
        const { deployment } = request.context;
        
        // Sanitize for diagnostics (exclude secrets)
        return {
            ok: true,
            deployment: {
                deploymentId: deployment.deploymentId,
                profile: deployment.profile,
                serviceTier: deployment.serviceTier,
                region: deployment.region,
                tenantIsolation: deployment.tenantIsolation,
                upgradeMode: deployment.upgradeMode,
                supportModel: deployment.supportModel,
                runbookProfile: deployment.runbookProfile
            }
        };
    });
}

module.exports = adminRoutes;
