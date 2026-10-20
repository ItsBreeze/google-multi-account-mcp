/**
 * Idempotent schema. Safe to run on every boot, and that is how server.js
 * uses it — eight tables, no migration framework, no ordering to get wrong.
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

-- One row per linked IMAP mailbox (AOL). There is no OAuth for these, so what
-- is stored is an app password the user generated for this server — AES-256-GCM
-- ciphertext, like the Google tokens. Hosts are not stored: they come from the
-- provider preset in code, so a row can never point the server somewhere else.
CREATE TABLE IF NOT EXISTS imap_accounts (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_key     TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  provider      TEXT        NOT NULL,
  password_enc  TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_key, email)
);

CREATE INDEX IF NOT EXISTS idx_imap_accounts_owner ON imap_accounts(owner_key);

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

-- Per-user identity cutover.
--
-- Both tables predate it, when every token was issued to a single operator and
-- the subject was the constant 'owner'. Adding the column with that default
-- keeps codes and refresh tokens already in a client's hands working across the
-- upgrade, instead of logging everyone out on deploy. New rows always write an
-- explicit owner_key, so the default only ever applies to pre-existing ones.
ALTER TABLE mcp_auth_codes     ADD COLUMN IF NOT EXISTS owner_key TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE mcp_refresh_tokens ADD COLUMN IF NOT EXISTS owner_key TEXT NOT NULL DEFAULT 'owner';

CREATE INDEX IF NOT EXISTS idx_mcp_refresh_tokens_owner ON mcp_refresh_tokens(owner_key);

-- One Stripe subscription per identity (services/billing). status mirrors
-- Stripe's subscription status, plus 'comp' for access granted by hand.
CREATE TABLE IF NOT EXISTS billing (
  owner_key              TEXT        PRIMARY KEY,
  email                  TEXT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  status                 TEXT        NOT NULL,
  current_period_end     TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// AI-to-AI messages (services/ai_bus). A thread is named by the id of its
// first message. wake_enc is crypto_box ciphertext: webhook headers can hold
// a bearer token.
const AI_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_messages (
  id          BIGSERIAL   PRIMARY KEY,
  owner_key   TEXT        NOT NULL,
  thread_id   BIGINT,
  from_agent  TEXT        NOT NULL,
  to_agent    TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  hop         INT         NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at     TIMESTAMPTZ,
  wake_error  TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_inbox  ON ai_messages(owner_key, to_agent, read_at);
CREATE INDEX IF NOT EXISTS idx_ai_messages_thread ON ai_messages(owner_key, thread_id);

CREATE TABLE IF NOT EXISTS ai_agents (
  owner_key   TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  about       TEXT,
  wake_enc    TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_key, name)
);
`;

async function migrate() {
  await pool.query(SCHEMA + AI_SCHEMA);
}

module.exports = { migrate, AI_SCHEMA };

if (require.main === module) {
  migrate()
    .then(() => { console.log('Migration complete ✓'); process.exit(0); })
    .catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
}
