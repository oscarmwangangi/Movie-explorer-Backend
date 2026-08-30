// Handles: starting a PayPal subscription, PayPal telling us it was
// paid (the webhook), and the Flutter app checking "am I still paid?"

const express = require('express');
const paypal = require('../services/paypalClient');
const pool = require('../db/pool');
const { requireLogin } = require('../middleware/auth');
const { calculateExpiryDate, activateSubscriptionIfPaid } = require('../services/subscriptionHelpers');
require('dotenv').config();

const router = express.Router();

// POST /api/subscriptions/start
// Body: { "planType": "monthly" }  or  { "planType": "yearly" }
//
// The Flutter app calls this when the user taps "Subscribe".
// We create the subscription on PayPal's side and send back an
// "approval link" - a URL the user opens to approve the payment.
router.post('/start', requireLogin, async (req, res) => {
  const { planType } = req.body;

  const planId =
    planType === 'monthly'
      ? process.env.PAYPAL_MONTHLY_PLAN_ID
      : planType === 'yearly'
      ? process.env.PAYPAL_YEARLY_PLAN_ID
      : null;

  if (!planId) {
    return res.status(400).json({ error: "planType must be 'monthly' or 'yearly'." });
  }

  try {
    const subscription = await paypal.post('/v1/billing/subscriptions', {
      plan_id: planId,
      application_context: {
        return_url: process.env.PAYPAL_RETURN_URL,
        cancel_url: process.env.PAYPAL_CANCEL_URL,
        user_action: 'SUBSCRIBE_NOW',
      },
    });

    // Save it as "pending" - it only becomes "active" once PayPal's
    // webhook tells us the user actually approved and paid.
    await pool.query(
      `UPDATE subscriptions
       SET plan_type = $1, status = 'pending', paypal_subscription_id = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [planType, subscription.id, req.user.userId]
    );

    // PayPal gives back several links; the "approve" one is what the
    // user needs to open to complete payment.
    const approveLink = subscription.links.find((link) => link.rel === 'approve');

    res.json({ approveUrl: approveLink.href });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Could not start the subscription with PayPal.' });
  }
});

// GET /api/subscriptions/me
// The Flutter app calls this to check "is this user allowed in?"
router.get('/me', requireLogin, async (req, res) => {
  const result = await pool.query(
    'SELECT plan_type, status, expires_at FROM subscriptions WHERE user_id = $1',
    [req.user.userId]
  );
  const sub = result.rows[0];

  if (!sub) {
    return res.json({ status: 'none' });
  }

  // If the expiry date has passed but we haven't updated the status
  // yet (e.g. PayPal's webhook hasn't fired), treat it as expired.
  const isExpiredByDate = sub.expires_at && new Date(sub.expires_at) < new Date();
  const status = sub.status === 'active' && isExpiredByDate ? 'expired' : sub.status;

  res.json({
    planType: sub.plan_type,
    status,
    expiresAt: sub.expires_at,
  });
});

// POST /api/subscriptions/webhook
// PayPal calls THIS endpoint automatically - the user's browser never
// touches it. This is how we find out a payment actually succeeded.
//
// NOTE for junior devs: in production you should also VERIFY the
// webhook signature so nobody can fake a "payment succeeded" call.
// See: https://developer.paypal.com/api/rest/webhooks/rest/
// For learning/sandbox purposes this simplified version just trusts
// the event - don't skip verification once you go live with real money.
router.post('/webhook', async (req, res) => {
  const event = req.body;
  const eventType = event.event_type;

  console.log('PayPal webhook received:', eventType);

  try {
    if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const paypalSubId = event.resource.id;
      await activateSubscriptionIfPaid(paypalSubId);
    }

    // Each successful renewal payment - push the expiry date forward again.
    if (eventType === 'PAYMENT.SALE.COMPLETED') {
      const paypalSubId = event.resource.billing_agreement_id;
      if (paypalSubId) {
        const result = await pool.query(
          'SELECT plan_type FROM subscriptions WHERE paypal_subscription_id = $1',
          [paypalSubId]
        );
        if (result.rows[0]) {
          const expiresAt = calculateExpiryDate(result.rows[0].plan_type);
          await pool.query(
            `UPDATE subscriptions
             SET status = 'active', expires_at = $1, updated_at = NOW()
             WHERE paypal_subscription_id = $2`,
            [expiresAt, paypalSubId]
          );
        }
      }
    }

    if (
      eventType === 'BILLING.SUBSCRIPTION.CANCELLED' ||
      eventType === 'BILLING.SUBSCRIPTION.EXPIRED' ||
      eventType === 'BILLING.SUBSCRIPTION.SUSPENDED'
    ) {
      const paypalSubId = event.resource.id;
      await pool.query(
        `UPDATE subscriptions SET status = 'expired', updated_at = NOW()
         WHERE paypal_subscription_id = $1`,
        [paypalSubId]
      );
    }

    // Always tell PayPal "got it, 200 OK" - otherwise it keeps retrying.
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook handling failed:', err);
    res.sendStatus(500);
  }
});

module.exports = router;
