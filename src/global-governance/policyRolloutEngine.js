/**
 * Policy Rollout Engine
 * Safely distributes global policies across the federated network using DRY_RUN
 * and CANARY techniques, explicitly observing Precedence rejections.
 * Phase 16 — Global Control Plane & Sovereign Network Governance
 */

const registry = require('./globalPolicyRegistry');
const precedence = require('./globalGovernancePrecedence');
const auditLogger = require('../services/auditLogger');

class PolicyRolloutEngine {
    constructor() {
        this.activeRollouts = new Map();
    }

    /**
     * Executes a phased topological rollout.
     */
    async executeRollout(policyDef, targets, mode) {
        const rolloutId = `rollout_${Date.now()}`;
        const summary = {
            rolloutId,
            policyId: policyDef.policyId,
            version: policyDef.version,
            phase: mode,
            targets,
            statusByTarget: {},
            blockedTargets: [],
            projectedConflicts: []
        };

        console.log(`\n[ROLLOUT-ENGINE] Commencing ${mode} for Policy [${policyDef.policyId}_v${policyDef.version}] across ${targets.length} regions.`);
        
        switch (mode) {
            case 'DRY_RUN':
                this._executeDryRun(policyDef, targets, summary);
                break;
            case 'CANARY':
                this._executeCanary(policyDef, targets, summary);
                break;
            case 'STAGED':
                // For simplicity, staged is handled sequentially
                this._executeStaged(policyDef, targets, summary);
                break;
            default:
                throw new Error('[ROLLOUT-ENGINE] Unknown Rollout Mode');
        }

        this.activeRollouts.set(rolloutId, summary);
        return summary;
    }

    _executeDryRun(policy, targets, summary) {
        for (const target of targets) {
            const conflict = precedence.evaluateConflict(policy, target);
            if (!conflict.allow) {
                summary.projectedConflicts.push({ target, reason: conflict.reason });
                summary.statusByTarget[target] = 'DRY_RUN_CONFLICT';
            } else {
                summary.statusByTarget[target] = 'DRY_RUN_OK';
            }
        }
        summary.phase = 'COMPLETED';
        auditLogger.logFederation('GLOBAL_POLICY_DRY_RUN_VALIDATED', 'GLOBAL_AUTHORITY', 'ALL', { conflicts: summary.projectedConflicts });
    }

    _executeCanary(policy, targets, summary) {
        // Only target the very first node theoretically
        const target = targets[0];
        const attempt = precedence.evaluateConflict(policy, target);
        
        if (!attempt.allow) {
            summary.blockedTargets.push({ target, reason: attempt.reason });
            summary.statusByTarget[target] = 'BLOCKED_BY_SOVEREIGNTY';
            summary.phase = 'CANARY_FAILED';
            auditLogger.logFederation('GLOBAL_POLICY_BLOCKED_BY_LOCAL_SOVEREIGNTY', 'GLOBAL_AUTHORITY', target, { policy: policy.policyId, reason: attempt.reason });
        } else {
            summary.statusByTarget[target] = 'CANARY_APPLIED';
            summary.phase = 'CANARY_OBSERVABILITY';
            auditLogger.logFederation('GLOBAL_POLICY_CANARY_STARTED', 'GLOBAL_AUTHORITY', target, { policy: policy.policyId });
        }
    }

    _executeStaged(policy, targets, summary) {
        // Attempts execution sequentially. If local region rejects, rollback occurs instantly.
        for (const target of targets) {
            const attempt = precedence.evaluateConflict(policy, target);
            
            if (!attempt.allow) {
                console.log(`[ROLLOUT-ABORT] Sovereignty conflict detected on ${target}. Executing absolute rollback.`);
                summary.blockedTargets.push({ target, reason: attempt.reason });
                summary.statusByTarget[target] = 'BLOCKED_BY_SOVEREIGNTY';
                summary.phase = 'ROLLED_BACK';
                
                // Rollback traces
                auditLogger.logFederation('GLOBAL_POLICY_BLOCKED_BY_LOCAL_SOVEREIGNTY', 'GLOBAL_AUTHORITY', target, { policy: policy.policyId, reason: attempt.reason });
                auditLogger.logFederation('GLOBAL_POLICY_ROLLED_BACK', 'GLOBAL_AUTHORITY', 'ALL', { rolloutId: summary.rolloutId });
                
                registry.updateStatus(policy.policyId, policy.version, 'ROLLED_BACK');
                return; // halt chain immediately
            } else {
                summary.statusByTarget[target] = 'APPLIED';
                auditLogger.logFederation('GLOBAL_POLICY_STAGED_APPLIED', 'GLOBAL_AUTHORITY', target, { policy: policy.policyId });
            }
        }

        summary.phase = 'COMPLETED';
        registry.updateStatus(policy.policyId, policy.version, 'ACTIVE');
    }

    getRollouts() {
        return Array.from(this.activeRollouts.values());
    }
}

module.exports = new PolicyRolloutEngine();
