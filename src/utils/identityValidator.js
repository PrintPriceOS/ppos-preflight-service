/**
 * IdentityValidator (Phase 10 — Intelligence Layer)
 * 
 * Enforces strict, string-based canonical identity patterns 
 * to prevent database primary key leakage.
 */

const { ErrorCodes, ErrorTypes, PPOSError } = require('./errors');

class IdentityValidator {
    /**
     * Checks if a string follows the canonical job or fix identity pattern.
     * Allowed prefixes: 'job_', 'fix_', 'sync_fix_'.
     * @param {string} id 
     * @returns {boolean}
     */
    static isValidJobId(id) {
        if (typeof id !== 'string') return false;
        
        // Block plain numeric strings (leakage detection)
        if (/^\d+$/.test(id)) {
            console.warn(`[SECURITY][IDENTITY] Blocked numeric identity attempt: ${id}`);
            return false;
        }

        const validPrefixes = ['job_', 'fix_', 'sync_fix_'];
        return validPrefixes.some(prefix => id.startsWith(prefix));
    }

    /**
     * Validates an ID and throws a PPOSError if invalid.
     * @param {string} id 
     * @param {string} resourceName 
     */
    static validate(id, resourceName = 'Job') {
        if (!this.isValidJobId(id)) {
            throw new PPOSError(
                ErrorCodes.INVALID_IDENTITY,
                `Invalid ${resourceName} identifier: "${id}". Canonical identity expected (e.g. job_xxx).`,
                ErrorTypes.USER_ERROR
            );
        }
        return true;
    }
}

module.exports = IdentityValidator;
