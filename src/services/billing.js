/**
 * Subscription billing — one Stripe price, one subscription per identity.
 *
 * Tools are gated on it; signing in, linking accounts and deleting everything
 * are not, so nobody has to pay to find out whether it works for them or to
 * leave.
 *
 * Off until STRIPE_SECRET_KEY and STRIPE_PRICE_ID are both set. A deploy that
 * ships this code before the keys are in place keeps working exactly as before
 * instead of locking every user out.
 *
 * Stripe is called with fetch, like Google is, rather than through the SDK:
 * three endpoints and one signature check don't justify a dependency.
 */

const crypto = require('crypto');
const pool   = require('../db/pool');

const STRIPE_API = 'https://api.stripe.com/v1';

// past_due keeps access while Stripe retries the card — a declined 99¢ charge
// shouldn't cut someone off mid-conversation. Stripe moves the subscription to
// canceled or unpaid when retries run out, and that is what ends access.
const ENTITLED = new Set(['active', 'trialing', 'past_due', 'comp']);

const env = (k) => String(process.env[k] || '').trim();

const enabled = () => Boolean(env('STRIPE_SECRET_KEY') && env('STRIPE_PRICE_ID'));

const priceLabel = () => env('BILLING_PRICE_LABEL') || '$0.99/month';

/** Mailboxes whose owner never pays — the operator's own, typically. */
const exemptEmails = () => env('BILLING_EXEMPT_EMAILS')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ─── Stripe transport ───────────────────────────────────────────────────────

/** Flatten { a: { b: 1 }, c: [x] } into Stripe's a[b]=1&c[0]=x form encoding. */
function formEncode(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method, path, params) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? formEncode(params).toString() : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${path}: ${body.error?.message || res.status}`);
  return body;
}

/**
 * Verify a webhook's Stripe-Signature header against the raw body.
 * Rejects stale timestamps so a captured event can't be replayed later.
 */
function verifyWebhook(rawBody, header, secret = env('STRIPE_WEBHOOK_SECRET'), toleranceSec = 300) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')).filter(p => p.length === 2)
    .map(([k, v]) => [k, v]));
  const sigs = String(header || '').split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) throw new Error('Malformed Stripe-Signature');
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new Error('Stale webhook timestamp');

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const ok = sigs.some(s => s.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error('Bad webhook signature');
  return JSON.parse(rawBody);
}

// ─── Records ────────────────────────────────────────────────────────────────

async function get(ownerKey) {
  const { rows } = await pool.query('SELECT * FROM billing WHERE owner_key = $1', [ownerKey]);
  return rows[0] || null;
}

async function upsert(ownerKey, fields) {
  await pool.query(`
    INSERT INTO billing (owner_key, email, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (owner_key) DO UPDATE SET
      email                  = COALESCE(EXCLUDED.email, billing.email),
      stripe_customer_id     = COALESCE(EXCLUDED.stripe_customer_id, billing.stripe_customer_id),
      stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, billing.stripe_subscription_id),
      status                 = EXCLUDED.status,
      current_period_end     = COALESCE(EXCLUDED.current_period_end, billing.current_period_end),
      updated_at             = NOW()`,
    [ownerKey, fields.email || null, fields.customerId || null, fields.subscriptionId || null,
     fields.status, fields.periodEnd || null]);
}

/** Record a Stripe subscription object against the identity stamped in its metadata. */
async function applySubscription(sub, ownerKey = sub.metadata?.owner_key) {
  if (!ownerKey) return false;
  const end = sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
  await upsert(ownerKey, {
    customerId:     typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    subscriptionId: sub.id,
    status:         sub.status,
    periodEnd:      end ? new Date(end * 1000) : null,
  });
  return true;
}

// ─── Entitlement ────────────────────────────────────────────────────────────

/**
 * May this identity call tools? Exempt mailboxes count through linking: an
 * address can only be linked by completing Google consent for it, so owning a
 * link to an exempt address proves you are that person.
 */
async function isEntitled(ownerKey) {
  if (!enabled()) return true;

  const row = await get(ownerKey);
  if (row && ENTITLED.has(row.status)) return true;

  const exempt = exemptEmails();
  if (!exempt.length) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM gmail_accounts WHERE owner_key = $1 AND lower(email) = ANY($2) LIMIT 1',
    [ownerKey, exempt]);
  return rows.length > 0;
}

// ─── Checkout, portal, sync ─────────────────────────────────────────────────

async function checkoutUrl({ ownerKey, email, baseUrl }) {
  const existing = await get(ownerKey);
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: env('STRIPE_PRICE_ID'), quantity: 1 }],
    client_reference_id: ownerKey,
    ...(existing?.stripe_customer_id ? { customer: existing.stripe_customer_id } : { customer_email: email || undefined }),
    subscription_data: { metadata: { owner_key: ownerKey } },
    metadata: { owner_key: ownerKey },
    allow_promotion_codes: 'true',
    success_url: `${baseUrl}/billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${baseUrl}/billing`,
  });
  return session.url;
}

async function portalUrl({ ownerKey, baseUrl }) {
  const row = await get(ownerKey);
  if (!row?.stripe_customer_id) return null;
  const session = await stripe('POST', '/billing_portal/sessions', {
    customer: row.stripe_customer_id,
    return_url: `${baseUrl}/billing`,
  });
  return session.url;
}

/**
 * Pull a finished checkout straight from Stripe on the success redirect, so
 * access doesn't wait on the webhook. Only honoured when the checkout belongs
 * to the identity asking — a session id in a URL is not proof of anything.
 */
async function syncCheckout(sessionId, ownerKey) {
  const cs = await stripe('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`);
  if (cs.client_reference_id !== ownerKey || !cs.subscription || typeof cs.subscription !== 'object') return false;
  return applySubscription(cs.subscription, ownerKey);
}

/** Webhook dispatch. Unknown event types are acknowledged and ignored. */
async function handleEvent(event) {
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.subscription && obj.client_reference_id) {
        const sub = await stripe('GET', `/subscriptions/${encodeURIComponent(obj.subscription)}`);
        await applySubscription(sub, obj.client_reference_id);
      }
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(obj);
      break;
  }
}

/** Part of "delete everything": stop charging someone who has left. */
async function cancelAndForget(ownerKey) {
  const row = await get(ownerKey);
  if (row?.stripe_subscription_id && enabled() && !['canceled', 'comp'].includes(row.status)) {
    await stripe('DELETE', `/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`)
      .catch(err => console.error('[billing] cancel on delete failed:', err.message));
  }
  await pool.query('DELETE FROM billing WHERE owner_key = $1', [ownerKey]);
}

module.exports = {
  enabled, priceLabel, isEntitled, get,
  checkoutUrl, portalUrl, syncCheckout, handleEvent, verifyWebhook, cancelAndForget,
  _internal: { formEncode, applySubscription, ENTITLED },
};
