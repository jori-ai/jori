-- push-relay D1 schema (docs/push-relay.md § Storage).
-- Apply: wrangler d1 execute jori-push-relay --remote --file=schema.sql
-- Times are integer ms since the epoch.

-- One row per Jori host. `secret` is the HMAC key the host signs with; it is
-- stored as issued because verifying an HMAC needs the key itself.
CREATE TABLE IF NOT EXISTS instances (
  id         TEXT PRIMARY KEY,
  secret     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One-time pairing tokens a host mints for its QR code. Only the SHA-256 of
-- the token is stored; registering a device deletes the row.
CREATE TABLE IF NOT EXISTS pairings (
  token_hash  TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pairings_instance ON pairings (instance_id, expires_at);

-- Paired phones and Macs. `public_key` is the device's P-256 key the host
-- encrypts to (base64 raw uncompressed point); `secret` is the device's HMAC
-- key; `dead_at` is set when APNs retires the token (410 / BadDeviceToken).
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL,
  secret       TEXT NOT NULL,
  apns_token   TEXT NOT NULL,
  environment  TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  device_name  TEXT NOT NULL,
  public_key   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  dead_at      INTEGER
);
CREATE INDEX IF NOT EXISTS devices_instance ON devices (instance_id);

-- Fixed hourly windows. `key` is "instances:<ip hash>", "devices:<ip hash>"
-- or "push:<instance id>".
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
