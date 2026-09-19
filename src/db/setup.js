// Run this once with: npm run setup-db
// It creates the tables (from schema.sql) and makes sure an admin
// account exists so you can log into the admin dashboard.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./pool');
require('dotenv').config();

async function setup() {
  console.log('Creating tables...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Tables ready.');

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.log('ADMIN_EMAIL / ADMIN_PASSWORD not set in .env, skipping admin user creation.');
    return;
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [adminEmail]);

  if (existing.rows.length > 0) {
    console.log(`Admin user ${adminEmail} already exists.`);
  } else {
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await pool.query(
      'INSERT INTO users (email, password_hash, is_admin) VALUES ($1, $2, TRUE)',
      [adminEmail, passwordHash]
    );
    console.log(`Admin user created: ${adminEmail}`);
  }
}

setup()
  .then(() => {
    console.log('Setup complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
