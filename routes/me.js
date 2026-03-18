const requireScope = require('../src/middleware/requireScope');
const db = require('../src/services/db');
const policyEngine = require('../src/services/policyEngine');

async function meRoutes(fastify, options) {
    /**
     * GET /api/me/jobs
     * List only jobs belonging to the authenticated tenant.
     */
    fastify.get('/jobs', { preHandler: [requireScope('jobs:read')] }, async (request, reply) => {
        const { auth } = request.context;
        const jobs = await db.query(
            "SELECT id, job_type, status, created_at, updated_at FROM jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50",
            [auth.tenantId]
        );
        return { ok: true, jobs };
    });

    /**
     * GET /api/me/usage
     * Resource consumption for the current tenant.
     */
    fastify.get('/usage', { preHandler: [requireScope('preflight:read')] }, async (request, reply) => {
        const { auth } = request.context;
        const usage = await db.query(
            "SELECT metric, SUM(value) as total_value FROM usage_events WHERE tenant_id = ? GROUP BY metric",
            [auth.tenantId]
        );
        return { ok: true, usage };
    });

    /**
     * GET /api/me/policy
     * Exposes the effective governance policy for the tenant.
     */
    fastify.get('/policy', { preHandler: [requireScope('governance:read')] }, async (request, reply) => {
        const policy = await policyEngine.resolveEffectivePolicy(request.context);
        return { ok: true, policy };
    });
}

module.exports = meRoutes;
