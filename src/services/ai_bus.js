/**
 * AI-to-AI messages: an inbox per agent, kept in threads.
 *
 * Bots talking by email lost messages to subject matching and "Re:" threads,
 * and nobody could tell whether a message had been read. Here every message
 * has a thread, a hop count and a read time, and the sender learns at once
 * whether the recipient was woken.
 *
 * Agents are plain names under one owner ("claude", "lute"). Claude reaches
 * the bus through the MCP tools. An agent without MCP is woken by email or
 * webhook, and each wake carries a signed reply link it answers with one
 * HTTP POST — no account, no stored secret on its side.
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const pool   = require('../db/pool');
const box    = require('./crypto_box');
const shared = require('../mcp/shared');

const MAX_HOPS   = 10;      // runaway guard: two bots acknowledging each other forever
const MAX_TEXT   = 20000;
const LINK_TTL   = '30d';
const POLL_MS    = 1000;
const MAX_WAIT_S = 50;      // under the usual 60 s client timeout for a tool call
const NAME       = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** An Error the HTTP layer shows as a 400 with its message. */
const bad = (message) => Object.assign(new Error(message), { status: 400 });

function agentName(raw, field = 'agent') {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!NAME.test(name)) throw bad(`${field} must be 1-40 characters: a-z, 0-9, ".", "_" or "-" (got "${raw ?? ''}")`);
  return name;
}

const baseUrl = () => require('./mcp_oauth').baseUrl();

// ─── Reply links ────────────────────────────────────────────────────────────

/** Own HMAC label, so a reply link can never pass as an MCP token or a session. */
function linkSecret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set');
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update('hub-ai-reply-link-v1').digest('base64');
}

/** A URL that lets `agent` read and answer `thread` (and open new threads) as itself, for 30 days. */
function replyLink(ownerKey, agent, thread) {
  const token = jwt.sign({ o: ownerKey, a: agent, t: thread }, linkSecret(), { algorithm: 'HS256', expiresIn: LINK_TTL });
  return `${baseUrl()}/ai/k/${token}`;
}

function readLink(token) {
  const p = jwt.verify(token, linkSecret(), { algorithms: ['HS256'] });
  return { ownerKey: p.o, agent: p.a, thread: p.t };
}

const HOW_TO_REPLY =
  'POST JSON {"text":"your reply"} to reply_url (Content-Type: application/json). It is delivered at once; ' +
  'no email needed. GET reply_url shows the whole thread. To start a new conversation, POST ' +
  '{"new_thread":true,"to":"<agent>","text":"..."}.';

// ─── Messages ───────────────────────────────────────────────────────────────

const view = (r) => ({
  id: Number(r.id), thread: Number(r.thread_id ?? r.id), hop: r.hop,
  from: r.from_agent, to: r.to_agent, text: r.body,
  sent_at: r.created_at, read_at: r.read_at || null,
  ...(r.wake_error ? { wake_error: r.wake_error } : {}),
});

/**
 * Send one message. With `thread` it answers there: the hop goes up by one and
 * `to` defaults to whoever spoke last that isn't the sender.
 */
async function send(ownerKey, { from, to, text, thread }) {
  from = agentName(from, 'from');
  text = String(text ?? '').trim();
  if (!text) throw bad('text is required');
  if (text.length > MAX_TEXT) throw bad(`text is over ${MAX_TEXT} characters — send a link to a file instead`);

  let hop = 1;
  if (thread != null) {
    thread = Number(thread);
    const { rows } = await pool.query(
      'SELECT from_agent, to_agent, hop FROM ai_messages WHERE owner_key = $1 AND thread_id = $2 ORDER BY id DESC',
      [ownerKey, thread]);
    if (!rows.length) throw bad(`No thread ${thread}`);
    hop = Math.max(...rows.map(r => r.hop)) + 1;
    if (to == null || to === '') to = rows[0].from_agent !== from ? rows[0].from_agent : rows[0].to_agent;
  }
  to = agentName(to, 'to');
  if (to === from) throw bad('An agent cannot message itself');
  if (hop > MAX_HOPS) {
    throw bad(`Thread ${thread} has reached hop ${MAX_HOPS} — stop here. Start a new thread only if a person asked for more.`);
  }

  const { rows: [row] } = await pool.query(
    `INSERT INTO ai_messages (owner_key, thread_id, from_agent, to_agent, body, hop)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ownerKey, thread ?? null, from, to, text, hop]);
  if (thread == null) {
    await pool.query('UPDATE ai_messages SET thread_id = id WHERE id = $1', [row.id]);
    row.thread_id = row.id;
  }

  const msg = view(row);
  return { sent: true, id: msg.id, thread: msg.thread, hop, from, to, wake: await wake(ownerKey, msg) };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Unread messages for `agent`, oldest first, marked read as they are returned
 * (unless peek). With waitSeconds the call holds until one arrives.
 */
async function inbox(ownerKey, { agent, waitSeconds = 0, peek = false, limit = 20 }) {
  agent = agentName(agent);
  const n        = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const deadline = Date.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_S) * 1000;
  const unread   = `SELECT id FROM ai_messages WHERE owner_key = $1 AND to_agent = $2 AND read_at IS NULL ORDER BY id LIMIT ${n}`;

  for (;;) {
    const { rows } = peek
      ? await pool.query(`SELECT * FROM ai_messages WHERE id IN (${unread})`, [ownerKey, agent])
      : await pool.query(`UPDATE ai_messages SET read_at = NOW() WHERE id IN (${unread}) RETURNING *`, [ownerKey, agent]);
    if (rows.length || Date.now() >= deadline) {
      return { agent, count: rows.length, messages: rows.map(view).sort((a, b) => a.id - b.id) };
    }
    await sleep(POLL_MS);
  }
}

/** A whole thread, oldest first. markReadFor marks what was sent to that agent as read. */
async function thread(ownerKey, threadId, { markReadFor } = {}) {
  threadId = Number(threadId);
  if (!Number.isInteger(threadId)) throw bad('thread must be a number');
  if (markReadFor) {
    await pool.query(
      'UPDATE ai_messages SET read_at = NOW() WHERE owner_key = $1 AND thread_id = $2 AND to_agent = $3 AND read_at IS NULL',
      [ownerKey, threadId, markReadFor]);
  }
  const { rows } = await pool.query(
    'SELECT * FROM ai_messages WHERE owner_key = $1 AND thread_id = $2 ORDER BY id', [ownerKey, threadId]);
  if (!rows.length) throw bad(`No thread ${threadId}`);
  return { thread: threadId, max_hops: MAX_HOPS, messages: rows.map(view) };
}

// ─── Agents and waking them ─────────────────────────────────────────────────

async function wakeFor(ownerKey, name) {
  const { rows } = await pool.query('SELECT wake_enc FROM ai_agents WHERE owner_key = $1 AND name = $2', [ownerKey, name]);
  return rows[0]?.wake_enc ? JSON.parse(box.decrypt(rows[0].wake_enc)) : null;
}

/** What a wake does, without the secrets in it. */
function describeWake(w) {
  if (!w) return 'none — reads its inbox itself';
  if (w.email) return `email from ${w.email.from_account} to ${w.email.to}, subject "${w.email.subject}"`;
  return `webhook POST to ${new URL(w.webhook.url).host}`;
}

/** Every agent that is configured or has messages, with its unread count. */
async function agents(ownerKey) {
  const [{ rows: configured }, { rows: traffic }] = await Promise.all([
    pool.query('SELECT name, about, wake_enc FROM ai_agents WHERE owner_key = $1', [ownerKey]),
    pool.query(
      `SELECT to_agent AS name, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread, MAX(created_at) AS last_message
       FROM ai_messages WHERE owner_key = $1 GROUP BY to_agent`, [ownerKey]),
  ]);

  const byName = new Map();
  for (const a of configured) {
    byName.set(a.name, { name: a.name, about: a.about || null,
      wake: describeWake(a.wake_enc ? JSON.parse(box.decrypt(a.wake_enc)) : null), unread: 0 });
  }
  for (const t of traffic) {
    const a = byName.get(t.name) || { name: t.name, about: null, wake: describeWake(null) };
    byName.set(t.name, { ...a, unread: Number(t.unread), last_message_to_it: t.last_message });
  }
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Describe an agent and how to wake it. Omitted fields keep their value;
 * clear_wake removes the wake. An email wake is checked against the linked
 * mailboxes now, so a typo fails here rather than at the first message.
 */
async function setAgent(ownerKey, { name, about, email, webhook, clear_wake: clear }) {
  name = agentName(name, 'name');
  if (email && webhook) throw bad('Give an email wake or a webhook wake, not both');

  const { rows } = await pool.query('SELECT about, wake_enc FROM ai_agents WHERE owner_key = $1 AND name = $2', [ownerKey, name]);
  let wakeEnc = clear ? null : rows[0]?.wake_enc ?? null;

  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.to || '')) throw bad('email.to must be an email address');
    const sender = await shared.mailFor(ownerKey, email.from_account);
    wakeEnc = box.encrypt(JSON.stringify({ email: {
      to: email.to.trim(), from_account: sender.email,
      subject: email.subject || '{From} -> {To} (hop {hop})',
    } }));
  }
  if (webhook) {
    let url;
    try { url = new URL(webhook.url); } catch { throw bad('webhook.url must be a URL'); }
    if (url.protocol !== 'https:') throw bad('webhook.url must be https');
    // Hub is shared: one user's webhook must not reach into the host's own network.
    if (/^(localhost|\[|127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|\.(internal|local|localhost)$/i.test(url.hostname)) {
      throw bad('webhook.url must be a public host');
    }
    wakeEnc = box.encrypt(JSON.stringify({ webhook: { url: url.toString(), headers: webhook.headers || {} } }));
  }

  about = about === undefined ? rows[0]?.about ?? null : String(about).slice(0, 500);
  await pool.query(
    `INSERT INTO ai_agents (owner_key, name, about, wake_enc) VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_key, name) DO UPDATE SET about = $3, wake_enc = $4, updated_at = NOW()`,
    [ownerKey, name, about, wakeEnc]);

  return { name, about, wake: describeWake(wakeEnc ? JSON.parse(box.decrypt(wakeEnc)) : null) };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "{From} -> {To} (hop {hop})" → "Claude -> Lute (hop 3)". */
const fillSubject = (tpl, m) => tpl
  .replace(/\{from\}/g, m.from).replace(/\{to\}/g, m.to)
  .replace(/\{From\}/g, cap(m.from)).replace(/\{To\}/g, cap(m.to))
  .replace(/\{hop\}/g, m.hop).replace(/\{thread\}/g, m.thread);

/**
 * Wake the recipient, if it has a wake. A failed wake never loses the message:
 * it stays unread in the inbox and the failure is recorded on it and returned.
 */
async function wake(ownerKey, msg) {
  let w;
  try {
    w = await wakeFor(ownerKey, msg.to);
    if (!w) return `none set — ${msg.to} sees it when it checks its inbox`;

    const reply_url = replyLink(ownerKey, msg.to, msg.thread);
    if (w.email) {
      const { email, api, handle } = await shared.mailFor(ownerKey, w.email.from_account);
      // One JSON object as the body: the shape the Grok bots already parse.
      await api.sendMessage(handle, {
        from: email, to: w.email.to, subject: fillSubject(w.email.subject, msg),
        body: JSON.stringify({ from: msg.from, to: msg.to, hop: msg.hop, thread: msg.thread, text: msg.text,
          reply_url, how_to_reply: HOW_TO_REPLY }),
      });
      return `woke ${msg.to} by email to ${w.email.to}`;
    }

    const res = await fetch(w.webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...w.webhook.headers },
      body: JSON.stringify({ text:
        `[Hub] ${msg.from} -> ${msg.to}, thread ${msg.thread}, hop ${msg.hop}:\n\n${msg.text}\n\n` +
        `Reply with the Hub tool ai_send (thread ${msg.thread}), or POST {"text":"..."} to ${reply_url}` }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
    return `woke ${msg.to} by webhook`;
  } catch (err) {
    await pool.query('UPDATE ai_messages SET wake_error = $2 WHERE id = $1', [msg.id, String(err.message).slice(0, 500)])
      .catch(() => {});
    return `could not wake ${msg.to}: ${err.message} — the message waits unread in its inbox`;
  }
}

module.exports = { send, inbox, thread, agents, setAgent, replyLink, readLink, HOW_TO_REPLY, MAX_HOPS };
