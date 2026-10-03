require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
  try {
    console.log('Connecting to Aiven MySQL...');
    
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: {
        rejectUnauthorized: false
      }
    });

    console.log('✅ Connection successful!');

    // Test a basic query
    const [rows] = await connection.query('SELECT 1 + 1 AS result;');
    console.log('Query result:', rows[0].result);

    await connection.end();
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
  }
}

testConnection();