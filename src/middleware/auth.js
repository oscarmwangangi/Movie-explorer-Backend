// These are "middleware" functions - they run BEFORE your route
// handler and can block the request (by returning an error) or let
// it continue (by calling next()).

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db/pool');
require('dotenv').config();

// Checks that the request has a valid login token, and that the
// account behind it hasn't been disabled since the token was issued
// (tokens last 30 days, so a disable needs to take effect immediately,
// not just on next login).
async function requireLogin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // This checks the token is real and not expired.
    // If valid, it gives us back the data we stored in it (userId, isAdmin).
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query('SELECT is_disabled FROM users WHERE id = $1', [decoded.userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Your session is invalid or expired. Please log in again.' });
    }
    if (result.rows[0].is_disabled) {
      return res.status(403).json({ error: 'This account has been disabled. Contact support.' });
    }

    req.user = decoded; // attach user info to the request for later use
    next(); // let the request continue to the actual route
  } catch (err) {
    console.error('Token verification failed:', err);
    return res.status(401).json({ error: 'Your session is invalid or expired. Please log in again.' });
  }
}

// Use this AFTER requireLogin on routes that only admins should access.
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    console.log('Admin access denied:', req.user?.userId || 'anonymous');
    return res.status(403).json({ error: 'Admins only.' });
  }
  next();
}

// Protects the M-Pesa callback endpoint.
//
// Safaricom does not send a login token, so we can't use requireLogin there.
// Instead, we put a long secret into the callback URL we give Safaricom:
//   https://your-server.com/api/payments/callback?token=THE_SECRET
// Safaricom calls that exact URL back, so only someone who knows the
// secret can reach the endpoint. Anyone else gets a 401.
function requireMpesaCallbackToken(req, res, next) {
  const expected = process.env.MPESA_CALLBACK_TOKEN;

  // If the secret was never set, refuse everything (safer than letting everyone in).
  if (!expected) {
    console.error('MPESA_CALLBACK_TOKEN is not set in .env - rejecting callback.');
    return res.status(500).json({ error: 'Server is not configured for M-Pesa callbacks.' });
  }

  const provided = String(req.query.token || '');

  // timingSafeEqual compares in constant time, so an attacker can't guess
  // the secret by measuring how fast we reject. It needs equal lengths first.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const isValid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!isValid) {
    console.log('M-Pesa callback rejected: bad or missing token');
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  next();
}

module.exports = { requireLogin, requireAdmin, requireMpesaCallbackToken };
