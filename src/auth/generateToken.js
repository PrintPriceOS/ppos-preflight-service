const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ppos-dev-only-secret-2026';
const JWT_ISSUER = process.env.JWT_ISSUER || 'https://auth.printprice.pro';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'ppos:control';
const JWT_ALGO = process.env.JWT_ALGORITHM || 'HS256';

/**
 * Generates a signed JWT.
 * @param {object} payload 
 * @param {string} expiresIn 
 * @returns {string} signed JWT
 */
function generateToken(payload, expiresIn = '1h') {
    return jwt.sign(payload, JWT_SECRET, {
        algorithm: JWT_ALGO,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn
    });
}

module.exports = { generateToken };
