/**
 * AI-to-AI messages, end to end against an in-memory Postgres (pg-mem).
 *   npm run test:ai
 *
 * Covers what the email bridge got wrong: answers land in the right thread,
 * the recipient is woken (or the sender is told it wasn't), a bot without MCP
 * can answer through its reply link, hops stop runaways, and one owner can't
 * see another's threads.
 */

process.env.JWT_SECRET      = process.env.JWT_SECRET      || 'test-jwt-secret';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://test.example.com';
process.env.DATABASE_URL    = process.env.DATABASE_URL    || 'postgresql://user:pw@127.0.0.1:5432/none';
process.env.TOKEN_ENC_KEY   = process.env.TOKEN_ENC_KEY   || 'a'.repeat(64);

let fail = 0;
const check = (name, cond, extra = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + String(extra).slice(0, 160) : ''}`);
};
const rejects = async (fn, re) => {
  try { await fn(); return false; } catch (err) { return re.test(err.message) || err.message; }
};

const { newDb } = require('pg-mem');
const mem  = newDb();
const pool = require('../src/db/pool');
const { Pool } = mem.adapters.createPg();
const memPool = new Pool();
pool.query = (...args) => memPool.query(...args);

// Mail goes to a list, not to Gmail.
const shared = require('../src/mcp/shared');
const mailed = [];
shared.mailFor = async (ownerKey, account) => {
  if (account && account !== 'me@gmail.com') throw new Error(`"${account}" is not linked`);
  return { email: 'me@gmail.com', api: { sendMessage: async (_h, m) => { mailed.push(m); return { id: 'x' }; } }, handle: null };
};

// Webhooks go to a list too; the real fetch stays for calling our own server.
const realFetch = global.fetch;
const hooked = [];
global.fetch = async (url, init) => {
  if (String(url).startsWith('https://hooks.example.com')) {
    hooked.push({ url, init });
    return { ok: !String(url).includes('broken'), status: String(url).includes('broken') ? 500 : 200 };
  }
  return realFetch(url, init);
};

const bus   = require('../src/services/ai_bus');
const tools = require('../src/mcp/tools');
const ME = 'google:me', OTHER = 'google:other';
const call = async (name, args, owner = ME) => JSON.parse((await tools.callTool(name, args, owner)).content[0].text);

(async () => {
  await pool.query(require('../src/db/migrate').AI_SCHEMA);

  // ─── Plain send and inbox ───────────────────────────────────────────────
  const first = await call('ai_send', { to: 'Lute', text: 'Post the reel at 5:45?' });
  check('a new message starts its own thread at hop 1', first.thread === first.id && first.hop === 1, JSON.stringify(first));
  check('names are lower-cased', first.to === 'lute');
  check('no wake set: the sender is told', /none set/.test(first.wake), first.wake);

  const box1 = await call('ai_inbox', { agent: 'lute' });
  check('inbox returns it', box1.count === 1 && box1.messages[0].text === 'Post the reel at 5:45?');
  check('reading marks it read', (await call('ai_inbox', { agent: 'lute' })).count === 0);
  check('the thread shows when it was read', (await call('ai_thread', { thread: first.thread })).messages[0].read_at);

  // ─── Email wake + reply link ────────────────────────────────────────────
  check('email wake from an unlinked mailbox is refused at setup',
    await rejects(() => call('ai_set_agent', { name: 'lute', email: { to: 'lute+claude@mail.grokbot.com', from_account: 'nope@x.com' } }), /not linked/));

  const set = await call('ai_set_agent', { name: 'lute', about: 'Grok bot: scheduling and relays',
    email: { to: 'lute+claude@mail.grokbot.com', subject: 'Claude -> Lute (hop {hop})' } });
  check('email wake is saved without secrets shown', /email from me@gmail.com to lute\+claude@mail.grokbot.com/.test(set.wake), set.wake);

  const second = await call('ai_send', { to: 'lute', text: 'Reel is final, v3.' });
  const mail = mailed.at(-1);
  check('the recipient is woken by email', /woke lute by email/.test(second.wake), second.wake);
  check('subject is filled exactly', mail?.subject === 'Claude -> Lute (hop 1)', mail?.subject);
  const body = JSON.parse(mail.body);
  check('the email body is one JSON object with a reply link',
    body.from === 'claude' && body.thread === second.thread && body.reply_url.startsWith('https://test.example.com/ai/k/'));

  // Lute answers through its link, over real HTTP.
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/ai', require('../src/routes/ai'));
  const server = app.listen(0);
  const local = (u) => u.replace('https://test.example.com', `http://127.0.0.1:${server.address().port}`);

  const got = await (await realFetch(local(body.reply_url))).json();
  check('GET on the link shows the thread and marks it read for lute',
    got.you === 'lute' && got.messages.length === 1 && got.messages[0].read_at, JSON.stringify(got).slice(0, 160));

  const posted = await realFetch(local(body.reply_url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Scheduled for 5:45.' }) });
  const reply = await posted.json();
  check('POST on the link answers in the same thread, to claude, at hop 2',
    posted.status === 201 && reply.thread === second.thread && reply.to === 'claude' && reply.hop === 2, JSON.stringify(reply));

  const plain = await realFetch(local(body.reply_url), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'Also plain text works.' });
  check('a plain-text POST is accepted', plain.status === 201);

  const fresh = await realFetch(local(body.reply_url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_thread: true, to: 'claude', text: 'New topic.' }) });
  const freshJson = await fresh.json();
  check('the link can open a new thread', fresh.status === 201 && freshJson.thread !== second.thread && freshJson.hop === 1);

  const forged = await realFetch(local(body.reply_url.slice(0, -3) + 'abc'));
  check('a tampered link is refused', forged.status === 401);

  // ─── Waiting for a reply ────────────────────────────────────────────────
  const mine = await call('ai_inbox', {});
  check('claude\'s inbox has the three messages, oldest first',
    mine.count === 3 && mine.messages[0].text === 'Scheduled for 5:45.', JSON.stringify(mine.messages.map(m => m.text)));

  const t0 = Date.now();
  const waiting = call('ai_inbox', { wait_seconds: 5 });
  setTimeout(() => bus.send(ME, { from: 'marketing', to: 'claude', text: 'QA passed.' }), 1200);
  const waited = await waiting;
  check('wait_seconds holds until a message arrives', waited.count === 1 && Date.now() - t0 < 4000, `${Date.now() - t0} ms`);

  // ─── Webhook wake, and a failed wake keeps the message ──────────────────
  await call('ai_set_agent', { name: 'helper', webhook: { url: 'https://hooks.example.com/fire', headers: { Authorization: 'Bearer s3cret' } } });
  const hookSend = await call('ai_send', { to: 'helper', text: 'Ping' });
  const hook = hooked.at(-1);
  check('webhook wake posts {text} with the headers', /woke helper by webhook/.test(hookSend.wake)
    && hook.init.headers.Authorization === 'Bearer s3cret' && /Ping/.test(JSON.parse(hook.init.body).text));
  check('the webhook secret is not shown back', !JSON.stringify(await call('ai_agents', {})).includes('s3cret'));

  await call('ai_set_agent', { name: 'helper', webhook: { url: 'https://hooks.example.com/broken' } });
  const lost = await call('ai_send', { to: 'helper', text: 'Still there?' });
  check('a failed wake says so', /could not wake helper/.test(lost.wake), lost.wake);
  const kept = await call('ai_inbox', { agent: 'helper', peek: true });
  check('...and the message waits in the inbox with the error', kept.messages.some(m => m.text === 'Still there?' && m.wake_error));
  check('webhooks cannot reach private hosts', await rejects(() => call('ai_set_agent', { name: 'helper', webhook: { url: 'https://10.0.0.5/x' } }), /public host/)
    && await rejects(() => call('ai_set_agent', { name: 'helper', webhook: { url: 'https://db.railway.internal/x' } }), /public host/));
  check('webhooks must be https', await rejects(() => call('ai_set_agent', { name: 'helper', webhook: { url: 'http://x.com' } }), /https/));

  // ─── Agents list ────────────────────────────────────────────────────────
  const list = await call('ai_agents', {});
  const lute = list.agents.find(a => a.name === 'lute');
  const helper = list.agents.find(a => a.name === 'helper');
  check('agents list shows about, wake and unread counts',
    lute?.about === 'Grok bot: scheduling and relays' && lute.unread === 0 && helper?.unread === 2, JSON.stringify(list).slice(0, 300));

  // ─── Hop guard ──────────────────────────────────────────────────────────
  const loop = await call('ai_send', { to: 'marketing', text: 'hop 1' });
  for (let hop = 2; hop <= bus.MAX_HOPS; hop++) {
    await bus.send(ME, { from: hop % 2 ? 'claude' : 'marketing', text: `hop ${hop}`, thread: loop.thread });
  }
  check(`hop ${bus.MAX_HOPS + 1} is refused`,
    await rejects(() => call('ai_send', { thread: loop.thread, text: 'one more' }), /reached hop/));

  // ─── Isolation and input checks ─────────────────────────────────────────
  check('another owner cannot read the thread', await rejects(() => call('ai_thread', { thread: first.thread }, OTHER), /No thread/));
  check('another owner cannot answer in it', await rejects(() => call('ai_send', { thread: first.thread, text: 'hi' }, OTHER), /No thread/));
  check('another owner\'s inbox is empty', (await call('ai_inbox', { agent: 'lute', peek: true }, OTHER)).count === 0);
  check('messaging yourself is refused', await rejects(() => call('ai_send', { to: 'claude', text: 'x' }), /itself/));
  check('a bad name is refused', await rejects(() => call('ai_send', { to: 'Lute Bot!', text: 'x' }), /must be/));
  check('empty text is refused', await rejects(() => call('ai_send', { to: 'lute', text: '  ' }), /text is required/));

  server.close();
  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
