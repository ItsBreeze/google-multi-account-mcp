/**
 * Linked IMAP mailboxes (AOL).
 *
 * The counterpart of gmail_accounts for providers with no OAuth. What is
 * stored is an app password — one the user generated for this server alone —
 * AES-256-GCM encrypted (crypto_box), exactly as Google tokens are.
 *
 * A password is stored only after it has signed in to both IMAP and SMTP, so
 * a typo is caught on the link page rather than on the first tool call.
 */

const pool      = require('../db/pool');
const crypt     = require('./crypto_box');
const providers = require('./imap_providers');
const imap      = require('./imap_api');

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** An error the link page may show as-is: it is about what the user typed, not about the server. */
function userFacing(err) {
  const wrapped = err instanceof Error ? err : new Error(String(err));
  wrapped.userFacing = true;
  return wrapped;
}

async function link({ ownerKey, email, provider, password }) {
  providers.preset(provider);

  const address = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(address)) throw userFacing('Enter the full mailbox address, like you@aol.com.');

  // App passwords are letters only and often shown in groups; a pasted space
  // must not turn a correct password into a refusal.
  const secret = String(password || '').replace(/\s+/g, '');
  if (!secret) throw userFacing('Enter the app password.');

  try {
    await imap.verify({ email: address, password: secret, provider });
  } catch (err) {
    throw userFacing(err);
  }

  const { rows } = await pool.query(
    `INSERT INTO imap_accounts (owner_key, email, provider, password_enc)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_key, email) DO UPDATE SET
       provider     = EXCLUDED.provider,
       password_enc = EXCLUDED.password_enc,
       updated_at   = NOW()
     RETURNING email, provider, created_at, updated_at`,
    [ownerKey, address, provider, crypt.encrypt(secret)],
  );
  return rows[0];
}

async function list(ownerKey) {
  const { rows } = await pool.query(
    `SELECT email, provider, created_at, updated_at
       FROM imap_accounts
      WHERE owner_key = $1
      ORDER BY email`,
    [ownerKey],
  );
  return rows;
}

/** Every linked IMAP mailbox for an owner: [{ email, provider }]. */
async function emailsFor(ownerKey) {
  const { rows } = await pool.query(
    'SELECT email, provider FROM imap_accounts WHERE owner_key = $1 ORDER BY email',
    [ownerKey],
  );
  return rows;
}

/** The credential handle imap_api takes. Scoped to the owner, like every read here. */
async function credentialsFor(ownerKey, email) {
  const { rows } = await pool.query(
    'SELECT email, provider, password_enc FROM imap_accounts WHERE owner_key = $1 AND email = $2',
    [ownerKey, String(email).toLowerCase()],
  );
  if (!rows.length) throw new Error(`No linked mailbox for ${email}. Link it first, then retry.`);
  const row = rows[0];
  return { email: row.email, provider: row.provider, password: crypt.decrypt(row.password_enc) };
}

/**
 * Unlinking deletes the stored password. There is no remote revoke for an app
 * password, so the link page tells the user to delete it at the provider too.
 */
async function remove(ownerKey, email) {
  const { rowCount } = await pool.query(
    'DELETE FROM imap_accounts WHERE owner_key = $1 AND email = $2',
    [ownerKey, String(email).toLowerCase()],
  );
  return rowCount > 0;
}

async function removeAll(ownerKey) {
  const { rows } = await pool.query(
    'DELETE FROM imap_accounts WHERE owner_key = $1 RETURNING email',
    [ownerKey],
  );
  return rows.map(r => r.email);
}

module.exports = { link, list, emailsFor, credentialsFor, remove, removeAll };
