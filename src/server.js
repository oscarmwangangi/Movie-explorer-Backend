// This is the entry point - the file that starts everything.
// Run it with: npm start

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscriptions');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payments');
const adminPaymentRoutes = require('./routes/adminPayments');

const app = express();

app.use(cors()); // allows the Flutter app / React dashboard to call this API
app.use(express.json()); // lets us read JSON request bodies as req.body

app.use((req, res, next) => {
  // We log the path WITHOUT the query string, because the M-Pesa callback
  // URL contains a secret (?token=...) that must never end up in the logs.
  const safeUrl = req.originalUrl.split('?')[0];
  console.log(`[request] ${req.method} ${safeUrl}`);
  res.on('finish', () => {
    console.log(`[response] ${req.method} ${safeUrl} ${res.statusCode}`);
  });
  next();
});

// Every route file is "mounted" at a prefix, e.g. auth.js routes
// become /api/auth/register, /api/auth/login, etc.
app.use('/api/auth', authRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/admin/payments', adminPaymentRoutes); // sales numbers + payment list (admin only)
app.use('/api/admin', adminRoutes);
app.use('/api/payments', paymentRoutes);


// Simple health check - visit this URL to confirm the server is running.
app.get('/', (req, res) => {
  res.json({ status: 'Movie Explorer API is running' });
});

app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl.split('?')[0]}:`, err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 4000;
try {
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  server.on('error', (err) => {
    console.error('Failed to start server:', err);
    process.exitCode = 1;
  });
} catch (err) {
  console.error('Failed to start server:', err);
  process.exitCode = 1;
}
