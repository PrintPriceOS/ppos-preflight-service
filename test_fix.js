const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const SECRET = process.env.JWT_SECRET || 'ppos-dev-only-secret-2026';
const ISSUER = process.env.JWT_ISSUER || 'https://auth.printprice.pro';
const AUDIENCE = process.env.JWT_AUDIENCE || 'ppos:control';

function generateToken(payload) {
    return jwt.sign({
        ...payload,
        iss: ISSUER,
        aud: AUDIENCE,
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3600
    }, SECRET);
}

async function runTest(label, payload) {
    console.log(`\n>>> TEST: ${label}`);
    const token = generateToken(payload);

    try {
        // We use a dummy payload for multipart
        // Since we are only testing the authorization layer, we expect either:
        // - 403 (Unauthorized by Scope)
        // - 400 (Bad Request by missing file, but passed Auth)
        // - 401 (Invalid Token)

        await axios.post('http://127.0.0.1:8001/api/preflight/jobs', {}, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
    } catch (err) {
        if (err.response) {
            console.log(`Status: ${err.response.status}`);
            console.log(`Body: ${JSON.stringify(err.response.data)}`);
            if (err.response.status === 400 && err.response.data.error === 'No file') {
                console.log('RESULT: PASSED Auth (Failed on logic as expected)');
            } else if (err.response.status === 403) {
                console.log('RESULT: FAILED Auth (403 Forbidden)');
            } else if (err.response.status === 401) {
                console.log('RESULT: FAILED Auth (401 Unauthorized)');
            }
        } else {
            console.error('Error:', err.message);
        }
    }
}

async function start() {
    // 1. Array of scopes
    await runTest('Scopes as Array', {
        userId: 'test-user-1',
        role: 'DEVELOPER',
        scopes: ['preflight:write', 'preflight:read']
    });

    // 2. Scopes as String (Space separated)
    await runTest('Scopes as String (Space)', {
        userId: 'test-user-2',
        role: 'DEVELOPER',
        scopes: 'preflight:write preflight:read'
    });

    // 3. Legacy scope as String
    await runTest('Legacy scope (Space)', {
        userId: 'test-user-3',
        role: 'DEVELOPER',
        scope: 'preflight:write preflight:read'
    });
}

start();
