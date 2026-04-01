/**
 * PrintPrice OS — Policy Engine (v1.9.4)
 * 
 * Derives effective runtime behavior from:
 * 1. Deployment Contract
 * 2. Service Tier
 * 3. Tenant-specific Profile/Overrides
 * 4. LIVE Governance State
 */
const db = require('./db');

const TIER_DEFAULTS = {
    standard: {
        maxFileSizeMb: 500,
        maxConcurrentJobs: 100,
        dailyJobLimit: 10000,
        storageQuotaMb: 10240, 
        featureFlags: {
            priorityProcessing: true,
            advancedObservability: true,
            tenantScopedRetention: true
        }
    },
    enterprise: {
        maxFileSizeMb: 2000,
        maxConcurrentJobs: 500,
        dailyJobLimit: 100000,
        storageQuotaMb: 102400, 
        featureFlags: {
            priorityProcessing: true,
            advancedObservability: true,
            tenantScopedRetention: true
        }
    },
    enterprise_plus: {
        maxFileSizeMb: 5000, 
        maxConcurrentJobs: 1000,
        dailyJobLimit: 500000,
        storageQuotaMb: 1024000, 
        featureFlags: {
            priorityProcessing: true,
            advancedObservability: true,
            dedicatedWorkerAffinity: true
        }
    }
};

class PolicyEngine {
    /**
     * Resolves the effective policy for a given request context.
     * @param {object} context - Normalized request context (auth, deployment)
     */
    async resolveEffectivePolicy(context) {
        // --- Phase 10: context normalization ---
        const safeContext = context || {};
        const { auth, deployment } = safeContext;
        
        if (!deployment || !deployment.serviceTier) {
            return this.getSafeModePolicy();
        }

        // 1. Base Policy from Tier
        const tier = deployment.serviceTier.toLowerCase();
        const basePolicy = TIER_DEFAULTS[tier] || TIER_DEFAULTS.standard;

        // 2. Fetch Tenant Overrides from DB
        const tenantId = auth?.tenantId || 'PUBLIC';
        const overrides = await this._getTenantOverrides(tenantId);

        // 3. Construct Effective Policy
        const effectivePolicy = {
            deploymentId: deployment.deploymentId,
            profile: deployment.profile,
            serviceTier: deployment.serviceTier,
            tenantIsolation: deployment.tenantIsolation,
            effectiveLimits: {
                maxFileSizeMb: overrides.maxFileSizeMb || basePolicy.maxFileSizeMb,
                maxConcurrentJobs: overrides.maxConcurrentJobs || basePolicy.maxConcurrentJobs,
                dailyJobLimit: overrides.dailyJobLimit || basePolicy.dailyJobLimit,
                storageQuotaMb: overrides.storageQuotaMb || basePolicy.storageQuotaMb,
                maxAsyncQueueDepth: overrides.maxAsyncQueueDepth || 100 // Default safety ceiling
            },
            featureFlags: {
                ...basePolicy.featureFlags,
                ...overrides.featureFlags,
                manualApprovalRequired: deployment.upgradeMode === 'manual_approval_only'
            },
            enforcementMode: {
                hardLimit: true,
                softLimitWarnings: deployment.serviceTier === 'standard'
            }
        };

        // Bounding Check: Overrides cannot weaken critical isolation or deployment-defined constraints
        this._applySafetyBounds(effectivePolicy, deployment);

        return effectivePolicy;
    }

    /**
     * Performs runtime checks before job execution.
     */
    async validateExecution(context, effectivePolicy, jobDetails) {
        // --- Phase 10: context normalization ---
        const safeContext = context || {};
        const { auth } = safeContext;
        const { fileSize, type } = jobDetails;
        const auditLogger = require('./auditLogger');

        try {
            // 1. Check Max File Size
            if (fileSize > (effectivePolicy.effectiveLimits.maxFileSizeMb * 1024 * 1024)) {
                throw this.createPolicyError('QUOTA_EXCEEDED', `File size exceeds allowed limit of ${effectivePolicy.effectiveLimits.maxFileSizeMb}MB`);
            }

            // 2. Check Daily Usage (Persistent check)
            const tenantId = auth?.tenantId || 'PUBLIC';
            const usageToday = await this._getDailyJobCount(tenantId);
            if (usageToday >= effectivePolicy.effectiveLimits.dailyJobLimit) {
                throw this.createPolicyError('PLAN_LIMIT_REACHED', 'Daily job limit reached for this tenant.');
            }

            // 3. Check Concurrency
            const activeJobs = await this._getActiveJobCount(tenantId);
            if (activeJobs >= effectivePolicy.effectiveLimits.maxConcurrentJobs) {
                throw this.createPolicyError('DEPLOYMENT_CONSTRAINT_BLOCKED', 'Maximum concurrent jobs reached.');
            }

            return true;
        } catch (err) {
            if (err.isPolicyViolation) {
                await auditLogger.logPolicyViolation(safeContext, err.code, err.message, effectivePolicy);
            }
            throw err;
        }
    }

    createPolicyError(code, message) {
        const err = new Error(message);
        err.code = code;
        err.isPolicyViolation = true;
        return err;
    }

    async _getTenantOverrides(tenantId) {
        try {
            // Mock or DB call
            // SELECT * FROM tenant_policy_overrides WHERE tenant_id = ?
            return {}; 
        } catch (err) {
            console.error('[POLICY] Failed to load tenant overrides:', err.message);
            return {};
        }
    }

    async _getDailyJobCount(tenantId) {
        const result = await db.query(
            "SELECT COUNT(*) as count FROM jobs WHERE tenant_id = ? AND created_at >= CURDATE()",
            [tenantId]
        );
        return result[0]?.count || 0;
    }

    async _getActiveJobCount(tenantId) {
        const result = await db.query(
            "SELECT COUNT(*) as count FROM jobs WHERE tenant_id = ? AND status IN ('QUEUED', 'PROCESSING')",
            [tenantId]
        );
        return result[0]?.count || 0;
    }

    _applySafetyBounds(policy, deployment) {
        // Governance Rule: If profile is single_tenant_enterprise, we strictly preserve dedicated isolation
        if (deployment.profile === 'single_tenant_enterprise') {
             policy.effectiveLimits.maxConcurrentJobs = Math.min(policy.effectiveLimits.maxConcurrentJobs, 100); 
        }
    }

    getSafeModePolicy() {
        console.warn('[POLICY] Entering CONSERVATIVE SAFE MODE');
        return {
            deploymentId: 'unknown',
            profile: 'safe-mode',
            effectiveLimits: {
                maxFileSizeMb: 5,
                maxConcurrentJobs: 1,
                dailyJobLimit: 10,
                storageQuotaMb: 100
            },
            featureFlags: {
                priorityProcessing: false,
                advancedObservability: false
            },
            enforcementMode: { hardLimit: true }
        };
    }
}

module.exports = new PolicyEngine();
