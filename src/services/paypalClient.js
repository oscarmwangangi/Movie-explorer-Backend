// A small helper for talking to PayPal's REST API.
// PayPal docs call this the "Subscriptions API":
// https://developer.paypal.com/docs/api/subscriptions/v1/

const axios = require('axios');
require('dotenv').config();

// Sandbox = fake money for testing. Live = real money.
const BASE_URL =
  process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

// PayPal requires an "access token" before you can call any other
// endpoint. Tokens expire, so we ask for a fresh one each time we
// need it (simplest approach - fine for this app's traffic level).
async function getAccessToken() {
  const response = await axios.post(
    `${BASE_URL}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: {
        username: process.env.PAYPAL_CLIENT_ID,
        password: process.env.PAYPAL_CLIENT_SECRET,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  return response.data.access_token;
}

// A tiny wrapper so every other file can just do:
//   const paypal = require('./paypalClient');
//   await paypal.post('/v1/billing/subscriptions', {...});
async function request(method, url, data) {
  const token = await getAccessToken();
  const response = await axios({
    method,
    url: `${BASE_URL}${url}`,
    data,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  return response.data;
}

module.exports = {
  get: (url) => request('get', url),
  post: (url, data) => request('post', url, data),
  BASE_URL,
};
