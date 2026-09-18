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
  try {
    console.log('Loading admin users');
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

    const users = result.rows.map((user) => {
      const isExpiredByDate = user.expires_at && new Date(user.expires_at) < new Date();
      const status = user.status === 'active' && isExpiredByDate ? 'expired' : user.status;
      return { ...user, status };
    });

    console.log(`Loaded ${users.length} admin users`);
    res.json({ users });
  } catch (err) {
    console.error('Failed to load admin users:', err);
    res.status(500).json({ error: 'Failed to load users.' });
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

module.exports = router;
