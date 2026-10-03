// Handles: the Flutter app checking "am I still paid?"
//
// (Paying is handled in routes/payments.js - M-Pesa STK push.)

const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// GET /api/subscriptions/me
// The Flutter app calls this to check "is this user allowed in?"
router.get('/me', requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT plan_type, status, expires_at FROM subscriptions WHERE user_id = $1',
      [req.user.userId]
    );
    const sub = result.rows[0];

    if (!sub) {
      console.log(`No subscription found for user ${req.user.userId}`);
      return res.json({ status: 'none' });
    }

    const isExpiredByDate = sub.expires_at && new Date(sub.expires_at) < new Date();
    const status = sub.status === 'active' && isExpiredByDate ? 'expired' : sub.status;

    console.log(`Subscription status for user ${req.user.userId}: ${status}`);
    res.json({
      planType: sub.plan_type,
      status,
      expiresAt: sub.expires_at,
    });
  } catch (err) {
    console.error(`Failed to load subscription for user ${req.user.userId}:`, err);
    res.status(500).json({ error: 'Failed to fetch subscription status.' });
  }
});

module.exports = router;
