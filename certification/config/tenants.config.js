const { generateToken } = require('../../src/auth/generateToken');

// Mock tokens for certification
const generateTestTokens = () => {
    const tenants = {
        tenant_A: {
            admin: generateToken({ userId: 'admin-a', tenantId: 'tenant-a', role: 'admin', scopes: ['*'] }),
            member: generateToken({ userId: 'member-a', tenantId: 'tenant-a', role: 'member', scopes: ['preflight:read', 'preflight:write'] }),
            viewer: generateToken({ userId: 'viewer-a', tenantId: 'tenant-a', role: 'viewer', scopes: ['preflight:read'] })
        },
        tenant_B: {
            admin: generateToken({ userId: 'admin-b', tenantId: 'tenant-b', role: 'admin', scopes: ['*'] }),
            member: generateToken({ userId: 'member-b', tenantId: 'tenant-b', role: 'member', scopes: ['preflight:read', 'preflight:write'] })
        },
        system: {
            provider_operator: generateToken({ userId: 'sup-01', tenantId: 'ppos-central', role: 'support_operator', scopes: ['admin:read', 'preflight:read'] })
        }
    };
    return tenants;
};

module.exports = { generateTestTokens };
