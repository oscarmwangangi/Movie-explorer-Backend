// Shared logic for "mark this PayPal subscription as active in our
// database". Used by BOTH:
//   - the webhook (routes/subscriptions.js) - the proper way, PayPal
//     tells us automatically
//   - the return page (routes/paypal.js) - a fallback for local
//     testing, where PayPal can't reach our webhook because it can't
//     reach "localhost"
//
// Keeping this in one place means both paths update the database in
// exactly the same way.

const pool = require('../db/pool');
const paypal = require('./paypalClient');

function calculateExpiryDate(planType) {
  const now = new Date();
  if (planType === 'yearly') {
    now.setFullYear(now.getFullYear() + 1);
  } else {
    now.setMonth(now.getMonth() + 1);
  }
  return now;
}

// Looks up the subscription directly on PayPal (the source of truth),
// and if PayPal confirms it's ACTIVE, updates our database to match.
// Returns the new status ('active' or whatever PayPal reports).
async function activateSubscriptionIfPaid(paypalSubId) {
  try {
    console.log(`Checking PayPal subscription ${paypalSubId}`);
    const subscription = await paypal.get(`/v1/billing/subscriptions/${paypalSubId}`);

    if (subscription.status !== 'ACTIVE') {
      console.log(`PayPal subscription ${paypalSubId} status: ${subscription.status}`);
      return subscription.status;
    }

    const result = await pool.query(
      'SELECT plan_type FROM subscriptions WHERE paypal_subscription_id = $1',
      [paypalSubId]
    );
    const planType = result.rows[0]?.plan_type || 'monthly';
    const expiresAt = calculateExpiryDate(planType);

    await pool.query(
      `UPDATE subscriptions
       SET status = 'active', started_at = NOW(), expires_at = $1, updated_at = NOW()
       WHERE paypal_subscription_id = $2`,
      [expiresAt, paypalSubId]
    );

    console.log(`Subscription ${paypalSubId} activated`);
    return 'active';
  } catch (err) {
    console.error(`Failed to activate subscription ${paypalSubId}:`, err.response?.data || err);
    throw err;
  }
}

module.exports = { calculateExpiryDate, activateSubscriptionIfPaid };
