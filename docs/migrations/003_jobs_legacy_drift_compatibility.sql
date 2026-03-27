-- Migration 003: Jobs Legacy Drift Compatibility
-- Target: PrintPrice OS Canonical Service
-- Purpose: Resolves ER_NO_DEFAULT_FOR_FIELD errors by making legacy columns nullable.

-- 1. Make legacy 'type' column nullable
-- This allows the Phase 10 insert path (which uses job_type) to succeed 
-- without providing values for the deprecated 'type' field.
ALTER TABLE jobs MODIFY COLUMN type VARCHAR(50) NULL;

-- 2. Ensure other legacy columns used in legacy systems don't block canonical inserts
-- These fields are no longer populated by the Phase 10 runtime.
ALTER TABLE jobs MODIFY COLUMN progress INT NULL DEFAULT 0;
ALTER TABLE jobs MODIFY COLUMN error TEXT NULL;
ALTER TABLE jobs MODIFY COLUMN asset_id VARCHAR(64) NULL;

-- Note: No data is dropped. 
-- These changes only ensure that inserts missing these legacy fields can proceed safely.
