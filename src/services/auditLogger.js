const db = require('./db');

/**
 * PrintPrice OS — Audit Logger (v1.9.7)
 * 
 * Provides centralized audit persistence for the enterprise platform.
 * Reconstructs: WHO performed WHAT ACTION on WHICH TENANT, 
 * under WHICH DEPLOYMENT and WITH WHAT POSTURE.
 */

const VALID_EVENTS = new Set([
  'JOB_EXTRACTED', 'JOB_FAILED', 'JOB_RETRY', 'JOB_DISCARDED', 
  'GUARDRAIL_ENGAGED', 'CIRCUIT_BREAKER_TRIPPED', 'CIRCUIT_BREAKER_RESET',
  'OPTIMIZATION_PROPOSAL_GENERATED', 'OPTIMIZATION_ACTION_APPLIED',
  'OPTIMIZATION_ACTION_BLOCKED', 'LEARNING_OUTCOME_INGESTED',
  'FEDERATION_SIGNAL_SENT', 'FEDERATION_SIGNAL_RECEIVED',
  'FEDERATION_DECISION_MADE', 'FEDERATION_BLOCKED_BY_POLICY', 
  'FEDERATION_ROUTE_APPLIED', 'GLOBAL_POLICY_CREATED',
  'GLOBAL_POLICY_DRY_RUN_VALIDATED', 'GLOBAL_POLICY_CANARY_STARTED',
  'GLOBAL_POLICY_CANARY_BLOCKED', 'GLOBAL_POLICY_STAGED_APPLIED',
  'GLOBAL_POLICY_ROLLED_BACK', 'GLOBAL_POSTURE_SUMMARY_UPDATED',
  'GLOBAL_INCIDENT_COORDINATION_TRIGGERED', 'GLOBAL_POLICY_BLOCKED_BY_LOCAL_SOVEREIGNTY'
]);

const fedLogs = [];

class AuditLogger {
    /**
     * Persists a high-integrity audit record.
     * @param {object} context - Authenticated request context (auth, deployment)
     * @param {object} detail - Detail of the action (action, resourceType, resourceId, ip, userAgent)
     */
    async log(context, detail) {
        const { auth, deployment, request: contextRequest } = context || {};
        const { 
            action, 
            resourceType = 'API_ENDPOINT', 
            resourceId = 'N/A', 
            ip = '0.0.0.0', 
            userAgent = 'Unknown',
            governanceSnapshot = null 
        } = detail;

        const requestId = contextRequest?.requestId || 'unknown';
        const tenantId = auth?.tenantId || 'SYSTEM';
        const deploymentId = deployment?.deploymentId || 'LOCAL';
        const userId = auth?.userId || 'SYSTEM';
        const userRole = auth?.role || 'GUEST';

        // 1. Persist to DB asynchronously to avoid blocking
        try {
            await db.execute(
                `INSERT INTO api_audit_log 
                 (tenant_id, deployment_id, user_id, user_role, request_id, action, resource_type, resource_id, ip_address, user_agent, governance_snapshot) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId,
                    deploymentId,
                    userId,
                    userRole,
                    requestId,
                    action,
                    resourceType,
                    resourceId,
                    ip,
                    userAgent,
                    governanceSnapshot ? JSON.stringify(governanceSnapshot) : null
                ],
                { tenantId, requestId }
            );
        } catch (err) {
            console.error(`[AUDIT-PERSIST-ERR] Failed to record audit for Request ${requestId}: ${err.message}`);
        }

        // 2. Output to structured log (STDOUT) for log aggregators (Elastic/Grafana)
        console.log(JSON.stringify({
             level: 'audit',
             requestId,
             tenantId,
             deploymentId,
             actor: { userId, userRole },
             action,
             resource: { type: resourceType, id: resourceId },
             policy: governanceSnapshot || 'standard',
             timestamp: new Date().toISOString()
        }));
    }

    /**
     * Convenience method for policy enforcement auditing.
     */
    async logPolicyViolation(context, code, message, snapshot) {
        await this.log(context, {
            action: `GOVERNANCE_BLOCK: ${code}`,
            resourceType: 'POLICY_ENGINE',
            resourceId: code,
            governanceSnapshot: snapshot,
            ip: context.request?.ip || '0.0.0.0'
        });
    }

    /**
     * Convenience method for authentication auditing.
     */
    async logAuthEvent(context, status, message) {
        await this.log(context, {
            action: `AUTH_${status.toUpperCase()}`,
            resourceType: 'IDENTITY_SERVICE',
            resourceId: status,
            ip: context.request?.ip || '0.0.0.0'
        });
    }

    logFederation(event, originInstance, targetInstance, details) {
        if (!VALID_EVENTS.has(event)) {
            console.warn(`[AUDIT-WARN] Tried to log invalid federation event: ${event}`);
            return null;
        }
        
        const entry = {
            id: `fed_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            timestamp: new Date().toISOString(),
            event,
            originInstance,
            targetInstance,
            details,
            federationFlag: true
        };
        
        fedLogs.push(entry);
        console.log(`[FEDERATION-AUDIT] ${event} | Origin: ${originInstance} -> Target: ${targetInstance}`);
        
        return entry;
    }

    getFederationLogs() {
        return fedLogs;
    }
}

module.exports = new AuditLogger();
