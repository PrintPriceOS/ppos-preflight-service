const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Contract-Aware StorageManager
 * 
 * Enforces tenant-scoped storage paths:
 * /storage/tenants/{tenantId}/jobs/{jobId}/[input|output|temp|reports]
 * 
 * Behavior awareness for:
 * - logical: strict shared-resource separation
 * - dedicated: tenant-scoped paths + affinity indicators
 * - cluster: tenant pathing + cluster metadata hooks
 */
class StorageManager {
    constructor(basePath = process.env.PPOS_UPLOADS_DIR || '/storage') {
        this.basePath = basePath;
    }

    /**
     * Resolve the base path for a job, respecting the deployment contract.
     */
    getJobPath(tenantId, jobId) {
        if (!tenantId || !jobId) {
            throw new Error('[STORAGE-ERR] tenantId and jobId are REQUIRED for isolation.');
        }
        return path.join(this.basePath, 'tenants', tenantId, 'jobs', jobId);
    }

    /**
     * Get a specific subfolder within a job's storage.
     */
    getJobSubfolder(tenantId, jobId, subfolder) {
        const allowed = ['input', 'output', 'temp', 'reports'];
        if (!allowed.includes(subfolder)) {
            throw new Error(`[STORAGE-ERR] Invalid subfolder requested: ${subfolder}`);
        }
        return path.join(this.getJobPath(tenantId, jobId), subfolder);
    }

    /**
     * Prepares isolated storage for a job based on deployment context.
     * @param {object} context - Normalized execution context.
     */
    async initializeJobStorage(context, jobId) {
        const { tenantId, deploymentId, tenantIsolation } = context;
        const base = this.getJobPath(tenantId, jobId);

        try {
            // Apply mode-specific behavior
            switch (tenantIsolation) {
                case 'dedicated':
                    // In dedicated mode, we might want to flag the folder with metadata or different ACLs
                    // For now, we ensure strict pathing
                    break;
                case 'cluster':
                    // Cluster mode might involve creating metadata hooks for distributed coordination
                    await fs.ensureDir(path.join(base, '.cluster-metadata'));
                    break;
                case 'logical':
                default:
                    // Standard shared infra behavior
                    break;
            }

            // Ensure subfolder pattern
            await fs.ensureDir(path.join(base, 'input'));
            await fs.ensureDir(path.join(base, 'output'));
            await fs.ensureDir(path.join(base, 'temp'));
            await fs.ensureDir(path.join(base, 'reports'));

            console.log(`[STORAGE][INIT] Isolated storage ready for Job ${jobId} | Tenant ${tenantId} | Deployment ${deploymentId} | Mode ${tenantIsolation}`);
            return base;

        } catch (err) {
            console.error(`[STORAGE-ERR] Failed to initialize storage for Job ${jobId}: ${err.message}`);
            throw err;
        }
    }

    /**
     * Saves an input file to the job's scoped input folder.
     */
    async saveInputFile(tenantId, jobId, content, originalName) {
        const inputDir = this.getJobSubfolder(tenantId, jobId, 'input');
        const ext = path.extname(originalName) || '.pdf';
        const fileName = `${uuidv4()}${ext}`;
        const filePath = path.join(inputDir, fileName);

        if (Buffer.isBuffer(content)) {
            await fs.outputFile(filePath, content);
        } else if (typeof content === 'string') {
            await fs.outputFile(filePath, content);
        } else {
            // Assume it's a stream
            const outStream = fs.createWriteStream(filePath);
            content.pipe(outStream);
            await new Promise((resolve, reject) => {
                outStream.on('finish', resolve);
                outStream.on('error', reject);
            });
        }

        return { filePath, fileName };
    }

    /**
     * Verifies that a file path belongs to the tenant's isolated storage.
     * Prevents path traversal and cross-tenant leakage.
     */
    verifyPathIsolation(tenantId, targetPath) {
        const tenantRoot = path.join(this.basePath, 'tenants', tenantId);
        const resolvedPath = path.resolve(targetPath);
        if (!resolvedPath.startsWith(tenantRoot)) {
            throw new Error(`CRITICAL: Isolation breach detected. Path ${targetPath} is outside tenant ${tenantId} root.`);
        }
        return true;
    }

    /**
     * Hard delete of job storage context.
     */
    async deleteJobStorage(tenantId, jobId) {
        const base = this.getJobPath(tenantId, jobId);
        await fs.remove(base);
        console.log(`[STORAGE] Purged storage context for Job ${jobId} (Tenant ${tenantId})`);
    }
}

module.exports = StorageManager;
