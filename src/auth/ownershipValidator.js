/**
 * OwnershipValidator
 * 
 * Ensures that requests for specific resources (jobs, files) 
 * belong to the authenticated tenant.
 */

class OwnershipValidator {
    /**
     * Verifies if a job belongs to the tenant.
     * @param {object} context - Authenticated request context.
     * @param {object} jobMetadata - Metadata loaded from DB or Storage.
     */
    static verifyJobOwnership(context, jobMetadata) {
        const { auth, deployment } = context;
        if (!auth || !auth.tenantId) {
            throw new Error('[OWNERSHIP-ERR] Unauthenticated or missing tenant context.');
        }

        // 1. Check Tenant ID match
        if (jobMetadata.tenantId !== auth.tenantId) {
            console.error(`[SECURITY] Cross-tenant access attempt detected! Tenant ${auth.tenantId} tried to access Job ${jobMetadata.jobId} belonging to ${jobMetadata.tenantId}`);
            return false;
        }

        // 2. Deployment Integrity (Optional strict check)
        // In some high-governance scenarios, we might want to ensure the job was created on the same deploymentId
        if (deployment.tenantIsolation === 'dedicated' && jobMetadata.deploymentId !== deployment.deploymentId) {
            console.warn(`[SECURITY] Job ${jobMetadata.jobId} was created on deployment ${jobMetadata.deploymentId}, but accessed via ${deployment.deploymentId}.`);
            // Historically we might allow it if it's the same tenant, but for 'dedicated' we might be stricter.
        }

        return true;
    }

    /**
     * Middleware-style wrapper for job ownership.
     */
    static async validateJob(request, reply, jobMetadata) {
        if (!this.verifyJobOwnership(request.context, jobMetadata)) {
            return reply.status(403).send({ 
                error: 'FORBIDDEN', 
                message: 'You do not have permission to access this resource.' 
            });
        }
    }
}

module.exports = OwnershipValidator;
