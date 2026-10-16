/**
 * SMTP relay for the Hub.
 *
 * Railway blocks outbound SMTP below its Pro plan, so the Hub hands each AOL
 * submission to this Worker over HTTPS and the Worker speaks SMTP to AOL.
 * It stores nothing and logs nothing: the app password lives only for the one
 * request, and only hosts the Hub has a preset for can be reached, so a leaked
 * token can't turn this into an open relay to anywhere.
 *
 *   POST /  Authorization: Bearer <RELAY_TOKEN>
 *   { host, port, user, pass, from, to: [..], raw }  ->  { ok: true } | { error, code }
 *
 * Deploy: cd smtp-relay && npx wrangler deploy && npx wrangler secret put RELAY_TOKEN
 */

import { connect } from 'cloudflare:sockets';

// Mirrors src/services/imap_providers.js — implicit TLS only.
const ALLOWED = new Set(['smtp.aol.com:465']);

const enc = new TextEncoder();
const dec = new TextDecoder();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sameSecret(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

const b64 = (s) => btoa(String.fromCharCode(...enc.encode(s)));

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    if (!env.RELAY_TOKEN || !sameSecret(req.headers.get('authorization') || '', `Bearer ${env.RELAY_TOKEN}`)) {
      return json({ error: 'unauthorized' }, 401);
    }

    // shortcut: the whole message is parsed as JSON, so a multi-MB attachment can hit the free plan's CPU cap; stream the body if that bites.
    let m;
    try { m = await req.json(); } catch { return json({ error: 'body is not JSON' }, 400); }
    const { host, port, user, pass, from, to, raw } = m;
    if (!ALLOWED.has(`${host}:${port}`)) return json({ error: `host not allowed: ${host}:${port}` }, 403);
    if (!user || !pass || !from || !Array.isArray(to) || !to.length || typeof raw !== 'string') {
      return json({ error: 'need user, pass, from, to[] and raw' }, 400);
    }

    try {
      await submit({ host, port, user, pass, from, to, raw });
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message, code: err.code ?? null }, 502);
    }
  },
};

async function submit({ host, port, user, pass, from, to, raw }) {
  const socket = connect({ hostname: host, port }, { secureTransport: 'on' });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let buf = '';

  // One reply: "250-..." continuation lines, then a final "250 ...".
  async function reply() {
    const lines = [];
    for (;;) {
      const nl = buf.indexOf('\r\n');
      if (nl < 0) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SMTP: the server closed the connection');
        buf += dec.decode(value, { stream: true });
        continue;
      }
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      lines.push(line);
      if (line[3] !== '-') return { code: Number(line.slice(0, 3)), text: lines.join(' | ') };
    }
  }

  // `step` names the command in errors, so the AUTH line (and its password) is never echoed.
  async function send(line, step, ok) {
    if (line !== null) await writer.write(enc.encode(line + '\r\n'));
    const r = await reply();
    if (!ok.includes(r.code)) throw Object.assign(new Error(`SMTP ${step}: ${r.text}`), { code: r.code });
  }

  try {
    await send(null, 'greeting', [220]);
    await send('EHLO hub.grounders.app', 'EHLO', [250]);
    await send(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, 'AUTH', [235]);
    await send(`MAIL FROM:<${from}>`, 'MAIL FROM', [250]);
    for (const rcpt of to) await send(`RCPT TO:<${rcpt}>`, `RCPT TO ${rcpt}`, [250, 251]);
    await send('DATA', 'DATA', [354]);
    const body = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');   // CRLF lines, dot-stuffed
    await writer.write(enc.encode(body + (body.endsWith('\r\n') ? '' : '\r\n') + '.\r\n'));
    await send(null, 'message', [250]);
    await writer.write(enc.encode('QUIT\r\n')).catch(() => {});
  } finally {
    await socket.close().catch(() => {});
  }
}
