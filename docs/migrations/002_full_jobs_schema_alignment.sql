-- Migration 002: Full Jobs Schema Alignment
-- Target: PrintPrice OS Canonical Service
-- Purpose: Aligns legacy jobs table with the multi-tenant governance contract (Phase 10).

-- 1. Add missing canonical columns required by PreflightService inserts
ALTER TABLE jobs 
ADD COLUMN deployment_id VARCHAR(64) NOT NULL AFTER tenant_id,
ADD COLUMN user_id VARCHAR(64) AFTER deployment_id,
ADD COLUMN job_type ENUM('ANALYZE', 'AUTOFIX') NOT NULL AFTER user_id,
ADD COLUMN input_bytes BIGINT DEFAULT 0 AFTER status,
ADD COLUMN output_bytes BIGINT DEFAULT 0 AFTER input_bytes;

-- 2. Align status enum with canonical values
-- This ensures QUEUED, PROCESSING, COMPLETED, FAILED, and FIXED are all valid.
ALTER TABLE jobs 
MODIFY COLUMN status ENUM('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'FIXED') DEFAULT 'QUEUED';

-- 3. Add canonical indexes for multi-tenant isolation and observability
-- Note: idx_jobs_idempotency_tenant is handled in migration 001.
CREATE INDEX idx_tenant_deployment ON jobs (tenant_id, deployment_id);
CREATE INDEX idx_status ON jobs (status);

-- Note: Legacy columns (asset_id, type, progress, error) are preserved for backward compatibility
-- with older job records, but are no longer used by the Phase 10 insert path.
