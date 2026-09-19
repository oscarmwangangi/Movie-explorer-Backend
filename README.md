# Movie Explorer Backend

This is the server that handles logins, PayPal subscriptions, and the
admin panel. Your Flutter app and the React admin dashboard both talk
to this server over HTTP.

## What you need installed first
- Node.js (v18 or newer) - https://nodejs.org
- PostgreSQL running somewhere (your laptop, or a free host like
  Railway/Supabase/Neon)
- A free PayPal Developer account - https://developer.paypal.com

## Setup steps (do these in order)

### 1. Install dependencies
```
cd backend
npm install
```

### 2. Create your database
Open psql (or any Postgres GUI) and run:
```sql
CREATE DATABASE movie_explorer;
```

### 3. Set up your environment file
```
cp .env.example .env
```
Then open `.env` and fill in:
- `DATABASE_URL` - your Postgres connection string
- `JWT_SECRET` - any long random string
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` - what YOU will use to log into the admin dashboard
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` - from developer.paypal.com -> My Apps & Credentials -> Sandbox app

### 4. Create your database tables + admin account
```
npm run setup-db
```

### 5. Create the PayPal subscription plans ($1/month, $10/year)
```
npm run create-paypal-plans
```
This prints two Plan IDs. Copy them into your `.env` file:
```
PAYPAL_MONTHLY_PLAN_ID=...
PAYPAL_YEARLY_PLAN_ID=...
```

### 6. Start the server
```
npm start
```
Visit http://localhost:4000 - you should see `{"status": "Movie Explorer API is running"}`.

## Letting PayPal reach your webhook (important!)
PayPal needs to call your `/api/subscriptions/webhook` endpoint to tell
you a payment succeeded. While developing on your laptop, PayPal can't
reach `localhost` directly - use a tunnel tool like ngrok:
```
ngrok http 4000
```
Then in your PayPal Developer Dashboard -> your app -> Webhooks, add:
```
https://<your-ngrok-subdomain>.ngrok.io/api/subscriptions/webhook
```
and subscribe to these events:
- BILLING.SUBSCRIPTION.ACTIVATED
- PAYMENT.SALE.COMPLETED
- BILLING.SUBSCRIPTION.CANCELLED
- BILLING.SUBSCRIPTION.EXPIRED

**Don't want to set up ngrok yet?** You don't have to right away. After
the user approves payment, PayPal redirects their browser to
`/api/paypal/return`, and that page also checks with PayPal and
activates the subscription - so local testing works without a
webhook. The webhook is still what you want for production (it also
catches renewal payments and cancellations that happen when nobody's
in the app), but it's not required just to see the happy path work.

## API endpoints (what Flutter and React call)

| Method | URL | Who can call it | What it does |
|---|---|---|---|
| POST | /api/auth/register | anyone | Create an account |
| POST | /api/auth/login | anyone | Log in, get a token |
| POST | /api/subscriptions/start | logged-in user | Start a PayPal subscription |
| GET | /api/subscriptions/me | logged-in user | Check my subscription status |
| POST | /api/subscriptions/webhook | PayPal only | PayPal reports payment events |
| GET | /api/admin/users | admin only | List all users + status |
| POST | /api/admin/users/:id/extend | admin only | Add days to a subscription |
| POST | /api/admin/users/:id/end | admin only | Cancel a subscription |

## Going live
When you're ready for real payments, change `PAYPAL_MODE=live` in
`.env` and swap your sandbox Client ID/Secret for your live ones. You'll
need to re-run `npm run create-paypal-plans` to create live versions
of the $1/$10 plans, since sandbox and live are separate.
