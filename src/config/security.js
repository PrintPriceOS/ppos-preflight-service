/**
 * Security Configuration
 * Aligned with PPOS Control Plane expectations.
 */
module.exports = {
    jwt: {
        issuer: process.env.JWT_ISSUER || 'https://auth.printprice.pro',
        audience: process.env.JWT_AUDIENCE || 'ppos:control',
        algorithms: [process.env.JWT_ALGORITHM || 'HS256'],
        secret: process.env.JWT_SECRET || 'ppos-dev-only-secret-2026',
        publicKey: process.env.JWT_PUBLIC_KEY
    }
};
