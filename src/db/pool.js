// This file creates ONE shared connection pool to PostgreSQL.
// Every other file that needs to talk to the database imports this.
//
// A "pool" just means: instead of opening a brand new database
// connection every time we need one (slow!), we keep a small group
// of connections open and reuse them.

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

module.exports = pool;
