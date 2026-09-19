// These two pages are what the user's BROWSER lands on after they
// approve (or cancel) payment on PayPal's site. PayPal redirects here
// using the PAYPAL_RETURN_URL / PAYPAL_CANCEL_URL from your .env.
//
// Why this file also updates the database (not just the webhook):
// PayPal's webhook needs to reach your server over the public
// internet. While you're developing on "localhost", PayPal literally
// cannot call your webhook - so without this fallback, your test
// subscription would stay stuck on "pending" forever. Once you deploy
// for real (or use ngrok locally), the webhook will handle this too -
// having both is fine, activateSubscriptionIfPaid() just does nothing
// the second time if it's already active.

const express = require('express');
const { activateSubscriptionIfPaid } = require('../services/subscriptionHelpers');

const router = express.Router();

// Small helper so we don't repeat this HTML twice below.
function simplePage(title, message) {
  return `
    <!doctype html>
    <html>
      <head><title>${title}</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 60px;">
        <h1>${title}</h1>
        <p>${message}</p>
        <p>You can close this window and return to the app.</p>
      </body>
    </html>
  `;
}

// GET /api/paypal/return?subscription_id=...&ba_token=...&token=...
router.get('/return', async (req, res) => {
  // PayPal puts the subscription ID in the "subscription_id" query param.
  const paypalSubId = req.query.subscription_id;

  if (!paypalSubId) {
    return res.status(400).send(simplePage('Something went wrong', 'No subscription ID was provided.'));
  }

  try {
    const status = await activateSubscriptionIfPaid(paypalSubId);

    if (status === 'active') {
      res.send(simplePage('Payment successful!', 'Your subscription is now active.'));
    } else {
      // Happens rarely - e.g. user closed the tab before PayPal fully
      // confirmed. They can try subscribing again from the app.
      res.send(simplePage('Almost done', `Payment status: ${status}. If this doesn't update shortly, try subscribing again.`));
    }
  } catch (err) {
    console.error('Error confirming subscription:', err.response?.data || err.message);
    res.status(500).send(simplePage('Something went wrong', 'We could not confirm your payment. Please contact support.'));
  }
});

// GET /api/paypal/cancel
// The user clicked "Cancel and return" on PayPal's page.
router.get('/cancel', (req, res) => {
  res.send(simplePage('Payment cancelled', 'No charge was made. You can try again anytime from the app.'));
});

module.exports = router;
