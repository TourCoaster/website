-- Initial schema for tourcoaster-api.
-- D1 (SQLite) — no SERIAL/UUID native types; we use TEXT primary keys
-- generated as UUIDv4 strings on the application side.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- schema_version
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- users
-- Identity is provisioned from Cloudflare Access (Google IdP). google_sub is
-- the stable identifier from the IdP; email is captured for display.
-- role is null until the user picks "traveler" or "guide" on first sign-in.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id           TEXT    PRIMARY KEY,
  email        TEXT    NOT NULL UNIQUE,
  google_sub   TEXT    UNIQUE,
  role         TEXT    CHECK (role IN ('traveler','guide','admin')),
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_users_role   ON users (role);
CREATE INDEX idx_users_status ON users (status);

-- ---------------------------------------------------------------------------
-- sessions
-- Reserved for refresh-token / device-tracking use. Day-to-day auth uses
-- Cloudflare Access JWTs verified per request; this table records issued
-- sessions for audit and revocation. Hot-path data lives in the SESSIONS KV.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip           TEXT,
  user_agent   TEXT,
  expires_at   TEXT    NOT NULL,
  revoked_at   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user_id    ON sessions (user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- guide_profiles
-- 1:1 with users for users where role = 'guide'.
-- ---------------------------------------------------------------------------
CREATE TABLE guide_profiles (
  user_id            TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slug               TEXT    NOT NULL UNIQUE,
  display_name       TEXT,
  bio                TEXT,
  location           TEXT,
  languages          TEXT,            -- JSON array as TEXT
  avatar_key         TEXT,            -- R2 object key
  status             TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  stripe_account_id  TEXT    UNIQUE,
  charges_enabled    INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_guide_profiles_status            ON guide_profiles (status);
CREATE INDEX idx_guide_profiles_stripe_account_id ON guide_profiles (stripe_account_id);

-- ---------------------------------------------------------------------------
-- tours
-- ---------------------------------------------------------------------------
CREATE TABLE tours (
  id                TEXT    PRIMARY KEY,
  owner_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug              TEXT    NOT NULL UNIQUE,
  title             TEXT    NOT NULL,
  description       TEXT,
  location          TEXT,
  category          TEXT,
  duration_minutes  INTEGER,
  capacity          INTEGER,
  price_cents       INTEGER NOT NULL DEFAULT 0,
  currency          TEXT    NOT NULL DEFAULT 'USD',
  vr_enabled        INTEGER NOT NULL DEFAULT 0,
  scheduled_at      TEXT,
  status            TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','deleted')),
  published_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tours_owner_id   ON tours (owner_id);
CREATE INDEX idx_tours_status     ON tours (status);
CREATE INDEX idx_tours_category   ON tours (category);
CREATE INDEX idx_tours_vr_enabled ON tours (vr_enabled);

-- ---------------------------------------------------------------------------
-- tour_media
-- ---------------------------------------------------------------------------
CREATE TABLE tour_media (
  id          TEXT    PRIMARY KEY,
  tour_id     TEXT    NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  r2_key      TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'image' CHECK (kind IN ('image','video')),
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tour_media_tour_id ON tour_media (tour_id, position);

-- ---------------------------------------------------------------------------
-- bookings — one-time in-person Stripe Checkout sessions.
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
  id                          TEXT    PRIMARY KEY,
  tour_id                     TEXT    NOT NULL REFERENCES tours(id) ON DELETE RESTRICT,
  traveler_id                 TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_at                TEXT,
  amount_cents                INTEGER NOT NULL,
  currency                    TEXT    NOT NULL DEFAULT 'USD',
  platform_fee_cents          INTEGER NOT NULL DEFAULT 0,
  stripe_checkout_session_id  TEXT    UNIQUE,
  stripe_payment_intent_id    TEXT    UNIQUE,
  status                      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','refunded','failed','canceled')),
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_bookings_tour_id     ON bookings (tour_id);
CREATE INDEX idx_bookings_traveler_id ON bookings (traveler_id);
CREATE INDEX idx_bookings_status      ON bookings (status);

-- ---------------------------------------------------------------------------
-- subscriptions — recurring VR access.
-- ---------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id                       TEXT    PRIMARY KEY,
  user_id                  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id       TEXT    NOT NULL,
  stripe_subscription_id   TEXT    NOT NULL UNIQUE,
  plan                     TEXT    NOT NULL CHECK (plan IN ('explorer','wanderer')),
  status                   TEXT    NOT NULL CHECK (status IN ('active','trialing','past_due','canceled','unpaid','incomplete')),
  current_period_end       TEXT,
  cancel_at_period_end     INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_subscriptions_user_id            ON subscriptions (user_id);
CREATE INDEX idx_subscriptions_stripe_customer_id ON subscriptions (stripe_customer_id);
CREATE INDEX idx_subscriptions_status             ON subscriptions (status);

-- ---------------------------------------------------------------------------
-- live_streams — Cloudflare Stream live inputs.
-- stream_key_encrypted holds the AES-GCM ciphertext of the live-input key
-- (with iv|tag prepended); never stored in plaintext.
-- ---------------------------------------------------------------------------
CREATE TABLE live_streams (
  id                    TEXT    PRIMARY KEY,
  tour_id               TEXT    NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  owner_id              TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stream_uid            TEXT    NOT NULL UNIQUE,
  rtmps_url             TEXT    NOT NULL,
  stream_key_encrypted  TEXT    NOT NULL,
  hls_url               TEXT    NOT NULL,
  recording_uid         TEXT,
  status                TEXT    NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','connecting','live','ended')),
  started_at            TEXT,
  ended_at              TEXT,
  peak_viewers          INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_live_streams_tour_id  ON live_streams (tour_id);
CREATE INDEX idx_live_streams_owner_id ON live_streams (owner_id);
CREATE INDEX idx_live_streams_status   ON live_streams (status);

-- ---------------------------------------------------------------------------
-- vr_sessions — a viewer's right to watch a specific live stream.
-- Created either from a paid subscription (transient access) or an in-person
-- booking that includes companion VR access.
-- ---------------------------------------------------------------------------
CREATE TABLE vr_sessions (
  id            TEXT    PRIMARY KEY,
  tour_id       TEXT    NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id    TEXT    REFERENCES bookings(id) ON DELETE SET NULL,
  source        TEXT    NOT NULL CHECK (source IN ('subscription','booking','admin_grant')),
  expires_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_vr_sessions_user_id ON vr_sessions (user_id);
CREATE INDEX idx_vr_sessions_tour_id ON vr_sessions (tour_id);

-- ---------------------------------------------------------------------------
-- wishlist
-- ---------------------------------------------------------------------------
CREATE TABLE wishlist (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tour_id    TEXT    NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, tour_id)
);
CREATE INDEX idx_wishlist_tour_id ON wishlist (tour_id);

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------
CREATE TABLE reports (
  id           TEXT    PRIMARY KEY,
  reporter_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT    NOT NULL CHECK (target_type IN ('tour','guide','stream')),
  target_id    TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolved_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reports_status      ON reports (status);
CREATE INDEX idx_reports_target      ON reports (target_type, target_id);
CREATE INDEX idx_reports_reporter_id ON reports (reporter_id);

-- ---------------------------------------------------------------------------
-- Mark migration as applied.
-- ---------------------------------------------------------------------------
INSERT INTO schema_version (version) VALUES (1);
