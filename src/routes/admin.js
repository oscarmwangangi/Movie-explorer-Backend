// Everything here is only usable by an admin (see requireAdmin below).
// This is what your React admin dashboard talks to.

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { calculateExpiryDate } = require('../services/subscriptionHelpers');
const { getSettings, saveSetting, logActivity } = require('../services/settingsHelpers');

const router = express.Router();

// Every route in this file needs the user to be logged in AND an admin.
router.use(requireLogin, requireAdmin);

// Shared shape for one row of the users table, used by GET /users and
// by every endpoint below that returns the updated user afterwards.
const USER_ROW_SELECT = `
  SELECT
    users.id,
    users.email,
    users.name,
    users.is_disabled,
    users.last_login_at,
    users.created_at,
    subscriptions.plan_type,
    subscriptions.status,
    subscriptions.expires_at
  FROM users
  LEFT JOIN subscriptions ON subscriptions.user_id = users.id
  WHERE users.id = $1
`;

function withComputedStatus(user) {
  const isExpiredByDate = user.expires_at && new Date(user.expires_at) < new Date();
  const status = user.status === 'active' && isExpiredByDate ? 'expired' : user.status || 'none';
  return { ...user, status };
}

async function getUserRow(userId) {
  const result = await pool.query(USER_ROW_SELECT, [userId]);
  if (result.rows.length === 0) return null;
  return withComputedStatus(result.rows[0]);
}

// A handful of the new routes below shouldn't be usable against another
// admin account (e.g. accidentally disabling or deleting yourself or a
// co-admin from the dashboard). This looks the target up and blocks it.
async function loadNonAdminTarget(req, res) {
  const userId = req.params.id;
  const result = await pool.query('SELECT id, is_admin FROM users WHERE id = $1', [userId]);
  const target = result.rows[0];
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return null;
  }
  if (target.is_admin) {
    res.status(400).json({ error: 'This action cannot be used on an admin account.' });
    return null;
  }
  return target;
}

// GET /api/admin/users
// Returns every user with their subscription info, for the table
// in the dashboard: email, last login, plan, status, expiry.
router.get('/users', async (req, res) => {
  try {
    console.log('Loading admin users');
    const result = await pool.query(`
      SELECT
        users.id,
        users.email,
        users.name,
        users.is_disabled,
        users.last_login_at,
        users.created_at,
        subscriptions.plan_type,
        subscriptions.status,
        subscriptions.expires_at
      FROM users
      LEFT JOIN subscriptions ON subscriptions.user_id = users.id
      WHERE users.is_admin = FALSE
      ORDER BY users.created_at DESC
    `);

    const users = result.rows.map(withComputedStatus);

    console.log(`Loaded ${users.length} admin users`);
    res.json({ users });
  } catch (err) {
    console.error('Failed to load admin users:', err);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

// POST /api/admin/users
// Body: { name, email, password, planType, status, expiresAt, sendWelcomeEmail }
// Creates a REAL user through the same path Flutter registrations use
// (hashed password, a subscriptions row), so they show up and behave
// identically everywhere else in the app - not a frontend-only row.
router.post('/users', async (req, res) => {
  const { name, email, password, planType, status, sendWelcomeEmail } = req.body;
  console.log('Admin creating user:', email);

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required.' });
  }
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (planType && planType !== 'monthly' && planType !== 'yearly') {
    return res.status(400).json({ error: "planType must be 'monthly', 'yearly', or left empty." });
  }

  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await client.query('BEGIN');

    const userResult = await client.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
      [email, passwordHash, name]
    );
    const userId = userResult.rows[0].id;

    if (!planType) {
      // No subscription selected - matches how the frontend's "No
      // subscription" option is meant to behave.
      await client.query(
        "INSERT INTO subscriptions (user_id, plan_type, status) VALUES ($1, 'none', 'none')",
        [userId]
      );
    } else {
      // The frontend only sends expiresAt as a hint - we always
      // calculate the real value here so the frontend can't set an
      // arbitrary expiry date.
      const finalStatus = status === 'pending' ? 'pending' : 'active';
      const expiresAt = calculateExpiryDate(planType);
      await client.query(
        `INSERT INTO subscriptions (user_id, plan_type, status, started_at, expires_at)
         VALUES ($1, $2, $3, NOW(), $4)`,
        [userId, planType, finalStatus, expiresAt]
      );
    }

    await client.query('COMMIT');

    const user = await getUserRow(userId);
    console.log('Admin created user:', userId);
    await logActivity(req.user, 'user_created', userId, `Created account ${email}`);

    // No mail service is configured in this backend yet, so we can't
    // actually send anything - we just tell the admin that plainly
    // instead of pretending it went out.
    const note = sendWelcomeEmail
      ? 'User created. No email was sent - this backend has no mail service configured yet.'
      : 'User created.';

    res.status(201).json({ message: note, user });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to create user:', err);
    res.status(500).json({ error: 'Failed to create user.' });
  } finally {
    client.release();
  }
});

// POST /api/admin/users/:id/extend
// Body: { "days": 30 }
// Adds `days` to the user's current expiry date (or from today if
// their subscription already ran out).
router.post('/users/:id/extend', async (req, res) => {
  const userId = req.params.id;
  try {
    const days = Number(req.body.days) || 30;
    console.log(`Extending subscription for user ${userId} by ${days} days`);
    const result = await pool.query(
      'SELECT expires_at FROM subscriptions WHERE user_id = $1',
      [userId]
    );
    const current = result.rows[0];

    if (!current) {
      return res.status(404).json({ error: 'User has no subscription record.' });
    }

    const currentExpiry = current.expires_at ? new Date(current.expires_at) : new Date();
    const base = currentExpiry > new Date() ? currentExpiry : new Date();
    base.setDate(base.getDate() + days);

    await pool.query(
      `UPDATE subscriptions
       SET status = 'active', expires_at = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [base, userId]
    );

    console.log(`Subscription extended for user ${userId}`);
    await logActivity(req.user, 'subscription_extended', userId, `Extended by ${days} days`);
    res.json({ message: `Extended by ${days} days.`, newExpiresAt: base });
  } catch (err) {
    console.error(`Failed to extend subscription for user ${userId}:`, err);
    res.status(500).json({ error: 'Failed to extend subscription.' });
  }
});

// POST /api/admin/users/:id/end
// Immediately ends a user's subscription. M-Pesa payments are one-off
// (nothing renews automatically), so there is nothing to cancel on
// Safaricom's side - we just mark it cancelled here.
router.post('/users/:id/end', async (req, res) => {
  const userId = req.params.id;
  try {
    console.log(`Ending subscription for user ${userId}`);

    await pool.query(
      `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );

    console.log(`Subscription ended for user ${userId}`);
    await logActivity(req.user, 'subscription_ended', userId, 'Subscription ended');
    res.json({ message: 'Subscription ended.' });
  } catch (err) {
    console.error(`Failed to end subscription for user ${userId}:`, err);
    res.status(500).json({ error: 'Failed to end subscription.' });
  }
});

// POST /api/admin/users/:id/reactivate
// Body: { "planType": "monthly", "days": 30 }
// For a user whose subscription is expired/cancelled - starts a fresh
// active period. Meant to be used from the dashboard when a user has
// paid outside the app (e.g. manually, or over a support conversation).
router.post('/users/:id/reactivate', async (req, res) => {
  const userId = req.params.id;
  const { planType, days } = req.body;

  if (planType && planType !== 'monthly' && planType !== 'yearly') {
    return res.status(400).json({ error: "planType must be 'monthly' or 'yearly'." });
  }
  const numDays = Number(days);
  if (!numDays || numDays <= 0) {
    return res.status(400).json({ error: 'days must be a positive number.' });
  }

  try {
    const existing = await pool.query(
      'SELECT plan_type FROM subscriptions WHERE user_id = $1',
      [userId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User has no subscription record.' });
    }

    const finalPlanType = planType || existing.rows[0].plan_type || 'monthly';
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + numDays);

    console.log(`Reactivating subscription for user ${userId}: ${finalPlanType}, ${numDays} days`);
    await pool.query(
      `UPDATE subscriptions
       SET plan_type = $1, status = 'active', started_at = NOW(), expires_at = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [finalPlanType, expiresAt, userId]
    );

    const user = await getUserRow(userId);
    await logActivity(req.user, 'subscription_reactivated', userId, `${finalPlanType}, ${numDays} days`);
    res.json({ message: 'Subscription reactivated.', user });
  } catch (err) {
    console.error(`Failed to reactivate subscription for user ${userId}:`, err);
    res.status(500).json({ error: 'Failed to reactivate subscription.' });
  }
});

// POST /api/admin/users/:id/reset-password
// Generates a new temporary password, hashes it, and returns the
// plain-text version ONCE in the response so the admin can hand it to
// the user. It is never stored or logged in plain text.
router.post('/users/:id/reset-password', async (req, res) => {
  const target = await loadNonAdminTarget(req, res);
  if (!target) return;

  try {
    const temporaryPassword = crypto.randomBytes(9).toString('base64url'); // 12 readable chars
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, target.id]);

    console.log(`Password reset for user ${target.id}`);
    await logActivity(req.user, 'password_reset', target.id, 'Temporary password generated');
    res.json({ message: 'Password reset.', temporaryPassword });
  } catch (err) {
    console.error(`Failed to reset password for user ${target.id}:`, err);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// POST /api/admin/users/:id/disable
// Blocks the account from logging in (Flutter app and admin panel
// alike) without deleting any of their data.
router.post('/users/:id/disable', async (req, res) => {
  const target = await loadNonAdminTarget(req, res);
  if (!target) return;

  try {
    await pool.query('UPDATE users SET is_disabled = TRUE WHERE id = $1', [target.id]);
    console.log(`Disabled user ${target.id}`);
    await logActivity(req.user, 'account_disabled', target.id, 'Account disabled');
    const user = await getUserRow(target.id);
    res.json({ message: 'Account disabled.', user });
  } catch (err) {
    console.error(`Failed to disable user ${target.id}:`, err);
    res.status(500).json({ error: 'Failed to disable account.' });
  }
});

// POST /api/admin/users/:id/enable
// Reverses /disable.
router.post('/users/:id/enable', async (req, res) => {
  const target = await loadNonAdminTarget(req, res);
  if (!target) return;

  try {
    await pool.query('UPDATE users SET is_disabled = FALSE WHERE id = $1', [target.id]);
    console.log(`Re-enabled user ${target.id}`);
    await logActivity(req.user, 'account_enabled', target.id, 'Account re-enabled');
    const user = await getUserRow(target.id);
    res.json({ message: 'Account re-enabled.', user });
  } catch (err) {
    console.error(`Failed to enable user ${target.id}:`, err);
    res.status(500).json({ error: 'Failed to enable account.' });
  }
});

// DELETE /api/admin/users/:id
// Permanently removes the user (their subscription row and payment
// orders go with them via ON DELETE CASCADE).
router.delete('/users/:id', async (req, res) => {
  const target = await loadNonAdminTarget(req, res);
  if (!target) return;

  try {
    const before = await pool.query('SELECT email FROM users WHERE id = $1', [target.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [target.id]);
    console.log(`Deleted user ${target.id}`);
    await logActivity(req.user, 'account_deleted', target.id, `Deleted account ${before.rows[0]?.email}`);
    res.json({ message: 'Account deleted.' });
  } catch (err) {
    console.error(`Failed to delete user ${target.id}:`, err);
    res.status(500).json({ error: 'Failed to delete account.' });
  }
});

// ============================================================
// NEW: edit a user, user details, settings, activity, notifications
// ============================================================

// GET /api/admin/users/:id
// One user plus their last 10 M-Pesa payments (for the details drawer).
router.get('/users/:id', async (req, res) => {
  try {
    const user = await getUserRow(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const orders = await pool.query(
      `SELECT id, plan_type, amount, phone_number, status, mpesa_receipt_number, created_at
       FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.params.id]
    );
    res.json({ user, payments: orders.rows });
  } catch (err) {
    console.error('Failed to load user:', err);
    res.status(500).json({ error: 'Failed to load user.' });
  }
});

// PATCH /api/admin/users/:id
// Body: { "name": "...", "email": "..." }  (send one or both)
// This is how an admin changes a user's name or email.
router.patch('/users/:id', async (req, res) => {
  const target = await loadNonAdminTarget(req, res);
  if (!target) return;

  const hasName = req.body.name !== undefined;
  const hasEmail = req.body.email !== undefined;
  if (!hasName && !hasEmail) {
    return res.status(400).json({ error: 'Send a name or an email to update.' });
  }

  try {
    const current = await pool.query('SELECT email, name FROM users WHERE id = $1', [target.id]);
    const old = current.rows[0];

    let newName = old.name;
    let newEmail = old.email;

    if (hasName) {
      newName = String(req.body.name).trim();
      if (!newName) {
        return res.status(400).json({ error: 'Name cannot be empty.' });
      }
    }

    if (hasEmail) {
      newEmail = String(req.body.email).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
      }
      // Is another account already using this email?
      const taken = await pool.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2',
        [newEmail, target.id]
      );
      if (taken.rows.length > 0) {
        return res.status(409).json({ error: 'That email is already used by another account.' });
      }
    }

    await pool.query('UPDATE users SET name = $1, email = $2 WHERE id = $3', [
      newName,
      newEmail,
      target.id,
    ]);

    const changes = [];
    if (newEmail !== old.email) changes.push(`email ${old.email} -> ${newEmail}`);
    if (newName !== old.name) changes.push(`name ${old.name || '(none)'} -> ${newName}`);
    if (changes.length > 0) {
      await logActivity(req.user, 'user_updated', target.id, changes.join(', '));
    }

    const user = await getUserRow(target.id);
    res.json({ message: 'User updated.', user });
  } catch (err) {
    console.error(`Failed to update user ${target.id}:`, err);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

// GET /api/admin/settings
router.get('/settings', async (req, res) => {
  try {
    res.json({ settings: await getSettings() });
  } catch (err) {
    console.error('Failed to load settings:', err);
    res.status(500).json({ error: 'Failed to load settings.' });
  }
});

// PUT /api/admin/settings
// Body (any of): { registrationEnabled: bool, loginEnabled: bool, blockMessage: string }
// registrationEnabled=false -> nobody new can sign up.
// loginEnabled=false        -> normal users can't log in (admins still can).
router.put('/settings', async (req, res) => {
  const { registrationEnabled, loginEnabled, blockMessage } = req.body;

  if (registrationEnabled !== undefined && typeof registrationEnabled !== 'boolean') {
    return res.status(400).json({ error: 'registrationEnabled must be true or false.' });
  }
  if (loginEnabled !== undefined && typeof loginEnabled !== 'boolean') {
    return res.status(400).json({ error: 'loginEnabled must be true or false.' });
  }
  if (blockMessage !== undefined && (typeof blockMessage !== 'string' || blockMessage.length > 200)) {
    return res.status(400).json({ error: 'blockMessage must be text of 200 characters or less.' });
  }

  try {
    const changes = [];
    if (registrationEnabled !== undefined) {
      await saveSetting('registration_enabled', registrationEnabled);
      changes.push(`sign-ups ${registrationEnabled ? 'opened' : 'closed'}`);
    }
    if (loginEnabled !== undefined) {
      await saveSetting('login_enabled', loginEnabled);
      changes.push(`user login ${loginEnabled ? 'opened' : 'closed'}`);
    }
    if (blockMessage !== undefined) {
      await saveSetting('block_message', blockMessage.trim());
      changes.push('block message changed');
    }
    if (changes.length > 0) {
      await logActivity(req.user, 'settings_changed', null, changes.join(', '));
    }
    res.json({ message: 'Settings saved.', settings: await getSettings() });
  } catch (err) {
    console.error('Failed to save settings:', err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

// GET /api/admin/activity?page=1&pageSize=20
// What admins have done, newest first.
router.get('/activity', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));

  try {
    const total = await pool.query('SELECT COUNT(*)::int AS count FROM admin_activity');
    const rows = await pool.query(
      `SELECT id, admin_email, action, target_user_id, details, created_at
       FROM admin_activity ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize]
    );
    res.json({ activity: rows.rows, total: total.rows[0].count, page, pageSize });
  } catch (err) {
    console.error('Failed to load activity:', err);
    res.status(500).json({ error: 'Failed to load activity.' });
  }
});

// GET /api/admin/notifications
// Worked out on the fly from existing data (no extra table):
// subscriptions about to expire, ones that just expired, failed payments,
// and new sign-ups from the last 7 days.
router.get('/notifications', async (req, res) => {
  try {
    const expiring = await pool.query(
      `SELECT users.id, users.email, users.name, subscriptions.expires_at
       FROM subscriptions JOIN users ON users.id = subscriptions.user_id
       WHERE users.is_admin = FALSE AND subscriptions.status = 'active'
         AND subscriptions.expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
       ORDER BY subscriptions.expires_at ASC LIMIT 50`
    );
    const expired = await pool.query(
      `SELECT users.id, users.email, users.name, subscriptions.expires_at
       FROM subscriptions JOIN users ON users.id = subscriptions.user_id
       WHERE users.is_admin = FALSE AND subscriptions.status = 'active'
         AND subscriptions.expires_at < NOW() AND subscriptions.expires_at > NOW() - INTERVAL '7 days'
       ORDER BY subscriptions.expires_at DESC LIMIT 50`
    );
    const failed = await pool.query(
      `SELECT orders.id, orders.status, orders.amount, orders.result_desc, orders.created_at,
              users.id AS user_id, users.email
       FROM orders JOIN users ON users.id = orders.user_id
       WHERE orders.status IN ('FAILED', 'CANCELLED') AND orders.created_at > NOW() - INTERVAL '7 days'
       ORDER BY orders.created_at DESC LIMIT 50`
    );
    const signups = await pool.query(
      `SELECT id, email, name, created_at FROM users
       WHERE is_admin = FALSE AND created_at > NOW() - INTERVAL '7 days'
       ORDER BY created_at DESC LIMIT 50`
    );

    const notifications = [
      ...expiring.rows.map((r) => ({
        type: 'expiring_soon',
        userId: r.id,
        title: 'Subscription expiring soon',
        message: `${r.name || r.email} expires on ${new Date(r.expires_at).toISOString().slice(0, 10)}.`,
        createdAt: r.expires_at,
      })),
      ...expired.rows.map((r) => ({
        type: 'expired',
        userId: r.id,
        title: 'Subscription expired',
        message: `${r.name || r.email}'s subscription ran out.`,
        createdAt: r.expires_at,
      })),
      ...failed.rows.map((r) => ({
        type: 'payment_failed',
        userId: r.user_id,
        title: r.status === 'CANCELLED' ? 'Payment cancelled' : 'Payment failed',
        message: `${r.email}: KES ${r.amount}${r.result_desc ? ' - ' + r.result_desc : ''}`,
        createdAt: r.created_at,
      })),
      ...signups.rows.map((r) => ({
        type: 'new_signup',
        userId: r.id,
        title: 'New sign-up',
        message: `${r.name || r.email} joined.`,
        createdAt: r.created_at,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ notifications });
  } catch (err) {
    console.error('Failed to load notifications:', err);
    res.status(500).json({ error: 'Failed to load notifications.' });
  }
});

module.exports = router;
