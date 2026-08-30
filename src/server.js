// This is the entry point - the file that starts everything.
// Run it with: npm start

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscriptions');
const adminRoutes = require('./routes/admin');
const paypalRoutes = require('./routes/paypal');

const app = express();

app.use(cors()); // allows the Flutter app / React dashboard to call this API
app.use(express.json()); // lets us read JSON request bodies as req.body

// Every route file is "mounted" at a prefix, e.g. auth.js routes
// become /api/auth/register, /api/auth/login, etc.
app.use('/api/auth', authRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/paypal', paypalRoutes);


// Simple health check - visit this URL to confirm the server is running.
app.get('/', (req, res) => {
  res.json({ status: 'Movie Explorer API is running' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
