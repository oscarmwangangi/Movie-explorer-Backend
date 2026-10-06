// Small helpers for the on/off switches stored in the app_settings table
// and for writing lines to the admin activity log.

const pool = require('../db/pool');

// The only keys the admin is allowed to change, with their defaults.
const DEFAULT_SETTINGS = {
  registration_enabled: 'true',
  login_enabled: 'true',
  block_message: '',
};

// Returns all settings as a plain object, e.g.
// { registration_enabled: true, login_enabled: true, block_message: '' }
// Missing rows fall back to the defaults, so an old database still works.
async function getSettings() {
  const result = await pool.query('SELECT key, value FROM app_settings');
  const raw = { ...DEFAULT_SETTINGS };
  result.rows.forEach((row) => {
    raw[row.key] = row.value;
  });

  return {
    registration_enabled: raw.registration_enabled !== 'false',
    login_enabled: raw.login_enabled !== 'false',
    block_message: raw.block_message || '',
  };
}

// Saves one setting (only the known keys above).
async function saveSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) return;
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, String(value)]
  );
}

// Writes one line to the activity log. A logging problem must never break
// the real action, so errors are printed and swallowed.
async function logActivity(admin, action, targetUserId, details) {
  try {
    await pool.query(
      `INSERT INTO admin_activity (admin_id, admin_email, action, target_user_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [admin?.userId || null, admin?.email || null, action, targetUserId || null, details || null]
    );
  } catch (err) {
    console.error('Failed to write activity log:', err);
  }
}

module.exports = { getSettings, saveSetting, logActivity };
