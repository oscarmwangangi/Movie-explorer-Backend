// Handles: creating an account, logging in.
// The Flutter app calls these two endpoints.

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireLogin } = require('../middleware/auth');
const { getSettings } = require('../services/settingsHelpers');
require('dotenv').config();

const router = express.Router();

// Makes a login token that expires in 30 days.
function makeToken(user) {
  return jwt.sign(
    { userId: user.id, isAdmin: user.is_admin },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// POST /api/auth/register
// Body: { "email": "...", "password": "...", "name": "..." (optional) }
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  console.log('Register request received');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    // Admin switch: "Allow new sign-ups" (Settings page in the dashboard).
    const settings = await getSettings();
    if (!settings.registration_enabled) {
      return res.status(403).json({
        error: settings.block_message || 'New sign-ups are currently closed.',
        code: 'REGISTRATION_DISABLED',
      });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    // Never store plain-text passwords! bcrypt turns the password into
    // a scrambled hash that can be checked later but not reversed.
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, is_admin',
      [email, passwordHash, name || null]
    );
    const user = result.rows[0];

    // Give every new user a "pending" subscription row so the rest of
    // the app can always assume a subscription row exists.
    await pool.query(
      "INSERT INTO subscriptions (user_id, plan_type, status) VALUES ($1, 'none', 'pending')",
      [user.id]
    );

    const token = makeToken(user);
    console.log('Registration completed for user:', user.id);
    res.status(201).json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('Registration failed:', err);
    res.status(500).json({ error: 'Something went wrong creating your account.' });
  }
});

// POST /api/auth/login
// Body: { "email": "...", "password": "..." }
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log('Login request received');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    if (user.is_disabled) {
      return res.status(403).json({ error: 'This account has been disabled. Contact support.' });
    }

    // Admin switch: "Allow user login". Admins can always log in,
    // otherwise you could lock yourself out of the dashboard.
    if (!user.is_admin) {
      const settings = await getSettings();
      if (!settings.login_enabled) {
        return res.status(403).json({
          error: settings.block_message || 'Login is temporarily unavailable. Please try again later.',
          code: 'LOGIN_DISABLED',
        });
      }
    }

    // Track that they logged in - this is what the admin panel shows.
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const token = makeToken(user);
    console.log('Login completed for user:', user.id);
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, isAdmin: user.is_admin },
    });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Something went wrong logging in.' });
  }
});


const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user; // This is what populates req.user
    next();
  });
};

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  // 1. Log the decoded user to see what's inside the token
  console.log("Token content:", req.user);

  try {
    // 2. Use userId (which matches your makeToken function)
    const result = await pool.query(
      'SELECT id, email, name, is_admin FROM users WHERE id = $1', 
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const row = result.rows[0];
    // Keep the old fields (Flutter uses them) and add isAdmin for the dashboard.
    res.json({ ...row, isAdmin: row.is_admin });
  } catch (err) {
    // 3. THIS WILL SHOW THE ACTUAL ERROR IN YOUR TERMINAL
    console.error("--- BACKEND ERROR ---");
    console.error(err);
    console.error("---------------------");
    
    res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  console.log('Password change request received for user:', req.user.userId);
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  try {
    // Use userId to match your makeToken function
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId]);
    
    const user = result.rows[0];
    if (await bcrypt.compare(currentPassword, user.password_hash)) {
      const hashedNewPassword = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashedNewPassword, req.user.userId]);
      res.json({ message: 'Password updated successfully.' });
    } else {
      res.status(400).json({ error: 'Current password incorrect.' });
    }
  } catch (err) {
    console.error('Password change failed:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/auth/app-status   (no login needed)
// Lets the Flutter app ask "are sign-ups / logins open right now?" so it
// can hide the buttons or show a message BEFORE the user types anything.
router.get('/app-status', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      registrationEnabled: settings.registration_enabled,
      loginEnabled: settings.login_enabled,
      message: settings.block_message,
    });
  } catch (err) {
    console.error('Failed to load app status:', err);
    // If we can't tell, say everything is open so the app is never blocked by mistake.
    res.json({ registrationEnabled: true, loginEnabled: true, message: '' });
  }
});

// POST /api/auth/change-email
// Body: { "newEmail": "...", "password": "..." }
// The logged-in user changes their OWN email. We ask for the password so
// someone who borrows an open session can't take over the account.
router.post('/change-email', requireLogin, async (req, res) => {
  const { newEmail, password } = req.body;
  const email = String(newEmail || '').trim();

  if (!email || !password) {
    return res.status(400).json({ error: 'New email and your password are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId]);
    const matches = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!matches) {
      return res.status(400).json({ error: 'Password is incorrect.' });
    }

    // Is someone ELSE already using this email? (case-insensitive check)
    const taken = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2',
      [email, req.user.userId]
    );
    if (taken.rows.length > 0) {
      return res.status(409).json({ error: 'That email is already used by another account.' });
    }

    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.user.userId]);
    console.log('Email changed for user:', req.user.userId);
    res.json({ message: 'Email updated.', email });
  } catch (err) {
    console.error('Email change failed:', err);
    res.status(500).json({ error: 'Failed to update email.' });
  }
});

module.exports = router;
