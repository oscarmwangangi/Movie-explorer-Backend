// A small helper for talking to Safaricom's Daraja API (M-Pesa).
// Docs: https://developer.safaricom.co.ke/APIs/MpesaExpressSimulate
//
// This file only knows how to TALK to Safaricom. It does not touch our
// database - that happens in services/paymentHelpers.js.

const axios = require('axios');
require('dotenv').config();

// Sandbox = fake money for testing. Live = real money.
const BASE_URL =
  process.env.MPESA_ENV === 'live'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

// ---------------------------------------------------------------
// Phone number helper
// ---------------------------------------------------------------

// Accepts the two formats we allow:
//   07XXXXXXXX      (10 digits)
//   2547XXXXXXXX    (12 digits)
// Spaces, dashes and a leading "+" are ignored (so "+254 712 345 678" works).
// Returns the number in the format Safaricom wants (2547XXXXXXXX),
// or null if the number is not valid.
//
// NOTE: Safaricom also has numbers starting with 01 (e.g. 0110...).
// If you want to allow those later, change the two patterns below.
function normalizePhone(input) {
  if (typeof input !== 'string') return null;

  const cleaned = input.replace(/[\s-]/g, '').replace(/^\+/, '');

  if (/^07\d{8}$/.test(cleaned)) {
    return '254' + cleaned.slice(1); // 0712345678 -> 254712345678
  }
  if (/^2547\d{8}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

// ---------------------------------------------------------------
// Access token (cached so we don't ask Safaricom for a new one on every call)
// ---------------------------------------------------------------

let cachedToken = null;
let cachedTokenExpiresAt = 0; // a timestamp in milliseconds

async function getAccessToken() {
  // Reuse the old token while it is still valid.
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  console.log('Requesting M-Pesa access token');
  const response = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    auth: {
      username: process.env.MPESA_CONSUMER_KEY,
      password: process.env.MPESA_CONSUMER_SECRET,
    },
    timeout: 15000,
  });

  cachedToken = response.data.access_token;
  // Tokens last about 1 hour. We stop reusing ours 1 minute early to be safe.
  const secondsValid = Number(response.data.expires_in) || 3600;
  cachedTokenExpiresAt = Date.now() + (secondsValid - 60) * 1000;
  return cachedToken;
}

// ---------------------------------------------------------------
// Timestamp + password (Safaricom wants both on every STK request)
// ---------------------------------------------------------------

// Format: YYYYMMDDHHmmss, in Nairobi time (UTC+3).
function getTimestamp() {
  const nairobiNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  // "2026-10-01T12:34:56.789Z" -> "20261001123456"
  return nairobiNow.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// Password = base64( shortcode + passkey + timestamp )
function getPassword(timestamp) {
  const raw = process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp;
  return Buffer.from(raw).toString('base64');
}

// Sends a POST request to Safaricom with our access token attached.
async function post(path, body) {
  const token = await getAccessToken();
  try {
    const response = await axios.post(`${BASE_URL}${path}`, body, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    });
    return response.data;
  } catch (err) {
    // If Safaricom says our token is no good, forget it so the next call gets a fresh one.
    if (err.response?.status === 401) {
      cachedToken = null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------
// STK Push - makes the M-Pesa PIN prompt pop up on the customer's phone
// ---------------------------------------------------------------

// phone: already normalized, e.g. "254712345678"
// Returns Safaricom's response, which includes CheckoutRequestID.
async function stkPush({ phone, amount, accountReference, description }) {
  const timestamp = getTimestamp();

  const body = {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password: getPassword(timestamp),
    Timestamp: timestamp,
    // "CustomerPayBillOnline" for a Paybill, "CustomerBuyGoodsOnline" for a Till number.
    TransactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone, // the customer paying
    PartyB: process.env.MPESA_PARTY_B || process.env.MPESA_SHORTCODE, // the business receiving
    PhoneNumber: phone, // the phone that gets the prompt
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: accountReference, // max 12 characters
    TransactionDesc: description, // max 13 characters
  };

  return post('/mpesa/stkpush/v1/processrequest', body);
}

// ---------------------------------------------------------------
// STK Query - asks Safaricom "what happened to this payment?"
// We use it as a backup in case the callback never reaches us.
// ---------------------------------------------------------------

// Returns { pending: true } if the customer has not finished yet,
// otherwise Safaricom's answer (which includes ResultCode and ResultDesc).
async function stkQuery(checkoutRequestId) {
  const timestamp = getTimestamp();

  try {
    return await post('/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: getPassword(timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    });
  } catch (err) {
    // While the customer is still looking at the prompt, Safaricom answers
    // with an error saying the transaction is still being processed.
    // That is not a real failure - it just means "ask again later".
    if (err.response?.data?.errorCode === '500.001.1001') {
      return { pending: true };
    }
    throw err;
  }
}

module.exports = { normalizePhone, stkPush, stkQuery };
