/**
 * Billing: the paywall must be off without keys, closed without a
 * subscription, open with one, and the webhook must refuse anything Stripe
 * didn't sign. Postgres and Stripe are both stubbed — nothing leaves the box.
 *
 *   node test/billing.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const path   = require('path');

// ─── In-memory stand-in for the two tables billing reads ────────────────────

const db = { billing: new Map(), mailboxes: [] };
const poolPath = path.resolve(__dirname, '../src/db/pool.js');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: {
  async query(sql, params) {
    if (/FROM billing WHERE owner_key/.test(sql) && /^\s*SELECT/.test(sql)) {
      const row = db.billing.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (/INSERT INTO billing/.test(sql)) {
      const [owner_key, email, cust, sub, status, end] = params;
      const prev = db.billing.get(owner_key) || {};
      db.billing.set(owner_key, { owner_key, email: email ?? prev.email,
        stripe_customer_id: cust ?? prev.stripe_customer_id,
        stripe_subscription_id: sub ?? prev.stripe_subscription_id,
        status, current_period_end: end ?? prev.current_period_end });
      return { rows: [] };
    }
    if (/DELETE FROM billing/.test(sql)) { db.billing.delete(params[0]); return { rows: [] }; }
    if (/FROM gmail_accounts/.test(sql)) {
      const hit = db.mailboxes.some(m => m.owner === params[0] && params[1].includes(m.email.toLowerCase()));
      return { rows: hit ? [{ 1: 1 }] : [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  },
} };

// ─── Stripe stub: records requests, answers from a table ────────────────────

const calls = [];
const stripeAnswers = {};
global.fetch = async (url, init = {}) => {
  const u = new URL(url);
  assert.strictEqual(u.host, 'api.stripe.com', `unexpected host ${u.host}`);
  calls.push({ method: init.method, path: u.pathname, body: init.body ? new URLSearchParams(init.body) : null });
  const answer = stripeAnswers[`${init.method} ${u.pathname}`];
  return { ok: Boolean(answer), status: answer ? 200 : 404, json: async () => answer || { error: { message: 'no stub' } } };
};

const billing = require('../src/services/billing');

let failures = 0;
async function test(name, fn) {
  const saved = { ...process.env };
  try { await fn(); console.log(' ok  ', name); }
  catch (err) { failures++; console.log('FAIL ', name, '—', err.message); }
  finally { process.env = saved; db.billing.clear(); db.mailboxes = []; calls.length = 0; }
}
const on = () => Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' });

const sign = (body, secret = 'whsec_x', t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

(async () => {
  await test('without Stripe keys, everyone is entitled', async () => {
    delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_PRICE_ID;
    assert.strictEqual(await billing.isEntitled('google:1'), true);
  });

  await test('with keys and no subscription, access is refused', async () => {
    on();
    assert.strictEqual(await billing.isEntitled('google:1'), false);
  });

  await test('active, trialing, past_due and comp are entitled; canceled and unpaid are not', async () => {
    on();
    for (const [status, want] of [['active', true], ['trialing', true], ['past_due', true], ['comp', true],
                                   ['canceled', false], ['unpaid', false], ['incomplete', false]]) {
      db.billing.set('google:1', { owner_key: 'google:1', status });
      assert.strictEqual(await billing.isEntitled('google:1'), want, status);
    }
  });

  await test('owning a link to an exempt mailbox is entitled; someone else owning it is not', async () => {
    on(); process.env.BILLING_EXEMPT_EMAILS = 'Boss@Example.com, other@x.com';
    db.mailboxes = [{ owner: 'google:boss', email: 'boss@example.com' }];
    assert.strictEqual(await billing.isEntitled('google:boss'), true);
    assert.strictEqual(await billing.isEntitled('google:stranger'), false);
  });

  await test('checkout sends price, identity on both session and subscription, and success URL', async () => {
    on();
    stripeAnswers['POST /v1/checkout/sessions'] = { url: 'https://checkout.stripe.com/c/x' };
    const url = await billing.checkoutUrl({ ownerKey: 'google:1', email: 'a@b.c', baseUrl: 'https://mcp.example' });
    assert.strictEqual(url, 'https://checkout.stripe.com/c/x');
    const body = calls[0].body;
    assert.strictEqual(body.get('mode'), 'subscription');
    assert.strictEqual(body.get('line_items[0][price]'), 'price_x');
    assert.strictEqual(body.get('client_reference_id'), 'google:1');
    assert.strictEqual(body.get('subscription_data[metadata][owner_key]'), 'google:1');
    assert.strictEqual(body.get('customer_email'), 'a@b.c');
    assert.strictEqual(body.get('success_url'), 'https://mcp.example/billing?session_id={CHECKOUT_SESSION_ID}');
  });

  await test('webhook: a valid signature parses; tampered, wrong-secret and stale ones throw', async () => {
    on();
    const body = JSON.stringify({ type: 'ping' });
    assert.deepStrictEqual(billing.verifyWebhook(body, sign(body)), { type: 'ping' });
    assert.throws(() => billing.verifyWebhook(body + ' ', sign(body)), /signature/);
    assert.throws(() => billing.verifyWebhook(body, sign(body, 'whsec_other')), /signature/);
    assert.throws(() => billing.verifyWebhook(body, sign(body, 'whsec_x', 1000)), /Stale/);
    assert.throws(() => billing.verifyWebhook(body, ''), /Malformed/);
  });

  await test('subscription events update the identity in their metadata, and cancellation ends access', async () => {
    on();
    const sub = (status) => ({ type: 'customer.subscription.updated', data: { object: {
      id: 'sub_1', customer: 'cus_1', status, current_period_end: 1900000000, metadata: { owner_key: 'google:1' } } } });
    await billing.handleEvent(sub('active'));
    assert.strictEqual(await billing.isEntitled('google:1'), true);
    assert.strictEqual(db.billing.get('google:1').stripe_customer_id, 'cus_1');
    await billing.handleEvent({ ...sub('canceled'), type: 'customer.subscription.deleted' });
    assert.strictEqual(await billing.isEntitled('google:1'), false);
  });

  await test('a checkout belonging to someone else is not applied on the success redirect', async () => {
    on();
    stripeAnswers['GET /v1/checkout/sessions/cs_1'] = { client_reference_id: 'google:other',
      subscription: { id: 'sub_9', customer: 'cus_9', status: 'active', metadata: {} } };
    assert.strictEqual(await billing.syncCheckout('cs_1', 'google:1'), false);
    assert.strictEqual(await billing.isEntitled('google:1'), false);
  });

  await test('delete-everything cancels a live subscription at Stripe and forgets the row', async () => {
    on();
    db.billing.set('google:1', { owner_key: 'google:1', status: 'active', stripe_subscription_id: 'sub_1' });
    stripeAnswers['DELETE /v1/subscriptions/sub_1'] = { id: 'sub_1', status: 'canceled' };
    await billing.cancelAndForget('google:1');
    assert.deepStrictEqual(calls.map(c => `${c.method} ${c.path}`), ['DELETE /v1/subscriptions/sub_1']);
    assert.strictEqual(db.billing.has('google:1'), false);
  });

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
