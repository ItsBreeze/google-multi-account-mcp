/**
 * Subscription pages and the Stripe webhook.
 *
 *   GET  /billing          status, and the subscribe or manage button
 *   POST /billing/checkout  → Stripe Checkout
 *   POST /billing/portal    → Stripe customer portal (card, cancel, receipts)
 *   POST /billing/webhook   Stripe → us; mounted with a raw body, see app.js
 */

const express  = require('express');
const billing  = require('../services/billing');
const identity = require('../services/identity');
const google   = require('../services/google_oauth');

const router = express.Router();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const baseUrl = () => google.normalizeBaseUrl(process.env.PUBLIC_BASE_URL);

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
  button, .btn { display: block; width: 100%; box-sizing: border-box; text-align: center;
    padding: .85rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 10px;
    background: #2563eb; color: #fff; text-decoration: none; margin-top: .5rem; cursor: pointer; }
  code { background: rgba(128,128,128,.15); padding: .15rem .35rem; border-radius: 5px; font-size: .9em; }
  .err { color: #dc2626; font-size: .9rem; margin-bottom: .6rem; }
  .ok { color: #16a34a; font-weight: 600; }
  .alt { margin-top: 1rem; font-size: .85rem; text-align: center; }
</style></head>
<body><div class="card">${inner}</div></body></html>`;

const signInPrompt = () => page('Sign in', `
  <h1>Sign in</h1>
  <p>Sign in with the Google account you use with the connector.</p>
  <a class="btn" href="/gmail/signin?next=%2Fbilling">Continue with Google</a>`);

function statusPage(session, { entitled, row, error, justPaid }) {
  const who = `<p>Signed in as <code>${escapeHtml(session.email || session.ownerKey)}</code>.</p>`;
  const err = error ? `<div class="err">${escapeHtml(error)}</div>` : '';

  if (entitled) {
    const renews = row?.current_period_end && row.status !== 'comp'
      ? ` Renews ${new Date(row.current_period_end).toISOString().slice(0, 10)}.` : '';
    const manage = row?.stripe_customer_id
      ? `<form method="POST" action="/billing/portal"><button type="submit">Manage subscription</button></form>`
      : '';
    return page('Subscription', `
      <h1>${justPaid ? 'You’re subscribed' : 'Subscription'}</h1>
      ${who}${err}
      <p class="ok">Active.${escapeHtml(renews)}</p>
      <p>Claude can use every tool on every account you link.</p>
      <a class="btn" href="/gmail/connect">Link a Google account</a>
      ${manage}`);
  }

  return page('Subscribe', `
    <h1>Subscribe — ${escapeHtml(billing.priceLabel())}</h1>
    ${who}${err}
    <p>Claude can reach Gmail, Calendar, Drive, Contacts and Tasks across every Google
       account you link, for ${escapeHtml(billing.priceLabel())}. Cancel any time from this page.</p>
    <form method="POST" action="/billing/checkout"><button type="submit">Subscribe</button></form>
    ${row?.stripe_customer_id
      ? `<form method="POST" action="/billing/portal"><button type="submit" style="background:transparent;color:inherit;border:1px solid rgba(128,128,128,.4)">Billing history</button></form>`
      : ''}
    <p class="alt"><a href="/gmail/connect">Link accounts</a> · <a href="/terms">Terms</a></p>`);
}

router.get('/', async (req, res, next) => {
  try {
    const session = identity.readSession(req);
    if (!session) return res.status(401).type('html').send(signInPrompt());

    if (!billing.enabled()) {
      return res.type('html').send(page('Subscription', `
        <h1>No subscription needed</h1>
        <p>This deployment doesn't charge. Everything is available.</p>
        <a class="btn" href="/gmail/connect">Link a Google account</a>`));
    }

    let error = null;
    let justPaid = false;
    if (req.query.session_id) {
      try { justPaid = await billing.syncCheckout(String(req.query.session_id), session.ownerKey); }
      catch (err) { error = 'Payment received but not confirmed yet — refresh in a minute.'; console.error('[billing] sync:', err.message); }
    }

    const [entitled, row] = await Promise.all([billing.isEntitled(session.ownerKey), billing.get(session.ownerKey)]);
    res.type('html').send(statusPage(session, { entitled, row, error, justPaid }));
  } catch (err) { next(err); }
});

router.post('/checkout', async (req, res, next) => {
  try {
    const session = identity.readSession(req);
    if (!session) return res.status(401).type('html').send(signInPrompt());
    if (!billing.enabled()) return res.redirect(303, '/billing');
    res.redirect(303, await billing.checkoutUrl({ ownerKey: session.ownerKey, email: session.email, baseUrl: baseUrl() }));
  } catch (err) { next(err); }
});

router.post('/portal', async (req, res, next) => {
  try {
    const session = identity.readSession(req);
    if (!session) return res.status(401).type('html').send(signInPrompt());
    const url = billing.enabled() && await billing.portalUrl({ ownerKey: session.ownerKey, baseUrl: baseUrl() });
    res.redirect(303, url || '/billing');
  } catch (err) { next(err); }
});

/** Needs the exact bytes Stripe signed, so app.js mounts it ahead of express.json(). */
const webhook = [express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  let event;
  try {
    event = billing.verifyWebhook(req.body.toString('utf8'), req.headers['stripe-signature']);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    await billing.handleEvent(event);
    res.json({ received: true });
  } catch (err) {
    // 500 makes Stripe retry, which is what we want for a transient DB or API failure.
    console.error('[billing] webhook:', event.type, err.message);
    res.status(500).json({ error: 'handler failed' });
  }
}];

module.exports = { router, webhook };
