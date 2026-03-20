const mysql = require('mysql2/promise');

/**
 * PrintPrice OS — Database Service (v1.9.3)
 * Provides centralized, pooled access to MySQL with governance tracing.
 */
class DatabaseService {
    constructor() {
        const dbUrl = process.env.DATABASE_URL;
        const config = {
            host: process.env.MYSQL_HOST || 'localhost',
            user: process.env.MYSQL_USER || 'root',
            password: process.env.MYSQL_PASSWORD || 'PrintPrice123!',
            database: process.env.MYSQL_DATABASE || 'ppos_preflight',
            waitForConnections: true,
            connectionLimit: process.env.MYSQL_POOL_SIZE || 20,
            maxIdle: 10,
            idleTimeout: 60000,
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0
        };

        if (dbUrl) {
            console.log('[DB] Initializing pool from DATABASE_URL');
            this.pool = mysql.createPool(dbUrl);
        } else {
            console.log(`[DB] Initializing pool for ${config.host}/${config.database}`);
            this.pool = mysql.createPool(config);
        }
    }

    /**
     * Executes a SQL query within the governance context.
     * @param {string} sql - SQL query string.
     * @param {Array} params - Query parameters.
     * @param {object} context - Governance context (tenantId, deploymentId, requestId).
     */
    async execute(sql, params = [], context = {}) {
        const { tenantId, deploymentId, requestId } = context;
        const start = Date.now();

        try {
            const [rows] = await this.pool.execute(sql, params);
            
            // Subtle micro-telemetry
            const duration = Date.now() - start;
            if (duration > 500) {
                 console.warn(`[DB-SLOW-QUERY] ${duration}ms | Req: ${requestId} | Tenant: ${tenantId}`);
            }

            return rows;
        } catch (err) {
            console.error(`[DB-EXEC-ERROR] ${err.message} | Req: ${requestId} | Tenant: ${tenantId}`);
            throw err;
        }
    }

    /**
     * Governance-aligned query wrapper.
     */
    async query(sql, params = []) {
        return this.execute(sql, params, { tenantId: 'SYSTEM', deploymentId: 'LOCAL' });
    }

    /**
     * Close the pool on shutdown.
     */
    async shutdown() {
        console.log('[DB] Closing connection pool...');
        await this.pool.end();
    }
}

// Singleton for the service
module.exports = new DatabaseService();
