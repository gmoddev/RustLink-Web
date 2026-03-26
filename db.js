const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST, // NOTE: changed from DB_SERVER
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT) || 5432,
    ssl: false // set true if using remote DB with SSL
});

pool.connect()
    .then(client => {
        console.log('✅ PostgreSQL connected');
        client.release();
    })
    .catch(err => {
        console.error('❌ PostgreSQL connection error:', err);
    });

module.exports = {
    pool
};