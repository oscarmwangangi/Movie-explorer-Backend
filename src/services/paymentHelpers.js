// The "brain" of M-Pesa payments: given the result of a payment, update
// the order and (if the customer paid) activate their subscription.
//
// It is used by TWO places:
//   - POST /api/payments/callback  (Safaricom tells us automatically)
//   - GET  /api/payments/status/:id (our backup check, if the callback is late or lost)
// Keeping the logic here means both paths update the database in exactly
// the same way.

const pool = require('../db/pool');
const { calculateExpiryDate } = require('./subscriptionHelpers');

// Safaricom's ResultCode -> a message the customer can understand.
// (0 = success. Everything else means the payment did NOT go through.)
const FRIENDLY_MESSAGES = {
  0: 'Payment received. Thank you!',
  1: 'Your M-Pesa balance is too low. Please top up and try again.',
  1001: 'Another M-Pesa transaction is in progress on your phone. Wait a moment and try again.',
  1019: 'The payment request expired. Please try again.',
  1032: 'You cancelled the payment request.',
  1037: 'The payment request timed out. Make sure your phone is on, then try again and enter your PIN when the prompt appears.',
  2001: 'The M-Pesa PIN you entered was wrong. Please try again.',
};

// Turns an order into a message for the app.
function getFriendlyMessage(status, resultCode) {
  if (status === 'PENDING') return 'Waiting for you to enter your M-Pesa PIN...';
  if (resultCode !== null && resultCode !== undefined && FRIENDLY_MESSAGES[resultCode]) {
    return FRIENDLY_MESSAGES[resultCode];
  }
  return 'The payment could not be completed. You have not been charged. Please try again.';
}

// Short labels for the admin dashboard (the long messages above are for customers).
const SHORT_REASONS = {
  1: 'Insufficient balance',
  1001: 'Another transaction in progress',
  1019: 'Request expired',
  1032: 'Cancelled by customer',
  1037: 'Prompt timed out',
  2001: 'Wrong PIN',
};

function getShortReason(resultCode) {
  if (resultCode === null || resultCode === undefined) return 'Could not send prompt';
  return SHORT_REASONS[resultCode] || 'Other failure';
}

// ResultCode -> the status we store on the order.
//   0    -> COMPLETED
//   1032 -> CANCELLED (customer pressed cancel)
//   else -> FAILED   (insufficient balance, wrong PIN, timeout, ...)
function getOrderStatus(resultCode) {
  if (resultCode === 0) return 'COMPLETED';
  if (resultCode === 1032) return 'CANCELLED';
  return 'FAILED';
}

// Gives the user a paid subscription. Runs INSIDE a database transaction,
// so "client" is the transaction's connection (not the shared pool).
async function activateSubscription(client, userId, planType) {
  const existing = await client.query(
    'SELECT id, expires_at FROM subscriptions WHERE user_id = $1',
    [userId]
  );

  // If they still have time left, add the new period on top of it.
  const now = new Date();
  const oldExpiry = existing.rows[0]?.expires_at ? new Date(existing.rows[0].expires_at) : null;
  const startFrom = oldExpiry && oldExpiry > now ? oldExpiry : now;
  const expiresAt = calculateExpiryDate(planType, startFrom);

  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE subscriptions
       SET plan_type = $1, status = 'active', started_at = NOW(), expires_at = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [planType, expiresAt, userId]
    );
  } else {
    // Every user normally has a row already, but just in case:
    await client.query(
      `INSERT INTO subscriptions (user_id, plan_type, status, started_at, expires_at)
       VALUES ($1, $2, 'active', NOW(), $3)`,
      [userId, planType, expiresAt]
    );
  }
}

// Records the final result of a payment.
//   resultCode:    number from Safaricom (0 = paid)
//   resultDesc:    Safaricom's text description
//   receiptNumber: the M-Pesa receipt (e.g. "QGR7XXXXXX"), or null if we don't have it
//
// Returns true if this call updated the order, false if the order was
// not found or had already been settled. It is SAFE TO CALL TWICE for the
// same payment: only a PENDING order can be updated, so a duplicate
// callback can never extend a subscription twice.
async function applyPaymentResult({ checkoutRequestId, resultCode, resultDesc, receiptNumber }) {
  const newStatus = getOrderStatus(resultCode);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updated = await client.query(
      `UPDATE orders
       SET status = $1, result_code = $2, result_desc = $3, mpesa_receipt_number = $4, updated_at = NOW()
       WHERE checkout_request_id = $5 AND status = 'PENDING'
       RETURNING user_id, plan_type`,
      [newStatus, resultCode, resultDesc || null, receiptNumber || null, checkoutRequestId]
    );

    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      console.log(`Order for ${checkoutRequestId} not found or already settled - nothing to do.`);
      return false;
    }

    if (newStatus === 'COMPLETED') {
      const { user_id, plan_type } = updated.rows[0];
      await activateSubscription(client, user_id, plan_type);
      console.log(`Order ${checkoutRequestId} COMPLETED - subscription activated for user ${user_id}`);
    } else {
      console.log(`Order ${checkoutRequestId} ${newStatus} (ResultCode ${resultCode}: ${resultDesc})`);
    }

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyPaymentResult, getFriendlyMessage, getShortReason };
