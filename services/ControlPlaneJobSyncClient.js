const fetchImpl = globalThis.fetch;

if (typeof fetchImpl !== 'function') {
  console.warn('[SERVICE][CONTROL-PLANE-JOB-SYNC][DISABLED]', {
    reason: 'GLOBAL_FETCH_UNAVAILABLE'
  });
}

class ControlPlaneJobSyncClient {
  constructor() {
    this.controlPlaneUrl = process.env.CONTROL_PLANE_URL || 'http://localhost:8001';
  }

  _getAuthHeader() {
    let token = process.env.PPOS_CONTROL_TOKEN || process.env.PREFLIGHT_JWT;
    if (!token) return null;
    
    // Normalize bearer
    token = token.trim();
    if (token.startsWith('"') && token.endsWith('"')) {
      token = token.slice(1, -1);
    }
    if (token.startsWith("'") && token.endsWith("'")) {
      token = token.slice(1, -1);
    }
    
    if (token.toLowerCase().startsWith('bearer ')) {
      return token;
    }
    return `Bearer ${token}`;
  }

  async syncJob(payload) {
    try {
      console.log('[SERVICE][CONTROL-PLANE-JOB-SYNC][REQUEST]', {
        jobId: payload.jobId,
        sourceJobId: payload.sourceJobId,
        type: payload.type,
        status: payload.status,
        source_status: payload.source_status,
        findingsCount: payload.findingsCount,
        issuesCount: payload.issuesCount,
        appliedFixesCount: payload.appliedFixesCount,
        skippedFixesCount: payload.skippedFixesCount,
        failedFixesCount: payload.failedFixesCount,
        productionCertified: payload.productionCertified,
        requiresHumanReview: payload.requiresHumanReview,
        artifactKeys: payload.artifacts ? Object.keys(payload.artifacts) : []
      });

      const endpoint = `${this.controlPlaneUrl}/api/admin/preflight/jobs/sync`;
      const authHeader = this._getAuthHeader();

      const headers = { 'Content-Type': 'application/json' };
      if (authHeader) {
        headers['Authorization'] = authHeader;
      }

      if (typeof fetchImpl !== 'function') {
        return { ok: false, error: 'GLOBAL_FETCH_UNAVAILABLE' };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text();
        console.warn('[SERVICE][CONTROL-PLANE-JOB-SYNC][WARN]', {
          statusCode: res.status,
          body: text,
          jobId: payload.jobId
        });
        return { ok: false, error: text };
      }

      console.log('[SERVICE][CONTROL-PLANE-JOB-SYNC][OK]');
      return { ok: true };

    } catch (err) {
      // Fail soft, log loudly
      console.warn('[SERVICE][CONTROL-PLANE-JOB-SYNC][WARN] Failed to sync with Control Plane:', err.message);
      return { ok: false, error: err.message };
    }
  }
}

module.exports = new ControlPlaneJobSyncClient();
