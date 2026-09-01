/**
 * Who is calling — the piece this server did not have.
 *
 * Before per-user identity every MCP token carried the same subject, so one
 * operator password unlocked one set of mailboxes and there was nothing to
 * separate. Opening the connector to more than one person means each request
 * has to name a person, and that name has to be something the caller cannot
 * choose for themselves.
 *
 * Google is already the identity provider for every mailbox this server talks
 * to, so it is the natural one to ask. This flow requests *identity only* —
 * openid, email, profile. It reads no mail and asks for no offline access; the
 * far broader per-mailbox grant stays where it was, in google_oauth.
 *
 * The account you sign in with and the accounts you link are independent. Sign
 * in once as yourself, then link whichever mailboxes you like beneath that
 * identity.
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const google = require('./google_oauth');
const pool   = require('../db/pool');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Identity, and nothing else. Deliberately disjoint from google_oauth.SCOPES. */
const IDENTITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const SESSION_COOKIE = 'mcp_session';
const SESSION_TTL    = '30m';

/**
 * The owner_key every mailbox row hangs off.
 *
 * Google's `sub` and not the email address: an address can be renamed or
 * reassigned to a different person, and a key that moves between humans is a
 * key that hands one person another's mailboxes. `sub` is stable and opaque
 * for the life of the account. The `google:` prefix leaves room for a second
 * identity provider later without the two colliding.
 */
const ownerKeyFor = (sub) => `google:${sub}`;

/** What tokens carried before identity existed. Kept only for the cutover. */
const LEGACY_OWNER_KEY = 'owner';

/**
 * Session-cookie signing key, derived from JWT_SECRET rather than being it.
 *
 * Same reasoning as the MCP access-token key in mcp_oauth: a browser session
 * cookie and an MCP bearer token must never validate as one another, so each
 * gets its own HMAC label. A stolen session cookie is then useless at /mcp,
 * and vice versa.
 */
function sessionSecret() {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET must be set');
  return crypto.createHmac('sha256', base).update('google-multi-account-mcp-session-v1').digest('base64');
}

/** Consent URL for identity. No access_type=offline: there is nothing to refresh. */
function signInUrl({ state, loginHint }) {
  const { clientId, redirectUri } = google.config();

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         IDENTITY_SCOPES.join(' '),
    prompt:        'select_account',
    state,
  });

  if (loginHint) params.set('login_hint', loginHint);

  return `${AUTH_URL}?${params.toString()}`;
}

// ─── Session cookie ─────────────────────────────────────────────────────────

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function issueSession(res, { ownerKey, email }) {
  const token = jwt.sign({ sub: ownerKey, email }, sessionSecret(), {
    expiresIn: SESSION_TTL,
    audience:  'session',
  });

  const secure = String(process.env.PUBLIC_BASE_URL || '').startsWith('https://');

  // Lax, not Strict: the sign-in returns from Google as a top-level GET
  // navigation, and Strict would withhold the cookie on exactly that request.
  res.append('Set-Cookie', [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=1800',
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; '));
}

/** The signed-in user, or null. Never throws — an unreadable cookie is "signed out". */
function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return null;

  try {
    const claims = jwt.verify(raw, sessionSecret(), { audience: 'session' });
    return { ownerKey: claims.sub, email: claims.email };
  } catch {
    return null;
  }
}

function clearSession(res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ─── Cutover ────────────────────────────────────────────────────────────────

/**
 * Adopt the pre-identity mailboxes, once.
 *
 * A deployment that ran the single-operator build holds rows keyed 'owner'
 * that no identity can now reach. Set LEGACY_OWNER_EMAIL to the address of the
 * person those mailboxes belong to and their first sign-in re-keys them, so an
 * upgrade does not silently look like data loss and nothing has to be linked
 * again.
 *
 * Idempotent: after the update no 'owner' rows remain, so later sign-ins are
 * no-ops. Unset the variable once the cutover is done.
 */
async function claimLegacyAccounts({ ownerKey, email }) {
  const expected = String(process.env.LEGACY_OWNER_EMAIL || '').trim().toLowerCase();
  if (!expected || !email || expected !== String(email).trim().toLowerCase()) return 0;

  // A mailbox already linked under the new identity wins; dropping the stale
  // duplicate first keeps the re-key from tripping UNIQUE (owner_key, email).
  await pool.query(
    `DELETE FROM gmail_accounts a
      WHERE a.owner_key = $1
        AND EXISTS (SELECT 1 FROM gmail_accounts b WHERE b.owner_key = $2 AND b.email = a.email)`,
    [LEGACY_OWNER_KEY, ownerKey],
  );

  const { rowCount } = await pool.query(
    'UPDATE gmail_accounts SET owner_key = $1, updated_at = NOW() WHERE owner_key = $2',
    [ownerKey, LEGACY_OWNER_KEY],
  );

  if (rowCount) console.log(`[identity] claimed ${rowCount} pre-identity account(s) for ${ownerKey}`);
  return rowCount;
}

module.exports = {
  IDENTITY_SCOPES, LEGACY_OWNER_KEY, SESSION_COOKIE,
  ownerKeyFor, signInUrl,
  issueSession, readSession, clearSession, parseCookies,
  claimLegacyAccounts,
};
