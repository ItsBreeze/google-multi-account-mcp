/**
 * Idempotent schema. Safe to run on every boot, and that is how server.js
 * uses it — four tables, no migration framework, no ordering to get wrong.
 */

const pool = require('./pool');

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- One row per linked Google account. Tokens are AES-256-GCM ciphertext
-- (crypto_box), never plaintext. owner_key is the MCP token subject that owns
-- the link.
CREATE TABLE IF NOT EXISTS gmail_accounts (
  id                 UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_key          TEXT        NOT NULL,
  email              TEXT        NOT NULL,
  google_sub         TEXT,
  access_token_enc   TEXT,
  refresh_token_enc  TEXT,
  token_expires_at   TIMESTAMPTZ,
  scopes             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_key, email)
);

CREATE INDEX IF NOT EXISTS idx_gmail_accounts_owner ON gmail_accounts(owner_key);

-- OAuth clients registered by Claude via RFC 7591 dynamic registration.
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id     TEXT        PRIMARY KEY,
  client_name   TEXT,
  redirect_uris JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Authorization codes: single-use, hashed, five-minute lifetime.
CREATE TABLE IF NOT EXISTS mcp_auth_codes (
  code_hash      TEXT        PRIMARY KEY,
  client_id      TEXT        NOT NULL,
  redirect_uri   TEXT        NOT NULL,
  code_challenge TEXT,
  scope          TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_auth_codes_expiry ON mcp_auth_codes(expires_at);

-- Refresh tokens: hashed, rotated on every use.
CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
  token_hash  TEXT        PRIMARY KEY,
  client_id   TEXT        NOT NULL,
  scope       TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_refresh_tokens_expiry ON mcp_refresh_tokens(expires_at);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then(() => { console.log('Migration complete ✓'); process.exit(0); })
    .catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
}
