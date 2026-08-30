// Everything here is only usable by an admin (see requireAdmin below).
// This is what your React admin dashboard talks to.

const express = require('express');
const pool = require('../db/pool');
const paypal = require('../services/paypalClient');
const { requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Every route in this file needs the user to be logged in AND an admin.
router.use(requireLogin, requireAdmin);

// GET /api/admin/users
// Returns every user with their subscription info, for the table
// in the dashboard: email, last login, plan, status, expiry.
router.get('/users', async (req, res) => {
  const result = await pool.query(`
    SELECT
      users.id,
      users.email,
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

  // Compute a friendly "actual status" here too, same logic as /me,
  // so the dashboard always matches what the app itself sees.
  const users = result.rows.map((user) => {
    const isExpiredByDate = user.expires_at && new Date(user.expires_at) < new Date();
    const status = user.status === 'active' && isExpiredByDate ? 'expired' : user.status;
    return { ...user, status };
  });

  res.json({ users });
});

// POST /api/admin/users/:id/extend
// Body: { "days": 30 }
// Adds `days` to the user's current expiry date (or from today if
// their subscription already ran out).
router.post('/users/:id/extend', async (req, res) => {
  const userId = req.params.id;
  const days = Number(req.body.days) || 30;

  const result = await pool.query(
    'SELECT expires_at FROM subscriptions WHERE user_id = $1',
    [userId]
  );
  const current = result.rows[0];

  if (!current) {
    return res.status(404).json({ error: 'User has no subscription record.' });
  }

  // Extend from whichever is later: today, or their current expiry date.
  const currentExpiry = current.expires_at ? new Date(current.expires_at) : new Date();
  const base = currentExpiry > new Date() ? currentExpiry : new Date();
  base.setDate(base.getDate() + days);

  await pool.query(
    `UPDATE subscriptions
     SET status = 'active', expires_at = $1, updated_at = NOW()
     WHERE user_id = $2`,
    [base, userId]
  );

  res.json({ message: `Extended by ${days} days.`, newExpiresAt: base });
});

// POST /api/admin/users/:id/end
// Immediately ends a user's subscription (marks expired) and, if we
// have a PayPal subscription ID on file, cancels it on PayPal's side
// too so they don't get billed again.
router.post('/users/:id/end', async (req, res) => {
  const userId = req.params.id;

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
      // Not fatal - the PayPal subscription might already be cancelled.
      // We still end it on our side below.
      console.error('PayPal cancel failed (continuing anyway):', err.response?.data || err.message);
    }
  }

  await pool.query(
    `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1`,
    [userId]
  );

  res.json({ message: 'Subscription ended.' });
});

module.exports = router;
