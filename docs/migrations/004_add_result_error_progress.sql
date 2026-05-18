-- Migration 004: Add progress, error, result columns to jobs table, and alter status to VARCHAR(64) for robust diagnostics.

-- 1. Alter status column to VARCHAR(64)
ALTER TABLE jobs MODIFY COLUMN status VARCHAR(64) DEFAULT 'QUEUED';

-- 2. Add progress, error, and result columns
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress INT DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS error TEXT NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result LONGTEXT NULL;
