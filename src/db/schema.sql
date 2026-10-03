-- ============================================================
-- Movie Explorer database schema
-- Run this once to create the tables you need.
-- (npm run setup-db does this for you automatically)
-- ============================================================

-- One row per user of the app.
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMP
);

-- Added for the admin dashboard: a display name (users created by an
-- admin always have one; users who registered from Flutter before this
-- column existed simply have NULL, which the admin panel falls back to
-- showing their email for) and an account-level disable flag, separate
-- from subscription status, that blocks login entirely.
-- IF NOT EXISTS makes this safe to run again against a database that
-- already has data in it (e.g. your live Flutter users).
ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per user, tracking their subscription status.
-- We keep this separate from "users" so it's easy to see subscription
-- history and doesn't clutter the users table.
CREATE TABLE IF NOT EXISTS subscriptions (
    id                     SERIAL PRIMARY KEY,
    user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- 'monthly' or 'yearly'
    plan_type              TEXT NOT NULL,

    -- 'pending'   = user started checkout but hasn't paid yet
    -- 'active'    = paid and currently valid
    -- 'expired'   = time ran out
    -- 'cancelled' = admin or user ended it early
    status                 TEXT NOT NULL DEFAULT 'pending',

    -- LEGACY: left over from when we used PayPal. Nothing writes to it any
    -- more. It is kept so existing databases keep working; you can drop
    -- it later with: ALTER TABLE subscriptions DROP COLUMN paypal_subscription_id;
    paypal_subscription_id TEXT UNIQUE,

    started_at             TIMESTAMP,
    expires_at             TIMESTAMP,

    created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Speeds up "find this user's subscription".
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_paypal_id ON subscriptions(paypal_subscription_id);

-- One row per M-Pesa payment attempt.
-- A row is created as PENDING when the STK push prompt is sent, and is
-- updated when Safaricom tells us what happened.
CREATE TABLE IF NOT EXISTS orders (
    id                   SERIAL PRIMARY KEY,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- 'monthly' or 'yearly'
    plan_type            TEXT NOT NULL,

    -- Amount in Kenya Shillings (KES), whole numbers.
    amount               INTEGER NOT NULL,

    -- The phone that got the prompt, always stored as 2547XXXXXXXX.
    phone_number         TEXT NOT NULL,

    -- 'PENDING'   = prompt sent, waiting for the customer
    -- 'COMPLETED' = customer paid
    -- 'FAILED'    = payment failed (insufficient balance, wrong PIN, timeout...)
    -- 'CANCELLED' = customer cancelled the prompt on their phone
    status               TEXT NOT NULL DEFAULT 'PENDING',

    -- Safaricom's IDs for this payment. CheckoutRequestID is the one that
    -- comes back in the callback, so it is how we find the right order.
    merchant_request_id  TEXT,
    checkout_request_id  TEXT UNIQUE,

    -- What Safaricom told us at the end (ResultCode 0 = paid).
    result_code          INTEGER,
    result_desc          TEXT,
    mpesa_receipt_number TEXT,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_checkout_id ON orders(checkout_request_id);
