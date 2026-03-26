const jwt = require('jsonwebtoken');

const { jwt: security } = require('../config/security');

/**
 * Verifies the integrity and contents of a JWT.
 * @param {string} token 
 * @returns {object} decoded token
 */
function verifyJwt(token) {
    const secretOrKey = security.algorithms[0].startsWith('RS') ? security.publicKey : security.secret;
    
    if (!secretOrKey) {
        throw new Error(`[AUTH-CONFIG-ERROR] Missing secret/key for algorithm ${security.algorithms[0]}`);
    }

    try {
        return jwt.verify(token, secretOrKey, {
            algorithms: security.algorithms,
            issuer: security.issuer,
            audience: security.audience
        });
    } catch (err) {
        console.error(`[PPOS-JWT-ERROR] Validation failed: ${err.message}`, {
            issuerExpected: security.issuer,
            audienceExpected: security.audience,
            algo: security.algorithms[0]
        });
        throw new Error(`Invalid JWT: ${err.message}`);
    }
}

module.exports = { verifyJwt };
