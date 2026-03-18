-- PrintPrice OS — Forensic SQL Pack (Batch 2)
-- 
-- Recommended tools for platform audit and forensic analysis.

-- 1. Full Audit Chain by requestId (Correlation)
-- Usage: EXPLAIN SELECT ... will confirm index usage for performance.
SELECT 
    created_at, 
    tenant_id, 
    user_id, 
    user_role, 
    request_id, 
    action, 
    resource_type, 
    resource_id, 
    governance_snapshot 
FROM api_audit_log 
WHERE request_id = 'YOUR_REQUEST_ID_HERE' 
ORDER BY created_at ASC;

-- 2. Orphaned Jobs Detection (Stuck in non-terminal state)
SELECT 
    id, 
    tenant_id, 
    job_type, 
    status, 
    created_at, 
    updated_at 
FROM jobs 
WHERE status NOT IN ('COMPLETED', 'FAILED', 'FIXED') 
AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR);

-- 3. Missing Lifecycle Discovery (Jobs without JOB_STARTED evidence)
SELECT 
    j.id, 
    j.tenant_id, 
    j.status 
FROM jobs j
LEFT JOIN api_audit_log a ON j.id = a.resource_id AND a.action = 'JOB_STARTED'
WHERE a.id IS NULL 
AND j.created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE);

-- 4. Governance Block Review (Snapshot Introspection)
SELECT 
    created_at, 
    tenant_id, 
    action, 
    governance_snapshot->'$.serviceTier' as tier,
    governance_snapshot->'$.profile' as profile,
    governance_snapshot->'$.effectiveLimits' as limits
FROM api_audit_log 
WHERE action LIKE 'GOVERNANCE_BLOCK%'
ORDER BY created_at DESC 
LIMIT 50;

-- 5. Cross-Tenant Integrity Audit (Mismatch Detection)
-- Alerts if audit entry tenant_id differs from job record tenant_id.
SELECT 
    a.request_id, 
    a.tenant_id as audit_tenant, 
    j.tenant_id as job_tenant 
FROM api_audit_log a
JOIN jobs j ON a.resource_id = j.id
WHERE a.tenant_id != j.tenant_id 
AND a.resource_type = 'JOB';

-- 6. Index Validation (Performance Check)
-- Must show 'ref' or 'eq_ref' on idx_audit_request and idx_audit_resource
SHOW INDEX FROM api_audit_log;
EXPLAIN SELECT * FROM api_audit_log WHERE request_id = 'test-req-id';
EXPLAIN SELECT * FROM api_audit_log WHERE resource_id = 'test-resource-id';
