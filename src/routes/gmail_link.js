/**
 * Sign-in, and account linking — run once per Google account, in a browser.
 *
 * Two different grants meet at one callback, told apart by the `purpose` in the
 * signed state:
 *
 *   identity   — openid/email/profile only. Establishes *who you are* and puts
 *                it in a session cookie. Reads nothing.
 *   gmail_link — the full per-mailbox grant. Attaches a mailbox to whoever the
 *                session says you are.
 *
 * They share Google's redirect URI deliberately: one authorized redirect URI in
 * the Cloud console keeps working, so adding sign-in does not require anyone to
 * touch their OAuth client.
 *
 * Linking is gated on a session rather than a shared password. A password says
 * only that someone knew a secret; a session says which person is asking, which
 * is what decides whose mailboxes the new link joins.
 */

const express  = require('express');
const jwt      = require('jsonwebtoken');
const google   = require('../services/google_oauth');
const accounts = require('../services/gmail_accounts');
const identity = require('../services/identity');
const mcpOauth = require('../services/mcp_oauth');

const router = express.Router();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, inner) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 -apple-system, system-ui, sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100dvh; padding: 24px; }
  .card { width: 100%; max-width: 420px; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; opacity: .75; font-size: .95rem; }
  input[type=email] { width: 100%; padding: .8rem; font-size: 1rem;
    box-sizing: border-box; border: 1px solid rgba(128,128,128,.5); border-radius: 10px;
    background: transparent; color: inherit; margin-bottom: .6rem; }
  button, .btn { display: block; width: 100%; box-sizing: border-box; text-align: center;
    padding: .85rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 10px;
    background: #2563eb; color: #fff; text-decoration: none; margin-top: .5rem; }
  ul { padding-left: 1.1rem; } li { margin: .3rem 0; }
  code { background: rgba(128,128,128,.15); padding: .15rem .35rem; border-radius: 5px; font-size: .9em; }
  .err { color: #dc2626; font-size: .9rem; margin-bottom: .6rem; }
  .ok { color: #16a34a; font-weight: 600; }
  .alt { margin-top: 1rem; font-size: .85rem; text-align: center; }
</style></head>
<body><div class="card">${inner}</div></body></html>`;

/** The exact redirect URI this deployment sends — a public value, safe to show. */
function redirectUriInUse() {
  try { return google.config().redirectUri; } catch { return '(unavailable — check PUBLIC_BASE_URL)'; }
}

/**
 * Where to go after signing in.
 *
 * Same-origin paths only. `next` arrives in a URL that anyone can hand a user,
 * so echoing it into a redirect unchecked is an open redirector — and one
 * attached to a login, which is exactly where a convincing phishing hop starts.
 * A leading `//` is rejected too: browsers read `//evil.example` as protocol-
 * relative and leave the site.
 */
function safeNext(raw) {
  const value = String(raw || '');
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

const signInPrompt = (nextUrl, message) => page('Sign in', `
  <h1>Sign in</h1>
  <p>${escapeHtml(message || 'Sign in with Google to manage the accounts linked to this connector.')}</p>
  <p>This step reads nothing. It asks Google only for your identity, so the
     connector knows whose mailboxes to show you.</p>
  <a class="btn" href="/gmail/signin?next=${encodeURIComponent(nextUrl)}">Continue with Google</a>
  <p style="margin-top:1.5rem;font-size:.85rem">If Google answers
     <code>redirect_uri_mismatch</code>, this deployment is sending the redirect URI
     below — add it, character for character, to your OAuth client's authorized
     redirect URIs. It is shown here, before sign-in, precisely because that error
     blocks signing in.</p>
  <p><code>${escapeHtml(redirectUriInUse())}</code></p>`);

// ─── Sign in / sign out ─────────────────────────────────────────────────────

router.get('/signin', (req, res, next) => {
  try {
    const state = jwt.sign(
      { purpose: 'identity', next: safeNext(req.query.next) },
      process.env.JWT_SECRET,
      { expiresIn: '10m' },
    );

    res.redirect(302, identity.signInUrl({ state, loginHint: req.query.login_hint || undefined }));
  } catch (err) {
    next(err);
  }
});

router.get('/signout', (req, res) => {
  identity.clearSession(res);
  res.redirect(302, safeNext(req.query.next) || '/gmail/connect');
});

// ─── Link a mailbox ─────────────────────────────────────────────────────────

const linkForm = (session, error) => page('Link a Google account', `
  <h1>Link a Google account</h1>
  <p>Signed in as <code>${escapeHtml(session.email || session.ownerKey)}</code>.
     Accounts you link here are reachable by you and nobody else.</p>
  <p>Linking grants this server <strong>Gmail</strong> (read, send, label, archive, trash —
     never permanent delete), <strong>Calendar</strong> and <strong>Tasks</strong> (read and write),
     <strong>Drive</strong> (read, create, edit, share, trash) and <strong>Contacts</strong>
     (read only), for that account.</p>
  <p>An account linked before a product was added holds an older grant. Linking it
     again here adds the missing access and changes nothing else.</p>
  <p>This server will send Google the redirect URI below. It must appear
     <em>character for character</em> in your OAuth client's authorized redirect
     URIs, or consent fails with <code>redirect_uri_mismatch</code>.</p>
  <p><code>${escapeHtml(redirectUriInUse())}</code></p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  <form method="POST" action="/gmail/connect">
    <input type="email" name="login_hint" placeholder="Account to link (optional)" autocomplete="off">
    <button type="submit">Continue to Google</button>
  </form>
  <p class="alt"><a href="/gmail/signout?next=%2Fgmail%2Fconnect">Sign out</a></p>
  <details style="margin-top:2.5rem">
    <summary style="cursor:pointer;font-size:.85rem;opacity:.6">Delete everything</summary>
    <p style="font-size:.85rem">Unlinks every account (revoking this server's access at
       Google), deletes the stored tokens and your identity's records here, and signs
       you out. Nothing about you remains. Type <code>delete</code> to confirm.</p>
    <form method="POST" action="/gmail/delete-everything">
      <input type="text" name="confirm" placeholder="delete" autocomplete="off">
      <button type="submit" style="background:#b91c1c">Delete everything</button>
    </form>
  </details>`);

router.get('/connect', (req, res) => {
  const session = identity.readSession(req);
  if (!session) return res.status(401).type('html').send(signInPrompt('/gmail/connect'));
  res.type('html').send(linkForm(session, null));
});

router.post('/connect', express.urlencoded({ extended: false }), (req, res, next) => {
  try {
    const session = identity.readSession(req);
    if (!session) return res.status(401).type('html').send(signInPrompt('/gmail/connect', 'Your sign-in expired.'));

    // The owner travels in the signed state, so the mailbox lands on the identity
    // that started the flow even if the cookie lapses during Google's consent.
    const state = jwt.sign(
      { purpose: 'gmail_link', ownerKey: session.ownerKey },
      process.env.JWT_SECRET,
      { expiresIn: '10m' },
    );

    res.redirect(302, google.authUrl({ state, loginHint: req.body?.login_hint || undefined }));
  } catch (err) {
    next(err);
  }
});

// ─── Credential self-check ──────────────────────────────────────────────────

/**
 * Verifies GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET against Google without
 * running a full consent round-trip. Session-gated because it reports on
 * configuration.
 */
router.get('/check', async (req, res, next) => {
  try {
    const session = identity.readSession(req);
    if (!session) return res.status(401).type('html').send(signInPrompt('/gmail/check'));

    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const secret   = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const result   = await google.verifyCredentials();

    // Shape checks catch the common paste mistakes before Google even matters.
    const notes = [];
    if (!clientId.endsWith('.apps.googleusercontent.com')) {
      notes.push('GOOGLE_CLIENT_ID does not end in .apps.googleusercontent.com — wrong value or a pasted "KEY=" prefix.');
    }
    if (!secret.startsWith('GOCSPX-')) {
      notes.push('GOOGLE_CLIENT_SECRET does not start with GOCSPX- — wrong value or a pasted "KEY=" prefix.');
    }
    if (/^GOOGLE_CLIENT_(ID|SECRET)=/.test(clientId) || /^GOOGLE_CLIENT_(ID|SECRET)=/.test(secret)) {
      notes.push('A variable still contains its own name — store only the value.');
    }

    res.type('html').send(page('Credential check', `
      <h1>${result.ok ? '<span class="ok">✓</span> Credentials accepted' : 'Credentials rejected'}</h1>
      <p>${escapeHtml(result.detail)}</p>
      ${result.culprit ? `<p class="err">Fix <code>${escapeHtml(result.culprit)}</code> in your host's environment.</p>` : ''}
      ${notes.length ? `<ul>${notes.map(n => `<li class="err">${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
      <p>Client ID: <code>${escapeHtml(clientId || '(unset)')}</code></p>
      <p>Secret: <code>${secret ? `${secret.length} chars, starts "${escapeHtml(secret.slice(0, 7))}…"` : '(unset)'}</code></p>
      <p>Redirect URI: <code>${escapeHtml(redirectUriInUse())}</code></p>
      <a class="btn" href="/gmail/connect">Back to linking</a>`));
  } catch (err) {
    next(err);
  }
});

// ─── Google's callback, for both grants ─────────────────────────────────────

router.get('/oauth/callback', async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.status(400).type('html').send(page('Link failed', `
        <h1>Google declined</h1>
        <p>${escapeHtml(req.query.error_description || req.query.error)}</p>
        <a class="btn" href="/gmail/connect">Try again</a>`));
    }

    let state;
    try {
      state = jwt.verify(req.query.state || '', process.env.JWT_SECRET);
    } catch {
      return res.status(400).type('html').send(page('Link failed', `
        <h1>Expired or invalid link attempt</h1>
        <p>Start again — the request must be completed within 10 minutes.</p>
        <a class="btn" href="/gmail/connect">Start over</a>`));
    }

    const tokens = await google.exchangeCode(req.query.code);
    const info   = await google.fetchUserinfo(tokens.access_token);

    if (!info.email) throw new Error('Google did not return an email address for this account');

    // ── Identity: establish the session, adopt any pre-identity mailboxes ──
    if (state.purpose === 'identity') {
      if (!info.sub) throw new Error('Google did not return a subject identifier for this account');

      const ownerKey = identity.ownerKeyFor(info.sub);
      const claimed  = await identity.claimLegacyAccounts({ ownerKey, email: info.email });

      identity.issueSession(res, { ownerKey, email: info.email });

      const target = safeNext(state.next);
      if (target) return res.redirect(302, target);

      const linked = await accounts.list(ownerKey);
      return res.type('html').send(page('Signed in', `
        <h1><span class="ok">✓</span> Signed in as ${escapeHtml(info.email)}</h1>
        ${claimed ? `<p>Adopted ${claimed} account(s) linked before sign-in existed.</p>` : ''}
        <p>Accounts connected (${linked.length}):</p>
        <ul>${linked.map(a => `<li><code>${escapeHtml(a.email)}</code></li>`).join('') || '<li>none yet</li>'}</ul>
        <a class="btn" href="/gmail/connect">Link an account</a>`));
    }

    // ── Mailbox link: attach to the identity that started the flow ──
    if (state.purpose !== 'gmail_link' || !state.ownerKey) {
      return res.status(400).type('html').send(page('Link failed', `
        <h1>Unrecognized link attempt</h1>
        <p>Start again from the linking page.</p>
        <a class="btn" href="/gmail/connect">Start over</a>`));
    }

    const ownerKey = state.ownerKey;

    await accounts.upsertFromGrant({
      ownerKey,
      email:     info.email,
      googleSub: info.sub,
      tokens,
    });

    const linked = await accounts.list(ownerKey);
    const warning = tokens.refresh_token
      ? ''
      : '<p class="err">Google returned no refresh token. If access stops working, unlink and re-link this account.</p>';

    // What Google actually granted, not what was asked for: it drops scopes for
    // APIs that are not enabled on the Cloud project, and does so silently.
    const access  = accounts.productAccess(tokens.scope);
    const missing = access.missing.length
      ? `<p class="err">Google did not grant: <strong>${escapeHtml(access.missing.join(', '))}</strong>.
         That almost always means those APIs are not enabled on the Google Cloud project.
         Enable them under APIs &amp; Services → Library, then link this account again.</p>`
      : '<p>All five products granted.</p>';

    res.type('html').send(page('Linked', `
      <h1><span class="ok">✓</span> ${escapeHtml(info.email)} linked</h1>
      ${warning}
      <p>Access granted: <code>${escapeHtml(access.granted.join(', ') || 'none')}</code></p>
      ${missing}
      <p>Accounts now connected (${linked.length}):</p>
      <ul>${linked.map(a => `<li><code>${escapeHtml(a.email)}</code></li>`).join('')}</ul>
      <a class="btn" href="/gmail/connect">Link another account</a>`));
  } catch (err) {
    next(err);
  }
});

// ─── Operator JSON ──────────────────────────────────────────────────────────

/** Linked-account list for the signed-in user; the MCP tool covers the model's needs. */
router.post('/accounts', express.urlencoded({ extended: false }), express.json(), async (req, res, next) => {
  try {
    const session = identity.readSession(req);
    if (!session) return res.status(401).json({ error: 'unauthorized' });
    res.json({ accounts: await accounts.list(session.ownerKey) });
  } catch (err) { next(err); }
});

/**
 * Full self-serve deletion: every linked account (revoked at Google), every
 * MCP credential, then the session itself. The privacy policy promises this
 * on request; a button keeps the promise without the email round-trip.
 */
router.post('/delete-everything', express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const session = identity.readSession(req);
    if (!session) return res.status(401).type('html').send(signInPrompt('/gmail/connect', 'Your sign-in expired.'));
    if ((req.body?.confirm || '').trim().toLowerCase() !== 'delete') {
      return res.status(400).type('html').send(linkForm(session, 'Type "delete" in the confirmation box to delete everything.'));
    }

    const emails = await accounts.removeAll(session.ownerKey);
    await mcpOauth.deleteOwnerGrants(session.ownerKey);
    identity.clearSession(res);

    res.type('html').send(page('Deleted', `
      <h1>Everything is deleted</h1>
      <p>${emails.length
          ? `Unlinked and revoked: ${emails.map(e => `<code>${escapeHtml(e)}</code>`).join(', ')}.`
          : 'There were no linked accounts.'}
         Stored tokens are gone and you are signed out.</p>
      <p>Connected AI assistants lose access the moment their current hour's
         token expires. You can also revoke this server from your
         <a href="https://myaccount.google.com/permissions">Google account permissions</a> —
         though the grants above were already revoked from this side.</p>
      <a class="btn" href="/gmail/connect">Start over</a>`));
  } catch (err) { next(err); }
});

router.post('/unlink', express.urlencoded({ extended: false }), express.json(), async (req, res, next) => {
  try {
    const session = identity.readSession(req);
    if (!session) return res.status(401).json({ error: 'unauthorized' });
    if (!req.body?.email) return res.status(400).json({ error: 'email is required' });

    // Scoped to the caller: unlinking can only ever reach your own rows.
    const removed = await accounts.remove(session.ownerKey, req.body.email);
    res.status(removed ? 200 : 404).json({ removed, email: req.body.email });
  } catch (err) { next(err); }
});

router._internal = { safeNext };

module.exports = router;
