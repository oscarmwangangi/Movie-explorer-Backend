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

    -- The subscription ID PayPal gives us. We need this to look up
    -- or cancel the subscription on PayPal's side later.
    paypal_subscription_id TEXT UNIQUE,

    started_at             TIMESTAMP,
    expires_at             TIMESTAMP,

    created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Speeds up "find this user's subscription" and "find this PayPal subscription".
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_paypal_id ON subscriptions(paypal_subscription_id);
