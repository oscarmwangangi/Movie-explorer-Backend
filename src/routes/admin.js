// Everything here is only usable by an admin (see requireAdmin below).
// This is what your React admin dashboard talks to.

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/pool');
const paypal = require('../services/paypalClient');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { calculateExpiryDate } = require('../services/subscriptionHelpers');

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
    res.json({ message: `Extended by ${days} days.`, newExpiresAt: base });
  } catch (err) {
    console.error(`Failed to extend subscription for user ${userId}:`, err);
    res.status(500).json({ error: 'Failed to extend subscription.' });
  }
});

// POST /api/admin/users/:id/end
// Immediately ends a user's subscription (marks expired) and, if we
// have a PayPal subscription ID on file, cancels it on PayPal's side
// too so they don't get billed again.
router.post('/users/:id/end', async (req, res) => {
  const userId = req.params.id;
  try {
    console.log(`Ending subscription for user ${userId}`);
    const result = await pool.query(
      'SELECT paypal_subscription_id FROM subscriptions WHERE user_id = $1',
      [userId]
    );
    const sub = result.rows[0];

    if (sub?.paypal_subscription_id) {
      try {
        await paypal.post(
          `/v1/billing/subscriptions/${sub.paypal_subscription_id}/cancel`,
          { reason: 'Cancelled by admin' }
        );
      } catch (err) {
        console.error('PayPal cancel failed (continuing anyway):', err.response?.data || err.message);
      }
    }

    await pool.query(
      `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );

    console.log(`Subscription ended for user ${userId}`);
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
// paid outside of PayPal's auto-renewal (e.g. manually, or over a
// support conversation).
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
    const user = await getUserRow(target.id);
    res.json({ message: 'Account re-enabled.', user });
  } catch (err) {
    console.error(`Failed to enable user ${target.id}:`, err);
    res.status(500).json({ error: 'Failed to enable account.' });
  }
});

// DELETE /api/admin/users/:id
// Permanently removes the user (their subscription row goes with them
// via ON DELETE CASCADE). Cancels any live PayPal subscription first
// so they don't keep getting billed for an account that no longer
// exists.
router.delete('/users/:id', async (req, res) => {
  const target = await loadNonAdminTarget(req, res);
  if (!target) return;

  try {
    const subResult = await pool.query(
      'SELECT paypal_subscription_id FROM subscriptions WHERE user_id = $1',
      [target.id]
    );
    const sub = subResult.rows[0];

    if (sub?.paypal_subscription_id) {
      try {
        await paypal.post(
          `/v1/billing/subscriptions/${sub.paypal_subscription_id}/cancel`,
          { reason: 'Account deleted by admin' }
        );
      } catch (err) {
        console.error('PayPal cancel failed (continuing anyway):', err.response?.data || err.message);
      }
    }

    await pool.query('DELETE FROM users WHERE id = $1', [target.id]);
    console.log(`Deleted user ${target.id}`);
    res.json({ message: 'Account deleted.' });
  } catch (err) {
    console.error(`Failed to delete user ${target.id}:`, err);
    res.status(500).json({ error: 'Failed to delete account.' });
  }
});

module.exports = router;
