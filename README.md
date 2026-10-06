# Movie Explorer Backend

This is the server that handles logins, M-Pesa subscription payments, and
the admin panel. Your Flutter app and the React admin dashboard both talk
to this server over HTTP.

## What you need installed first
- Node.js (v18 or newer) - https://nodejs.org
- PostgreSQL running somewhere (your laptop, or a free host like
  Railway/Supabase/Neon)
- A free Safaricom Daraja developer account - https://developer.safaricom.co.ke

## Setup steps (do these in order)

### 1. Install dependencies
```
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
- `MPESA_*` - see "M-Pesa setup" below

### 4. Create your database tables + admin account
```
npm run setup-db
```
This is safe to run again on your existing database. It adds the new
`orders` table and leaves your users and subscriptions untouched.

### 5. Start the server
```
npm start
```
Visit http://localhost:4000 - you should see `{"status": "Movie Explorer API is running"}`.

## M-Pesa setup

1. On https://developer.safaricom.co.ke create an app and enable
   **M-Pesa Express (STK Push)**. Copy its **Consumer Key** and
   **Consumer Secret** into `.env`.
2. Copy the **Shortcode** and **Passkey** into `.env`
   (for testing, the sandbox shortcode is `174379`).
3. Set your prices in KES with `MPESA_MONTHLY_AMOUNT` / `MPESA_YEARLY_AMOUNT`.
4. Make up a long random secret for `MPESA_CALLBACK_TOKEN`, then set
   `MPESA_CALLBACK_URL` to your server's public address like this:
   ```
   https://<your-server>/api/payments/callback?token=<the same secret>
   ```

### Why the callback URL has a secret in it
Safaricom calls `/api/payments/callback` by itself to say whether a payment
worked. That endpoint can't use normal logins (Safaricom has no account),
so it is protected by the secret `token` in the URL. Requests without the
right token get a `401`. Keep the token private, and never share the full
callback URL.

### Testing on your laptop
Safaricom can't reach `localhost`. Two options:
- Use a tunnel like ngrok (`ngrok http 4000`) and put the https address in `MPESA_CALLBACK_URL`.
- Or skip the tunnel: if the callback never arrives, the app's status check
  asks Safaricom directly after about 20 seconds, so payments still complete.

**Sandbox note:** the Daraja sandbox does not send real prompts to real
phones. To see the PIN prompt on your own phone you need a live Paybill/Till
and `MPESA_ENV=live`.

## How a payment works
1. The app calls `POST /api/payments/stk-push` with a plan and a phone number.
2. The server saves an order as `PENDING` and asks Safaricom to show the PIN prompt.
3. The customer enters their PIN on their phone.
4. Safaricom calls `POST /api/payments/callback`. If `ResultCode` is `0` the order
   becomes `COMPLETED` and the subscription is activated. Otherwise the order becomes
   `FAILED` (e.g. insufficient balance, wrong PIN, timeout) or `CANCELLED`.
5. While waiting, the app calls `GET /api/payments/status/:checkoutRequestId` every few seconds.

## API endpoints (what Flutter and React call)

| Method | URL | Who can call it | What it does |
|---|---|---|---|
| POST | /api/auth/register | anyone | Create an account |
| POST | /api/auth/login | anyone | Log in, get a token |
| POST | /api/payments/stk-push | logged-in user | Send the M-Pesa PIN prompt to a phone |
| GET | /api/payments/status/:checkoutRequestId | logged-in user (own orders only) | Check if a payment went through |
| POST | /api/payments/callback?token=... | Safaricom only (secret token) | Safaricom reports the payment result |
| GET | /api/subscriptions/me | logged-in user | Check my subscription status |
| GET | /api/admin/users | admin only | List all users + status |
| POST | /api/admin/users | admin only | Manually register a user (with or without a subscription) |
| POST | /api/admin/users/:id/extend | admin only | Add days to a subscription |
| POST | /api/admin/users/:id/end | admin only | End a subscription |
| POST | /api/admin/users/:id/reactivate | admin only | Start a fresh active period |

## Going live
Change `MPESA_ENV=live`, and swap in your live Consumer Key/Secret,
Shortcode and Passkey. Your live callback URL must be a public https address.


## Update: new endpoints (run `npm run setup-db` once to add 2 new tables)

Existing routes used by the Flutter app are unchanged.

| Endpoint | Who | What |
|---|---|---|
| `PATCH /api/admin/users/:id` | admin | Change a user's `name` and/or `email` |
| `GET /api/admin/users/:id` | admin | One user + last 10 payments |
| `GET/PUT /api/admin/settings` | admin | `registrationEnabled`, `loginEnabled`, `blockMessage` |
| `GET /api/admin/activity` | admin | Log of admin actions |
| `GET /api/admin/notifications` | admin | Expiring/expired subs, failed payments, new sign-ups |
| `POST /api/auth/change-email` | logged-in user | Change own email (needs password) |
| `GET /api/auth/app-status` | public | Flutter can check if sign-up/login are open |

When sign-up or login is switched off, the server answers `403` with
`{ "error": "<your message>", "code": "REGISTRATION_DISABLED" | "LOGIN_DISABLED" }`
(the same `error` field the Flutter app already reads). Admins can always log in.
