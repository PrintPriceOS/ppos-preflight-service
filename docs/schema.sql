-- PrintPrice OS — Phase 3: Contract-Aligned Multi-Tenant Schema

-- 1. Tenants
CREATE TABLE IF NOT EXISTS tenants (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    service_tier ENUM('standard', 'enterprise', 'enterprise_plus', 'strategic_managed') DEFAULT 'standard',
    isolation_mode ENUM('logical', 'dedicated', 'cluster') DEFAULT 'logical',
    status ENUM('active', 'suspended', 'decommissioned') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 2. Users (Scoped to Tenant)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'USER',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 3. Jobs (Historical record of preflight/autofix execution)
CREATE TABLE IF NOT EXISTS jobs (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    deployment_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64),
    job_type ENUM('ANALYZE', 'AUTOFIX') NOT NULL,
    status ENUM('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'FIXED') DEFAULT 'QUEUED',
    input_bytes BIGINT DEFAULT 0,
    output_bytes BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_tenant_deployment (tenant_id, deployment_id),
    INDEX idx_status (status)
);

-- 4. Usage Events (For billing and quota enforcement)
CREATE TABLE IF NOT EXISTS usage_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    deployment_id VARCHAR(64) NOT NULL,
    job_id VARCHAR(64),
    metric VARCHAR(50) NOT NULL, -- e.g. 'PREFLIGHT_PAGES', 'AUTOFIX_EXECUTION'
    value DECIMAL(10, 4) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_usage_tenant (tenant_id, created_at)
);

-- 5. API Audit Log (Enterprise Traceability)
CREATE TABLE IF NOT EXISTS api_audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(64),
    deployment_id VARCHAR(64),
    user_id VARCHAR(64),
    user_role VARCHAR(50), -- Phase 7 addition
    request_id VARCHAR(64), -- Phase 7 Correlation ID
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id VARCHAR(64),
    ip_address VARCHAR(45),
    user_agent TEXT,
    governance_snapshot JSON, -- Phase 7: Snapshot of policy/posture
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_trace (tenant_id, deployment_id, action),
    INDEX idx_audit_request (request_id), -- Phase 7 Correlation ID
    INDEX idx_audit_resource (resource_type, resource_id), -- Phase 7 Lookup
    INDEX idx_audit_timeline (created_at) -- Phase 7 Timeline
);
