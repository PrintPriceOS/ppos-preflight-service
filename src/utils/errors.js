/**
 * Normalized Error Contract (Runbook v1.1)
 */
const ErrorCodes = {
    PDF_INVALID_FORMAT: 'PDF_INVALID_FORMAT',
    PDF_TOO_LARGE: 'PDF_TOO_LARGE',
    PRECHECK_FAILED: 'PRECHECK_FAILED',
    GHOSTSCRIPT_ERROR: 'GHOSTSCRIPT_ERROR',
    WORKER_TIMEOUT: 'WORKER_TIMEOUT',
    QUEUE_OVERFLOW: 'QUEUE_OVERFLOW',
    UNAUTHORIZED: 'UNAUTHORIZED',
    INVALID_TOKEN: 'INVALID_TOKEN',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
};

const ErrorTypes = {
    USER_ERROR: 'USER_ERROR',
    SYSTEM_ERROR: 'SYSTEM_ERROR',
    TRANSIENT_ERROR: 'TRANSIENT_ERROR'
};

class PPOSError extends Error {
    constructor(code, message, type = ErrorTypes.SYSTEM_ERROR, retryable = false, details = {}) {
        super(message);
        this.code = code;
        this.type = type;
        this.retryable = retryable;
        this.details = details;
    }

    toJSON() {
        return {
            error: {
                code: this.code,
                type: this.type,
                retryable: this.retryable,
                message: this.message,
                details: this.details
            }
        };
    }
}

module.exports = {
    ErrorCodes,
    ErrorTypes,
    PPOSError
};
