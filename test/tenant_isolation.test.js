/**
 * One person cannot reach another person's mailboxes.
 *   npm run test:isolation
 *
 * Until per-user identity, every MCP token carried the subject 'owner' and
 * there was exactly one set of mailboxes, so there was nothing here to test.
 * Now the subject is whoever signed in, and the failure this guards against is
 * silent: not an error, but a successful call that returns somebody else's mail.
 *
 * So these assert on the seam rather than on the tools. Two things have to hold
 * for isolation to be real —
 *
 *   1. the owner key is carried by the token, end to end, including across a
 *      refresh (a refresh that forgets who it belonged to is how a session
 *      quietly widens into a shared one), and
 *   2. every read is scoped by that key, including when the caller names
 *      another person's address outright.
 *
 * The account store is stubbed so that fetching a token for a mailbox its owner
 * does not own *throws*. That way a leak fails loudly here instead of returning
 * plausible data.
 */

process.env.JWT_SECRET      = process.env.JWT_SECRET      || 'test-jwt-secret';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://test.example.com';
process.env.DATABASE_URL    = process.env.DATABASE_URL    || 'postgresql://user:pw@127.0.0.1:5432/none';
process.env.TOKEN_ENC_KEY   = process.env.TOKEN_ENC_KEY   || 'a'.repeat(64);

let fail = 0;
const check = (name, cond, extra = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + String(extra).slice(0, 140) : ''}`);
};

const rejects = async (fn, matcher) => {
  try { await fn(); return { threw: false, message: '(resolved)' }; }
  catch (err) { return { threw: !matcher || matcher.test(err.message), message: err.message }; }
};

// ─── In-memory stand-in for the two OAuth tables ────────────────────────────

const pool = require('../src/db/pool');
const codes   = new Map();
const refresh = new Map();

pool.query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, ' ').trim();

  if (q.startsWith('INSERT INTO mcp_auth_codes')) {
    const [hash, client_id, redirect_uri, code_challenge, scope, expires_at, owner_key] = params;
    codes.set(hash, { client_id, redirect_uri, code_challenge, scope, expires_at, owner_key });
    return { rows: [], rowCount: 1 };
  }
  if (q.startsWith('DELETE FROM mcp_auth_codes') && q.includes('RETURNING')) {
    const row = codes.get(params[0]);
    codes.delete(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (q.startsWith('INSERT INTO mcp_refresh_tokens')) {
    const [hash, client_id, scope, expires_at, owner_key] = params;
    refresh.set(hash, { client_id, scope, expires_at, owner_key });
    return { rows: [], rowCount: 1 };
  }
  if (q.startsWith('DELETE FROM mcp_refresh_tokens') && q.includes('RETURNING')) {
    const row = refresh.get(params[0]);
    refresh.delete(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
};

const oauth    = require('../src/services/mcp_oauth');
const identity = require('../src/services/identity');

// ─── Two people, two mailboxes ──────────────────────────────────────────────

const ALICE = identity.ownerKeyFor('1111');
const BOB   = identity.ownerKeyFor('2222');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/tasks',
].join(' ');

const row = (email) => ({
  email, created_at: '2026-01-01T00:00:00Z', has_refresh_token: true,
  token_expires_at: '2030-01-01T00:00:00Z', scopes: SCOPES,
});

const MAILBOXES = {
  [ALICE]: [row('alice@example.com'), row('alice.work@example.com')],
  [BOB]:   [row('bob@example.com')],
};

const accounts = require('../src/services/gmail_accounts');
accounts.list      = async (ownerKey) => MAILBOXES[ownerKey] || [];
accounts.emailsFor = async (ownerKey) => (MAILBOXES[ownerKey] || []).map(r => r.email);
accounts.accessTokenFor = async (ownerKey, email) => {
  const owned = (MAILBOXES[ownerKey] || []).some(r => r.email === email);
  // The whole point: reaching across owners is an exception, never a token.
  if (!owned) throw new Error(`ISOLATION BREACH: ${ownerKey} obtained a token for ${email}`);
  return 'stub-access-token';
};

const tools = require('../src/mcp/tools');
const shared = require('../src/mcp/shared');

// ─── 1. The owner key survives the whole token lifecycle ────────────────────

async function tokenLifecycle() {
  const missingCode = await rejects(
    () => oauth.issueAuthCode({ clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: 'ch', scope: 'mcp' }),
    /ownerKey/,
  );
  check('authorization code without an owner is refused', missingCode.threw, missingCode.message);

  const missingToken = await rejects(() => oauth.issueTokens({ clientId: 'c1', scope: 'mcp' }), /ownerKey/);
  check('token without an owner is refused', missingToken.threw, missingToken.message);

  // Alice signs in and authorizes.
  const code = await oauth.issueAuthCode({
    clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: null, scope: 'mcp', ownerKey: ALICE,
  });
  const granted = await oauth.consumeAuthCode({ code, clientId: 'c1', redirectUri: 'https://x/cb' });
  check('authorization code carries the owner to the token endpoint', granted.owner_key === ALICE, granted.owner_key);

  const issued = await oauth.issueTokens({ clientId: 'c1', scope: granted.scope, ownerKey: granted.owner_key });
  check('access token subject is the signed-in identity',
    oauth.verifyAccessToken(issued.access_token).sub === ALICE,
    oauth.verifyAccessToken(issued.access_token).sub);

  check('subject is no longer the shared constant',
    oauth.verifyAccessToken(issued.access_token).sub !== identity.LEGACY_OWNER_KEY);

  // The refresh is where a shared subject would creep back in.
  const refreshed = await oauth.redeemRefreshToken({ refreshToken: issued.refresh_token, clientId: 'c1' });
  check('refreshed token keeps the same owner',
    oauth.verifyAccessToken(refreshed.access_token).sub === ALICE,
    oauth.verifyAccessToken(refreshed.access_token).sub);

  // Bob's tokens must never come back as Alice.
  const bobCode = await oauth.issueAuthCode({
    clientId: 'c1', redirectUri: 'https://x/cb', codeChallenge: null, scope: 'mcp', ownerKey: BOB,
  });
  const bobGrant  = await oauth.consumeAuthCode({ code: bobCode, clientId: 'c1', redirectUri: 'https://x/cb' });
  const bobIssued = await oauth.issueTokens({ clientId: 'c1', scope: 'mcp', ownerKey: bobGrant.owner_key });
  check('two people get two distinct subjects',
    oauth.verifyAccessToken(bobIssued.access_token).sub === BOB &&
    oauth.verifyAccessToken(bobIssued.access_token).sub !== oauth.verifyAccessToken(issued.access_token).sub);
}

// ─── 2. Every read is scoped to that key ────────────────────────────────────

async function readsAreScoped() {
  const aliceSees = await tools.callTool('list_accounts', {}, ALICE);
  const bobSees   = await tools.callTool('list_accounts', {}, BOB);

  const aliceText = JSON.stringify(aliceSees);
  const bobText   = JSON.stringify(bobSees);

  check('list_accounts shows the caller their own mailboxes', aliceText.includes('alice@example.com'));
  check('list_accounts hides other people\'s mailboxes from Alice', !aliceText.includes('bob@example.com'));
  check('list_accounts hides other people\'s mailboxes from Bob', !bobText.includes('alice@example.com'));

  // Naming someone else's address outright is the obvious attempt.
  const named = await rejects(() => shared.resolveAccount(ALICE, 'bob@example.com'), /not linked/);
  check('naming another person\'s address is refused', named.threw, named.message);

  // ...and so is the partial-match convenience path, which is the subtler one:
  // resolveAccount tolerates a bare local-part, so "bob" must not slip through.
  const partial = await rejects(() => shared.resolveAccount(ALICE, 'bob'), /not linked/);
  check('partial match cannot reach across owners', partial.threw, partial.message);

  // A fan-out with no account named must cover the caller's mailboxes and stop.
  const seen = [];
  const fanned = await shared.fanOut(ALICE, undefined, 'gmail', async (token, email) => {
    seen.push(email);
    return { messages: [] };
  });
  check('fan-out covers only the caller\'s mailboxes',
    seen.length === 2 && seen.every(e => e.startsWith('alice')), seen.join(', '));
  check('fan-out reports the caller\'s mailboxes as the searched set',
    fanned.targets.every(e => e.startsWith('alice')), fanned.targets.join(', '));

  const bobFan = [];
  await shared.fanOut(BOB, undefined, 'gmail', async (token, email) => { bobFan.push(email); return {}; });
  check('a second caller fans out over their own mailboxes only',
    bobFan.length === 1 && bobFan[0] === 'bob@example.com', bobFan.join(', '));
}

// ─── 3. Credentials from one surface do not work on another ─────────────────

async function credentialsDoNotCross() {
  const issued = await oauth.issueTokens({ clientId: 'c1', scope: 'mcp', ownerKey: ALICE });

  // An MCP bearer token presented as a browser session cookie must not be
  // accepted, or a leaked token would also be a logged-in browser.
  const asCookie = identity.readSession({ headers: { cookie: `mcp_session=${issued.access_token}` } });
  check('an MCP access token is not a valid session cookie', asCookie === null, JSON.stringify(asCookie));

  // And the reverse: a session cookie must not authenticate /mcp.
  const res = { append() {} , _v: null };
  const captured = [];
  identity.issueSession({ append: (k, v) => captured.push(v) }, { ownerKey: ALICE, email: 'alice@example.com' });
  const cookieToken = decodeURIComponent(String(captured[0]).split(';')[0].split('=').slice(1).join('='));

  let sessionAtMcp = null;
  try { sessionAtMcp = oauth.verifyAccessToken(cookieToken); } catch { sessionAtMcp = null; }
  check('a session cookie is not a valid MCP access token', sessionAtMcp === null, JSON.stringify(sessionAtMcp));

  check('the session cookie is HttpOnly and SameSite-scoped',
    /HttpOnly/.test(captured[0]) && /SameSite=Lax/.test(captured[0]), captured[0]);
}

// ─── 4. The sign-in redirect cannot be pointed off-site ─────────────────────

function redirectIsSameOrigin() {
  const { safeNext } = require('../src/routes/gmail_link')._internal;

  check('same-origin path is allowed',        safeNext('/gmail/connect') === '/gmail/connect');
  check('absolute URL is rejected',           safeNext('https://evil.example/steal') === null);
  check('protocol-relative URL is rejected',  safeNext('//evil.example/steal') === null);
  check('empty next is rejected',             safeNext('') === null);
}

(async () => {
  await tokenLifecycle();
  await readsAreScoped();
  await credentialsDoNotCross();
  redirectIsSameOrigin();

  console.log(fail ? `\n${fail} check(s) failed` : '\nAll checks passed');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
