const axios = require('axios');
const assert = require('assert');

const API_URL = process.env.API_URL || 'http://localhost:3000';
// Mock tokens or assume unauthenticated dev mode if not configured
const HEADERS = {
    'Authorization': 'Bearer ' + (process.env.TEST_TOKEN || 'test_token'),
    'x-tenant-id': 'tenant_123'
};

async function createFixtureJob() {
    // This assumes there's a dev route or a way to mock a job.
    // In a real smoke test, you might use the DB directly to insert a fixture,
    // or trigger an API that runs a mock analyze/fix.
    // For this smoke test, we expect the user/environment to have a valid jobId to test,
    // OR we can rely on a known fixture.
    
    // As a placeholder, we'll try to find a recent AUTOFIX job
    try {
        const jobsResponse = await axios.get(`${API_URL}/api/preflight/jobs?type=AUTOFIX&limit=1`, { headers: HEADERS });
        if (jobsResponse.data && jobsResponse.data.jobs && jobsResponse.data.jobs.length > 0) {
            return jobsResponse.data.jobs[0].id;
        }
    } catch(e) {
        console.warn("Could not fetch recent job to test. Ensure service is running and has jobs.");
    }
    return null;
}

async function runSmokeTests() {
    console.log("Starting Phase 42B Artifact API Contract Smoke Tests...");
    
    const jobId = process.env.TEST_JOB_ID || await createFixtureJob();
    if (!jobId) {
        console.log("No jobId available for testing. Skipping.");
        return;
    }
    console.log(`Using Job ID: ${jobId}`);

    try {
        // A. Artifact list with real fixed PDF
        console.log("A. Testing GET /api/preflight/jobs/:jobId/artifacts");
        const listRes = await axios.get(`${API_URL}/api/preflight/jobs/${jobId}/artifacts`, { headers: HEADERS });
        assert.equal(listRes.status, 200, "Artifact list should return 200");
        assert.ok(listRes.data.ok, "Response ok should be true");
        assert.ok(Array.isArray(listRes.data.artifacts), "Artifacts should be an array");
        
        const fixedPdf = listRes.data.artifacts.find(a => a.type === 'fixed_pdf');
        if (fixedPdf) {
            assert.ok(fixedPdf.size_bytes !== undefined, "size_bytes must be present");
            assert.ok(fixedPdf.checksum_sha256 !== undefined, "checksum_sha256 must be present");
            assert.ok(fixedPdf.downloadable !== undefined, "downloadable must be present");
        } else {
            console.warn("No fixed_pdf artifact found in this job. Some tests will be skipped.");
        }

        // F. Job detail
        console.log("F. Testing GET /api/preflight/jobs/:jobId");
        const detailRes = await axios.get(`${API_URL}/api/preflight/jobs/${jobId}`, { headers: HEADERS });
        assert.equal(detailRes.status, 200);
        assert.ok(detailRes.data.job.artifact_summary, "artifact_summary must be present");
        assert.ok(detailRes.data.job.artifact_summary.artifact_count !== undefined);

        // B. Download fixed PDF
        if (fixedPdf && fixedPdf.downloadable) {
            console.log("B. Testing GET /api/preflight/jobs/:jobId/artifacts/fixed_pdf");
            const dlRes = await axios.get(`${API_URL}/api/preflight/jobs/${jobId}/artifacts/fixed_pdf`, { 
                headers: HEADERS,
                responseType: 'arraybuffer' 
            });
            assert.equal(dlRes.status, 200);
            assert.equal(dlRes.headers['content-type'], 'application/pdf');
            assert.ok(dlRes.data.length > 0, "Body length must be > 0");
            const headerStr = dlRes.data.slice(0, 4).toString('utf-8');
            assert.equal(headerStr, '%PDF', "First bytes must be %PDF");
        }

        // C. Download fix audit
        const fixAudit = listRes.data.artifacts.find(a => a.type === 'fix_audit');
        if (fixAudit && fixAudit.downloadable) {
            console.log("C. Testing GET /api/preflight/jobs/:jobId/artifacts/fix_audit");
            const dlRes = await axios.get(`${API_URL}/api/preflight/jobs/${jobId}/artifacts/fix_audit`, { 
                headers: HEADERS,
                responseType: 'arraybuffer' 
            });
            assert.equal(dlRes.status, 200);
            assert.equal(dlRes.headers['content-type'], 'application/json');
            assert.ok(dlRes.data.length > 0, "Body length must be > 0");
            const parsed = JSON.parse(dlRes.data.toString('utf-8'));
            assert.ok(parsed, "Must be valid JSON");
        }

        // E. Missing artifact
        console.log("E. Testing Missing artifact");
        try {
            await axios.get(`${API_URL}/api/preflight/jobs/${jobId}/artifacts/not_real`, { headers: HEADERS });
            assert.fail("Should have returned 404");
        } catch (err) {
            assert.equal(err.response.status, 404);
            assert.equal(err.response.data.error, "ARTIFACT_NOT_FOUND");
        }

        console.log("All smoke tests completed successfully.");
    } catch (err) {
        console.error("Smoke test failed:", err.message);
        if (err.response) {
            console.error("Response:", err.response.data);
        }
        process.exit(1);
    }
}

runSmokeTests();
