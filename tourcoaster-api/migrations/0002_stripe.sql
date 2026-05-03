-- 0002_stripe.sql — Stripe Connect + Checkout + subscriptions support.
-- Adds:
--   * users.stripe_customer_id    — re-used across one-time + recurring purchases.
--   * webhook_events              — idempotency log keyed by Stripe event id.
PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
CREATE INDEX idx_users_stripe_customer_id ON users (stripe_customer_id);

CREATE TABLE webhook_events (
  id           TEXT    PRIMARY KEY,                         -- Stripe event.id
  type         TEXT    NOT NULL,
  livemode     INTEGER NOT NULL DEFAULT 0,
  received_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_webhook_events_type ON webhook_events (type);

INSERT INTO schema_version (version) VALUES (2);
