const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

async function verify() {
    const conn = await mysql.createConnection({
        host: process.env.MYSQL_HOST || '127.0.0.1',
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || 'PrintPrice123!',
        database: process.env.MYSQL_DATABASE || 'ppos_preflight'
    });

    const [rows] = await conn.execute("SELECT * FROM api_audit_log ORDER BY created_at DESC LIMIT 5;");
    console.log(JSON.stringify(rows, null, 2));
    await conn.end();
}

verify().catch(console.error);
