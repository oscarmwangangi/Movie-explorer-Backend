// Handles: creating an account, logging in.
// The Flutter app calls these two endpoints.

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
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
// Body: { "email": "...", "password": "..." }
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  console.log('Register request received');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    // Never store plain-text passwords! bcrypt turns the password into
    // a scrambled hash that can be checked later but not reversed.
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, is_admin',
      [email, passwordHash]
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

    // Track that they logged in - this is what the admin panel shows.
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const token = makeToken(user);
    console.log('Login completed for user:', user.id);
    res.json({ token, user: { id: user.id, email: user.email, isAdmin: user.is_admin } });
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
      'SELECT id, email, is_admin FROM users WHERE id = $1', 
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json(result.rows[0]);
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

// --- SUBSCRIPTION ROUTES ---

// GET /api/subscriptions/me

module.exports = router;
