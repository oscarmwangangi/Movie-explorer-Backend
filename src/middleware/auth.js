// These are "middleware" functions - they run BEFORE your route
// handler and can block the request (by returning an error) or let
// it continue (by calling next()).

const jwt = require('jsonwebtoken');
require('dotenv').config();

// Checks that the request has a valid login token.
// The token is sent in the header like: Authorization: Bearer <token>
function requireLogin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // This checks the token is real and not expired.
    // If valid, it gives us back the data we stored in it (userId, isAdmin).
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // attach user info to the request for later use
    next(); // let the request continue to the actual route
  } catch (err) {
    return res.status(401).json({ error: 'Your session is invalid or expired. Please log in again.' });
  }
}

// Use this AFTER requireLogin on routes that only admins should access.
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Admins only.' });
  }
  next();
}

module.exports = { requireLogin, requireAdmin };
