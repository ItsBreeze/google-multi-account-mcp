/**
 * Public pages — home, privacy, terms.
 *
 * These exist because Google's OAuth verification requires them: a home page
 * that says what the app is, and privacy/terms pages on the same origin. They
 * are served by the connector itself so they live wherever it lives — pointing
 * a custom domain at the deployment moves them with it, nothing to re-host.
 *
 * The privacy policy is written from the code, not from a template. Every
 * claim in it is checkable against src/: what is stored (crypto_box-encrypted
 * tokens, hashed grants), what is never stored (content), and why each scope
 * is requested. When the code changes what it stores or asks for, this page
 * is part of that change.
 */

const express = require('express');
const google  = require('../services/google_oauth');

const router = express.Router();

const APP_NAME = 'Google Multi-Account Connector';
const CONTACT  = (process.env.SUPPORT_EMAIL || 'brisebyme@gmail.com').trim();
const UPDATED  = 'September 1, 2026';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Wide, left-aligned column — these are documents, not dialogs. */
const page = (title, inner) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, system-ui, sans-serif; margin: 0 auto;
         max-width: 720px; padding: 48px 24px 96px; }
  h1 { font-size: 1.6rem; margin: 0 0 .35rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
  p, li { opacity: .82; }
  .sub { opacity: .6; font-size: .9rem; margin-bottom: 2rem; }
  ul { padding-left: 1.2rem; } li { margin: .35rem 0; }
  code { background: rgba(128,128,128,.15); padding: .12rem .35rem; border-radius: 5px; font-size: .9em; }
  a { color: #2563eb; }
  nav { margin-bottom: 2.5rem; font-size: .9rem; }
  nav a { margin-right: 1.25rem; text-decoration: none; }
  .btn { display: inline-block; padding: .7rem 1.4rem; border-radius: 10px; background: #2563eb;
         color: #fff; text-decoration: none; font-weight: 600; margin-top: .75rem; }
  table { border-collapse: collapse; width: 100%; font-size: .95rem; }
  td, th { text-align: left; padding: .5rem .75rem .5rem 0; vertical-align: top;
           border-bottom: 1px solid rgba(128,128,128,.25); }
  th { opacity: .6; font-weight: 600; }
</style></head>
<body>
<nav><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
${inner}
</body></html>`;

// ─── Home ───────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.type('html').send(page(APP_NAME, `
  <h1>${APP_NAME}</h1>
  <p class="sub">Several Google accounts in one Claude connector.</p>

  <p>Claude's first-party Google connectors hold one account each. This server holds
     as many as you link — a personal Gmail and a work one, their calendars, Drives,
     contacts and tasks — and lets Claude search and act across all of them at once,
     or any one of them by name.</p>

  <h2>What it can do</h2>
  <ul>
    <li><strong>Gmail</strong> — search, read, draft, send, label, archive, trash.
        Permanent deletion is not requested and not possible.</li>
    <li><strong>Calendar</strong> — a merged timeline across every account, plus
        event creation, responses, and free-slot suggestions.</li>
    <li><strong>Drive</strong> — search, read (including text inside Office files and
        PDFs), create, edit, share, trash. Every outward action has an undo.</li>
    <li><strong>Contacts</strong> — read-only, so "email Ann" resolves to an address.</li>
    <li><strong>Tasks</strong> — read and write, across accounts.</li>
  </ul>

  <h2>How access works</h2>
  <p>You sign in with Google, then link each account you want reachable. Accounts you
     link are reachable by you and nobody else — every credential this server issues
     carries your identity, and every request is scoped to it.</p>

  <h2>Connect it</h2>
  <p>In Claude: Settings → Connectors → Add custom connector, with this URL:</p>
  <p><code>${escapeHtml(google.normalizeBaseUrl(process.env.PUBLIC_BASE_URL) || 'https://<your-deployment>')}/mcp</code></p>
  <a class="btn" href="/gmail/connect">Link a Google account</a>

  <h2>Source</h2>
  <p>The connector is open source:
     <a href="https://github.com/ItsBreeze/google-multi-account-mcp">github.com/ItsBreeze/google-multi-account-mcp</a>.
     Questions: <a href="mailto:${escapeHtml(CONTACT)}">${escapeHtml(CONTACT)}</a>.</p>`));
});

// ─── Privacy ────────────────────────────────────────────────────────────────

router.get('/privacy', (req, res) => {
  res.type('html').send(page(`Privacy Policy — ${APP_NAME}`, `
  <h1>Privacy Policy</h1>
  <p class="sub">Last updated ${UPDATED}</p>

  <p>${APP_NAME} ("the service") connects Google accounts you choose to link to an
     AI assistant you use, through the Model Context Protocol. This policy describes
     exactly what the service stores, what it never stores, and why it asks for the
     access it asks for. The service is open source, so every statement here can be
     checked against the code.</p>

  <h2>What we store</h2>
  <ul>
    <li><strong>Google OAuth tokens</strong> for each account you link — encrypted at
        rest with AES-256-GCM. The database never holds a usable token.</li>
    <li><strong>Account identifiers</strong> — the email address and Google subject ID
        of each linked account, the scopes Google granted, and timestamps.</li>
    <li><strong>Your sign-in identity</strong> — the Google subject ID of the account
        you sign in with, used as the key that ties your linked accounts to you and
        to no one else.</li>
    <li><strong>Connector credentials</strong> — OAuth clients your AI assistant
        registers, and authorization codes and refresh tokens it is issued. Codes and
        tokens are stored as one-way hashes; codes are single-use and expire in five
        minutes, refresh tokens rotate on every use.</li>
  </ul>

  <h2>What we never store</h2>
  <p>Content. Emails, attachments, calendar events, files, contacts and tasks flow
     through the service in response to a request from your AI assistant and are not
     written to disk or database. There is no logging of message bodies, file
     contents, or search results.</p>

  <h2>Google user data, scope by scope</h2>
  <p>Each Google account you link grants these scopes, each for one reason:</p>
  <table>
    <tr><th>Scope</th><th>Why</th></tr>
    <tr><td><code>gmail.modify</code></td>
        <td>Search, read, draft, send, label, archive and trash mail on your
            instruction. This scope deliberately excludes permanent deletion —
            nothing the service can do destroys mail irrecoverably.</td></tr>
    <tr><td><code>calendar</code></td>
        <td>Read your calendars and create or respond to events on your instruction.</td></tr>
    <tr><td><code>drive</code></td>
        <td>Search, read, create, edit, share and trash files on your instruction.
            The service does not expose Drive's permanent-delete endpoint.</td></tr>
    <tr><td><code>contacts.readonly</code>, <code>contacts.other.readonly</code></td>
        <td>Resolve names to addresses ("email Ann"). Read-only; the service cannot
            change your address book.</td></tr>
    <tr><td><code>tasks</code></td>
        <td>Read and update your task lists on your instruction.</td></tr>
    <tr><td><code>openid</code>, <code>userinfo.email</code>, <code>userinfo.profile</code></td>
        <td>Know which account was linked, and which person is signed in.</td></tr>
  </table>

  <h2>Limited Use disclosure</h2>
  <p>The service's use and transfer of information received from Google APIs adheres
     to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google
     API Services User Data Policy</a>, including the Limited Use requirements.
     Google user data is used only to provide the features described above, at your
     request. It is not used for advertising, not sold, not used to train machine
     learning models, and not read by humans except with your explicit consent for
     support, for security, or where required by law.</p>

  <h2>Who your data goes to</h2>
  <ul>
    <li><strong>Google</strong> — every read and write is a request to Google's APIs,
        authorized by the tokens for the relevant account.</li>
    <li><strong>Your AI assistant</strong> — results are returned to the MCP client
        (for example, Claude) that made the request under your credentials. What that
        assistant retains is governed by its own privacy policy.</li>
    <li><strong>Nobody else.</strong> There are no analytics, no advertising partners,
        and no sale or sharing of data.</li>
  </ul>

  <h2>Isolation between users</h2>
  <p>Every credential the service issues carries the identity of the person who signed
     in, and every request is scoped to that identity. One user cannot list, read, or
     act on another user's linked accounts, including by naming them directly.</p>

  <h2>Where data lives</h2>
  <p>The service and its PostgreSQL database are hosted on
     <a href="https://railway.com">Railway</a>. Connections are TLS end to end; the
     database is reachable only over the deployment's private network.</p>

  <h2>Retention and deletion</h2>
  <ul>
    <li><strong>Unlink an account</strong> at <a href="/gmail/connect">/gmail/connect</a> —
        the service revokes its grant with Google and deletes the stored tokens and
        identifiers for that account.</li>
    <li><strong>Revoke from Google's side</strong> at
        <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> —
        stored tokens become useless immediately.</li>
    <li><strong>Full deletion</strong> — email <a href="mailto:${escapeHtml(CONTACT)}">${escapeHtml(CONTACT)}</a>
        and every record tied to your identity is deleted.</li>
    <li>Expired authorization codes and refresh tokens are purged automatically.</li>
  </ul>

  <h2>Changes</h2>
  <p>Material changes to this policy will be reflected on this page with a new
     "last updated" date before they take effect.</p>

  <h2>Contact</h2>
  <p><a href="mailto:${escapeHtml(CONTACT)}">${escapeHtml(CONTACT)}</a></p>`));
});

// ─── Terms ──────────────────────────────────────────────────────────────────

router.get('/terms', (req, res) => {
  res.type('html').send(page(`Terms of Service — ${APP_NAME}`, `
  <h1>Terms of Service</h1>
  <p class="sub">Last updated ${UPDATED}</p>

  <h2>The service</h2>
  <p>${APP_NAME} connects Google accounts you link to an AI assistant you use, so the
     assistant can read and act on those accounts at your instruction. By signing in
     or linking an account you agree to these terms.</p>

  <h2>Your account and your instructions</h2>
  <ul>
    <li>You may only link Google accounts you are authorized to use.</li>
    <li>Actions the service performs — sending mail, editing files, changing events —
        are performed on your instruction, through your AI assistant, using your
        granted access. You are responsible for those instructions.</li>
    <li>You can unlink any account, or revoke the service's access from your Google
        account settings, at any time.</li>
  </ul>

  <h2>Acceptable use</h2>
  <p>Do not use the service to send spam, to access accounts without authorization,
     or in violation of Google's terms or applicable law. Access may be suspended for
     abuse.</p>

  <h2>No warranty</h2>
  <p>The service is provided "as is", without warranty of any kind. It may be
     unavailable, change, or end at any time. To the maximum extent permitted by law,
     the operator is not liable for indirect, incidental or consequential damages, or
     for loss of data, arising from use of the service.</p>

  <h2>Privacy</h2>
  <p>The <a href="/privacy">Privacy Policy</a> describes what the service stores and
     why, and is part of these terms.</p>

  <h2>Governing law</h2>
  <p>These terms are governed by the laws of British Columbia, Canada.</p>

  <h2>Contact</h2>
  <p><a href="mailto:${escapeHtml(CONTACT)}">${escapeHtml(CONTACT)}</a></p>`));
});

module.exports = router;
