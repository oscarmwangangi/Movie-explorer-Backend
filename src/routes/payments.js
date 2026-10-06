// Everything about paying with M-Pesa:
//
//   POST /api/payments/stk-push          (logged-in user)  start a payment
//   GET  /api/payments/status/:id        (logged-in user)  check if it went through
//   POST /api/payments/callback          (Safaricom only)  Safaricom reports the result
//
// How a payment flows:
//   1. The app calls /stk-push with a plan and a phone number.
//   2. We save a PENDING order, then ask Safaricom to show the PIN prompt.
//   3. The customer enters their PIN (or cancels, or has no money...).
//   4. Safaricom calls /callback with the result -> we mark the order
//      COMPLETED / FAILED / CANCELLED and activate the subscription if paid.
//   5. Meanwhile the app calls /status every few seconds to see the result.

const express = require('express');
const pool = require('../db/pool');
const mpesa = require('../services/mpesaClient');
const { applyPaymentResult, getFriendlyMessage } = require('../services/paymentHelpers');
const { requireLogin, requireMpesaCallbackToken } = require('../middleware/auth');
require('dotenv').config();

const router = express.Router();

// How much each plan costs, in Kenya Shillings (whole numbers only).
// Change the prices in .env - these numbers are just the fallback.
function getPlanAmount(planType) {
  if (planType === 'monthly') return Number(process.env.MPESA_MONTHLY_AMOUNT) || 130;
  if (planType === 'yearly') return Number(process.env.MPESA_YEARLY_AMOUNT) || 1300;
  return null;
}

// While a payment prompt is open on the customer's phone, we don't let them
// start another one (otherwise they'd get two prompts and could pay twice).
const PENDING_WINDOW_SECONDS = 90;

// If an order is still PENDING after this many seconds, the status endpoint
// asks Safaricom directly instead of waiting for the callback.
const ASK_SAFARICOM_AFTER_SECONDS = 20;

// ---------------------------------------------------------------
// POST /api/payments/stk-push
// Body: { "planType": "monthly" | "yearly", "phoneNumber": "07XXXXXXXX" or "2547XXXXXXXX" }
// ---------------------------------------------------------------
router.post('/stk-push', requireLogin, async (req, res) => {
  const { planType, phoneNumber } = req.body;
  const userId = req.user.userId;
  console.log(`STK push requested by user ${userId}: ${planType}`);

  // 1. Check what the app sent us.
  const amount = getPlanAmount(planType);
  if (!amount) {
    return res.status(400).json({ error: "planType must be 'monthly' or 'yearly'." });
  }

  const phone = mpesa.normalizePhone(phoneNumber);
  if (!phone) {
    return res.status(400).json({
      error: 'Enter a valid M-Pesa number, like 0712345678 or 254712345678.',
    });
  }

  try {
    // 2. Is a payment already waiting on this user's phone?
    const recent = await pool.query(
      `SELECT 1 FROM orders
       WHERE user_id = $1 AND status = 'PENDING'
         AND created_at > NOW() - ($2 * INTERVAL '1 second')`,
      [userId, PENDING_WINDOW_SECONDS]
    );
    if (recent.rows.length > 0) {
      return res.status(409).json({
        error: 'A payment request is already waiting on your phone. Finish it, or wait a minute and try again.',
      });
    }

    // 3. Save the order as PENDING *before* contacting Safaricom, so there
    //    is always a record of the attempt. We don't know the CheckoutRequestID yet.
    const insert = await pool.query(
      `INSERT INTO orders (user_id, plan_type, amount, phone_number, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING id`,
      [userId, planType, amount, phone]
    );
    const orderId = insert.rows[0].id;

    // 4. Ask Safaricom to show the PIN prompt on the customer's phone.
    let safaricomResponse;
    try {
      safaricomResponse = await mpesa.stkPush({
        phone,
        amount,
        accountReference: 'MovieExplorer', // max 12 characters
        description: 'Subscription', // max 13 characters
      });
    } catch (err) {
      console.error('STK push failed:', err.response?.data || err.message);
      await pool.query(
        `UPDATE orders SET status = 'FAILED', result_desc = $1, updated_at = NOW() WHERE id = $2`,
        ['Could not send STK push', orderId]
      );
      return res.status(502).json({ error: 'Could not reach M-Pesa. Please try again in a moment.' });
    }

    // ResponseCode "0" means "prompt sent". Anything else means Safaricom refused.
    if (String(safaricomResponse.ResponseCode) !== '0') {
      console.error('STK push rejected:', safaricomResponse);
      await pool.query(
        `UPDATE orders SET status = 'FAILED', result_desc = $1, updated_at = NOW() WHERE id = $2`,
        [safaricomResponse.ResponseDescription || 'STK push rejected', orderId]
      );
      return res.status(502).json({ error: 'M-Pesa did not accept the request. Please try again.' });
    }

    // 5. Store the CheckoutRequestID on the order. This is the "key" Safaricom
    //    will send back in the callback so we can find this order again.
    await pool.query(
      `UPDATE orders SET checkout_request_id = $1, merchant_request_id = $2, updated_at = NOW() WHERE id = $3`,
      [safaricomResponse.CheckoutRequestID, safaricomResponse.MerchantRequestID, orderId]
    );

    console.log(`STK push sent for order ${orderId}: ${safaricomResponse.CheckoutRequestID}`);
    res.json({
      checkoutRequestId: safaricomResponse.CheckoutRequestID,
      message: 'Check your phone and enter your M-Pesa PIN to complete the payment.',
    });
  } catch (err) {
    console.error('Failed to start M-Pesa payment:', err);
    res.status(500).json({ error: 'Could not start the payment.' });
  }
});

// ---------------------------------------------------------------
// GET /api/payments/status/:checkoutRequestId
// The app calls this every few seconds while the spinner is showing.
// Returns: { status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED', message, ... }
// ---------------------------------------------------------------
router.get('/status/:checkoutRequestId', requireLogin, async (req, res) => {
  const { checkoutRequestId } = req.params;

  try {
    // We also check user_id, so one user can never look at another user's order.
    const orderQuery = `
      SELECT status, result_code, plan_type, amount, mpesa_receipt_number,
             EXTRACT(EPOCH FROM (NOW() - created_at)) AS age_seconds
      FROM orders
      WHERE checkout_request_id = $1 AND user_id = $2`;

    let result = await pool.query(orderQuery, [checkoutRequestId, req.user.userId]);
    let order = result.rows[0];

    if (!order) {
      return res.status(404).json({ error: 'Payment not found.' });
    }

    // Backup plan: the callback should have arrived by now. If it hasn't
    // (e.g. it got lost, or you are testing on localhost where Safaricom
    // can't reach you), ask Safaricom directly what happened.
    if (order.status === 'PENDING' && Number(order.age_seconds) >= ASK_SAFARICOM_AFTER_SECONDS) {
      try {
        const answer = await mpesa.stkQuery(checkoutRequestId);

        if (!answer.pending && answer.ResultCode !== undefined) {
          await applyPaymentResult({
            checkoutRequestId,
            resultCode: Number(answer.ResultCode),
            resultDesc: answer.ResultDesc,
            receiptNumber: null, // the query does not return the receipt number
          });
          // Read the order again so we return the fresh status.
          result = await pool.query(orderQuery, [checkoutRequestId, req.user.userId]);
          order = result.rows[0];
        }
      } catch (err) {
        // Not a big problem - the app will simply ask again in a few seconds.
        console.error('STK query failed:', err.response?.data || err.message);
      }
    }

    res.json({
      status: order.status,
      message: getFriendlyMessage(order.status, order.result_code),
      planType: order.plan_type,
      amount: order.amount,
      receipt: order.mpesa_receipt_number,
    });
  } catch (err) {
    console.error('Failed to load payment status:', err);
    res.status(500).json({ error: 'Could not check the payment status.' });
  }
});

// ---------------------------------------------------------------
// POST /api/payments/callback?token=SECRET
// Safaricom calls THIS endpoint (the customer's phone never does).
// requireMpesaCallbackToken makes sure only Safaricom (who knows the
// secret in the URL) can use it.
//
// Safaricom sends something like:
//   { Body: { stkCallback: {
//       MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc,
//       CallbackMetadata: { Item: [ {Name:'Amount', Value:130}, {Name:'MpesaReceiptNumber', Value:'QGR...'}, ... ] }
//   } } }
// CallbackMetadata only exists when the payment succeeded.
// ---------------------------------------------------------------
router.post('/callback', requireMpesaCallbackToken, async (req, res) => {
  // Tell Safaricom "got it". We always send this once the request is authenticated.
  const accepted = { ResultCode: 0, ResultDesc: 'Accepted' };

  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback || !callback.CheckoutRequestID) {
      console.error('M-Pesa callback had an unexpected shape:', JSON.stringify(req.body));
      return res.json(accepted);
    }

    const checkoutRequestId = callback.CheckoutRequestID;
    const resultCode = Number(callback.ResultCode);
    console.log(`M-Pesa callback received: ${checkoutRequestId} ResultCode=${resultCode}`);

    // Pull the details out of CallbackMetadata (only present on success).
    const items = callback.CallbackMetadata?.Item || [];
    const getItem = (name) => items.find((item) => item.Name === name)?.Value;
    const receiptNumber = getItem('MpesaReceiptNumber');
    const amountPaid = getItem('Amount');

    if (resultCode === 0) {
      // Extra safety: the amount Safaricom says was paid must match the order.
      const orderResult = await pool.query(
        'SELECT amount FROM orders WHERE checkout_request_id = $1',
        [checkoutRequestId]
      );
      const order = orderResult.rows[0];

      if (order && Number(amountPaid) !== Number(order.amount)) {
        console.error(
          `Amount mismatch for ${checkoutRequestId}: order is ${order.amount}, callback says ${amountPaid}. Ignoring.`
        );
        return res.json(accepted);
      }
    }

    await applyPaymentResult({
      checkoutRequestId,
      resultCode,
      resultDesc: callback.ResultDesc,
      receiptNumber,
    });

    res.json(accepted);
  } catch (err) {
    console.error('Failed to process M-Pesa callback:', err);
    res.status(500).json({ error: 'Failed to process callback.' });
  }
});

module.exports = router;
