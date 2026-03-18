const axios = require('axios');
const { generateToken } = require('../../src/auth/generateToken');

const BASE_URL = 'http://127.0.0.1:8001/api';

class CertificationUtils {
    constructor() {
        this.baseUrl = BASE_URL;
    }

    createToken(payload, expiresIn = '1h') {
        return generateToken(payload, expiresIn);
    }

    async get(endpoint, token = null, params = {}) {
        try {
            const config = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
            return await axios.get(`${this.baseUrl}${endpoint}`, { ...config, params });
        } catch (err) {
            return err.response;
        }
    }

    async post(endpoint, data = {}, token = null, isMultipart = false) {
        try {
            const headers = {};
            if (token) headers.Authorization = `Bearer ${token}`;
            if (isMultipart) headers['Content-Type'] = 'multipart/form-data';

            return await axios.post(`${this.baseUrl}${endpoint}`, data, { headers });
        } catch (err) {
            return err.response;
        }
    }

    report(testName, success, expected, actual, reason = '') {
        const status = success ? '✅ PASS' : '❌ FAIL';
        console.log(`[${status}] ${testName}`);
        if (!success) {
            console.log(`    Expected: ${expected}`);
            console.log(`    Actual: ${actual}`);
            if (reason) console.log(`    Reason: ${reason}`);
        }
        return success;
    }
}

module.exports = new CertificationUtils();
