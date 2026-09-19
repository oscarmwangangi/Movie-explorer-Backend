// const express = require('express');
// const { Pool } = require('pg');
// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');
// const cors = require('cors');
// require('dotenv').config();


// const router = express.Router();

// // --- Database Connection ---

// const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

// // --- Auth Middleware ---


// // --- AUTH ROUTES ---

// // POST /api/auth/register


// // GET /api/auth/me (THIS IS WHAT YOUR APP WAS MISSING)
// router.get('/api/auth', authenticateToken, async (req, res) => {
//   try {
//     const result = await pool.query('SELECT id, email, is_admin FROM users WHERE id = $1', [req.user.id]);
//     if (result.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
//     res.json(result.rows[0]);
//   } catch (err) {
//     res.status(500).json({ error: 'Failed to fetch user profile.' });
//   }
// });

// // POST /api/auth/change-password
// router.post('/api/auth/change-password', authenticateToken, async (req, res) => {
//   const { currentPassword, newPassword } = req.body;
//   try {
//     const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
//     const user = result.rows[0];
//     if (await bcrypt.compare(currentPassword, user.password_hash)) {
//       const hashedNewPassword = await bcrypt.hash(newPassword, 10);
//       await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashedNewPassword, req.user.id]);
//       res.json({ message: 'Password updated successfully.' });
//     } else {
//       res.status(400).json({ error: 'Current password incorrect.' });
//     }
//   } catch (err) {
//     res.status(500).json({ error: 'Server error.' });
//   }
// });

// // --- SUBSCRIPTION ROUTES ---

// // GET /api/subscriptions/me
// router.get('/api/subscriptions/me', authenticateToken, async (req, res) => {
//   try {
//     const result = await pool.query(
//       'SELECT status, plan_type, expires_at FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
//       [req.user.id]
//     );
//     // If no subscription exists, return 'none' status instead of null
//     if (result.rows.length === 0) return res.json({ status: 'none' });
//     res.json(result.rows[0]);
//   } catch (err) {
//     res.status(500).json({ error: 'Failed to fetch subscription status.' });
//   }
// });

// // POST /api/subscriptions/start
// router.post('/api/subscriptions/start', authenticateToken, async (req, res) => {
//   const { planType } = req.body;
//   try {
//     // 1. Logic to initiate PayPal checkout would go here.
//     // 2. We create a 'pending' entry in your database.
//     await pool.query(
//       'INSERT INTO subscriptions (user_id, plan_type, status) VALUES ($1, $2, $3)',
//       [req.user.id, planType, 'pending']
//     );

//     // 3. Return a mock PayPal approval URL (Replace with real PayPal API link)
//     res.json({ approveUrl: 'https://www.paypal.com/checkoutnow?token=MOCK_TOKEN' });
//   } catch (err) {
//     res.status(500).json({ error: 'Failed to start subscription process.' });
//   }
// });

// module.exports = router