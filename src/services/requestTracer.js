const { v4: uuidv4 } = require('uuid');

/**
 * PrintPrice OS — Request Tracer (v1.9.7)
 * 
 * Manages the generation and propagation of the global requestId
 * for full-stack correlation.
 */
class RequestTracer {
    /**
     * Extracts or generates a requestId.
     * @param {object} headers - Incoming request headers.
     */
    getOrCreateRequestId(headers = {}) {
        return headers['x-request-id'] || headers['x-correlation-id'] || uuidv4();
    }

    /**
     * Formats context for worker jobs or downstream services.
     */
    buildTracingHeader(requestId) {
        return { 'x-request-id': requestId };
    }

    /**
     * Attaches tracing context to a log entry.
     */
    traceLog(requestId, tenantId = 'N/A', deploymentId = 'N/A') {
        return {
            trace: {
                requestId,
                tenantId,
                deploymentId,
                timestamp: new Date().toISOString()
            }
        };
    }
}

module.exports = new RequestTracer();
