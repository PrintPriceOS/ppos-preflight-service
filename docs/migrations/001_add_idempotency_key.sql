-- Migration 001: Add idempotency_key to jobs table
-- Target: PrintPrice OS Canonical Service
-- Purpose: Support request deduplication and safe async retries.

ALTER TABLE jobs 
ADD COLUMN idempotency_key VARCHAR(255) NULL AFTER status;

-- Add index for efficient idempotency lookup
CREATE INDEX idx_jobs_idempotency_tenant 
ON jobs (tenant_id, idempotency_key);
