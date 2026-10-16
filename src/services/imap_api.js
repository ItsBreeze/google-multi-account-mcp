/**
 * IMAP + SMTP mail client — the AOL counterpart of gmail_api.
 *
 * It exports the same functions with the same result shapes, so the mail
 * tools call either one identically. Where gmail_api takes an access token,
 * these take a credential handle: { email, password, provider }.
 *
 * Three things differ from Gmail and are handled here rather than leaked:
 *
 *   Folders, not labels. A message lives in exactly one folder. Gmail label
 *   changes are mapped onto folder moves and flags (UNREAD ↔ \Seen,
 *   STARRED ↔ \Flagged, INBOX/SPAM/TRASH ↔ those folders), and a change that
 *   would need a message in two folders at once is refused.
 *
 *   Ids move. An IMAP id is folder + UID, so moving a message gives it a new
 *   one. Every call that moves returns the new id rather than leaving the old
 *   one to fail later.
 *
 *   Deletion is a code guarantee, not a scope. Gmail's grant cannot delete
 *   permanently; an app password can do anything. So the only expunge in this
 *   file is removeDraft, which checks it is in the Drafts folder and requires
 *   UID EXPUNGE so it cannot take any other message with it. Folder moves
 *   refuse servers that would emulate MOVE with a mailbox-wide EXPUNGE, and a
 *   folder that still holds mail cannot be deleted.
 */

const crypto           = require('crypto');
const { ImapFlow }     = require('imapflow');
const nodemailer       = require('nodemailer');
const { simpleParser } = require('mailparser');

const providers  = require('./imap_providers');
const imapQuery  = require('./imap_query');
const gmail      = require('./gmail_api');

const { buildRawMime, htmlToText, parseAddresses, addressOf, truncateBody } = gmail;

const SNIPPET_CHARS        = 200;
const MAX_ATTACHMENT_SCAN  = 200;   // has:attachment candidates examined per folder per page
const MAX_FORWARD_ATTACHMENT_BYTES = 10 * 1024 * 1024;
let   SENT_COPY_WAITS_MS   = [0, 1500, 3000];

// Swappable for the test suite, which drives a scripted mailbox instead of a server.
let makeImap = (options) => new ImapFlow(options);
// Railway blocks outbound SMTP below Pro, so there the submission goes over HTTPS to smtp-relay/, which speaks SMTP to AOL.
let makeSmtp = (options) => process.env.SMTP_RELAY_URL ? relayTransport(options) : nodemailer.createTransport(options);

/** The slice of a nodemailer transport that deliver() uses, carried by smtp-relay/. */
function relayTransport({ host, port, auth }) {
  return {
    async sendMail({ envelope, raw }) {
      const res = await fetch(process.env.SMTP_RELAY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SMTP_RELAY_TOKEN}` },
        body: JSON.stringify({ host, port, user: auth.user, pass: auth.pass, from: envelope.from, to: envelope.to, raw: String(raw) }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) return { messageId: null };
      const { error, code } = await res.json().catch(() => ({}));
      throw Object.assign(new Error(error || `SMTP relay answered HTTP ${res.status}`), { responseCode: code });
    },
    close() {},
  };
}

// ─── Connections ────────────────────────────────────────────────────────────

function imapOptions(cred) {
  const { imap } = providers.preset(cred.provider);
  return {
    ...imap,
    auth: { user: cred.email, pass: cred.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  };
}

function smtpOptions(cred) {
  const { smtp } = providers.preset(cred.provider);
  return {
    ...smtp,
    auth: { user: cred.email, pass: cred.password },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  };
}

/** A sign-in failure says what to do about it; anything else passes through. */
function friendly(err, cred) {
  const { name, appPasswordUrl } = providers.preset(cred.provider);
  const authFailed = err?.authenticationFailed || err?.code === 'EAUTH' || err?.responseCode === 535;
  if (authFailed) {
    return new Error(
      `${name} refused the app password for ${cred.email}. It may have been deleted or mistyped — ` +
      `generate a new one at ${appPasswordUrl} and link the mailbox again.`,
    );
  }
  return new Error(`${name} (${cred.email}): ${err?.message || err}`);
}

async function connect(cred) {
  const client = makeImap(imapOptions(cred));
  // ImapFlow is an EventEmitter: an 'error' with no listener would take the
  // whole process down for one dropped socket.
  client.on?.('error', () => {});
  try {
    await client.connect();
  } catch (err) {
    throw friendly(err, cred);
  }
  return client;
}

async function disconnect(client) {
  try { await client.logout(); } catch { try { client.close(); } catch { /* already closed */ } }
}

/**
 * Signed-in connections kept briefly between calls.
 *
 * AOL answers each IMAP command in about 0.4 s, and signing in takes four of
 * them, so a fresh connection per tool call cost ~2 s before any work. A
 * conversation makes several calls in a row — search, read, draft — so an
 * idle connection is kept for a minute and handed to the next call for the
 * same mailbox. One caller per connection at a time; a concurrent call opens
 * its own. The key includes a hash of the password, so a re-linked mailbox
 * never reuses a connection signed in with the old one.
 */
const IDLE_MS = 60 * 1000;
const idle = new Map();   // key → [{ client, timer }]

const poolKey = (cred) =>
  `${cred.provider}|${cred.email}|${crypto.createHash('sha256').update(String(cred.password)).digest('hex')}`;

async function acquire(cred) {
  const key = poolKey(cred);
  const spare = idle.get(key) || [];
  while (spare.length) {
    const { client, timer } = spare.pop();
    clearTimeout(timer);
    if (client.usable !== false) return client;
    disconnect(client);
  }
  return connect(cred);
}

function release(cred, client, broken) {
  if (broken || client.usable === false) { disconnect(client); return; }
  const key = poolKey(cred);
  const spare = idle.get(key) || [];
  if (spare.length >= 2) { disconnect(client); return; }
  const timer = setTimeout(() => {
    const list = idle.get(key) || [];
    const i = list.findIndex(e => e.client === client);
    if (i !== -1) list.splice(i, 1);
    if (!list.length) idle.delete(key);
    disconnect(client);
  }, IDLE_MS);
  timer.unref?.();
  spare.push({ client, timer });
  idle.set(key, spare);
}

async function withImap(cred, fn) {
  const client = await acquire(cred);
  let broken = false;
  try {
    return await fn(client);
  } catch (err) {
    // A command the server refused leaves the connection usable; a dropped
    // socket does not. Only keep it if imapflow still says it is fine.
    broken = client.usable === false;
    throw err;
  } finally {
    release(cred, client, broken);
  }
}

/** Sign in over IMAP — run before a mailbox is stored, so a bad password never is. */
async function verify(cred) {
  // IMAP only: one app password covers IMAP and SMTP, and Railway blocks outbound SMTP below Pro, so an SMTP check here made linking time out.
  await disconnect(await connect(cred));
}

// ─── Folders ────────────────────────────────────────────────────────────────

const SPECIAL_LABELS = {
  '\\Inbox': 'INBOX', '\\Sent': 'SENT', '\\Drafts': 'DRAFT', '\\Trash': 'TRASH', '\\Junk': 'SPAM',
};
const LABEL_SPECIALS = Object.fromEntries(Object.entries(SPECIAL_LABELS).map(([k, v]) => [v, k]));
const SPECIAL_NAMES  = { '\\Inbox': 'Inbox', '\\Sent': 'Sent', '\\Drafts': 'Drafts', '\\Trash': 'Trash', '\\Junk': 'Spam', '\\Archive': 'Archive' };

async function folders(client) {
  const listed = await client.list();
  const list   = listed.filter(f => !f.flags?.has('\\Noselect') && !f.flags?.has('\\NonExistent'));

  const special = {};
  for (const f of list) {
    if (f.specialUse && !special[f.specialUse]) special[f.specialUse] = f.path;
  }
  if (!special['\\Inbox']) special['\\Inbox'] = list.find(f => f.path.toUpperCase() === 'INBOX')?.path || 'INBOX';

  const specialOf = Object.fromEntries(Object.entries(special).map(([k, v]) => [v, k]));
  const delimiter = list.find(f => f.delimiter)?.delimiter || '/';
  return { list, special, specialOf, delimiter };
}

function requireSpecial(f, use) {
  const path = f.special[use];
  if (!path) throw new Error(`This mailbox has no ${SPECIAL_NAMES[use] || use} folder.`);
  return path;
}

/** A folder named the way Gmail names labels: "Work/Receipts", case-insensitive. */
function folderByName(f, name) {
  const wanted = String(name).toLowerCase();
  const asPath = String(name).split('/').join(f.delimiter).toLowerCase();
  return f.list.filter(x =>
    x.path.toLowerCase() === wanted || x.path.toLowerCase() === asPath || x.name.toLowerCase() === wanted);
}

function resolveSelector(f, selector) {
  if (selector === 'anywhere') return f.list.map(x => x.path);
  if (selector.special) return [requireSpecial(f, selector.special)];
  const hits = folderByName(f, selector.name);
  if (!hits.length) {
    throw new Error(`No folder named "${selector.name}". Folders: ${f.list.map(x => x.path).join(', ')}`);
  }
  return hits.map(x => x.path);
}

/**
 * Which folders a search covers. Gmail searches all mail except spam and
 * trash, so the default here is every folder except those, drafts, and the
 * virtual ones that would repeat messages found elsewhere.
 */
function searchScope(f, { include, exclude }) {
  const skip = new Set(['\\Trash', '\\Junk', '\\Drafts', '\\All', '\\Flagged'].map(u => f.special[u]).filter(Boolean));
  let paths = include.length
    ? [...new Set(include.flatMap(s => resolveSelector(f, s)))]
    : f.list.map(x => x.path).filter(p => !skip.has(p));
  const excluded = new Set(exclude.flatMap(s => resolveSelector(f, s)));
  paths = paths.filter(p => !excluded.has(p));
  return paths;
}

function labelsFor(f, path, flags) {
  const use = f.specialOf[path];
  return [
    SPECIAL_LABELS[use] || path,
    ...(flags && !flags.has('\\Seen') ? ['UNREAD'] : []),
    ...(flags?.has('\\Flagged') ? ['STARRED'] : []),
  ];
}

// ─── Ids ────────────────────────────────────────────────────────────────────

// Opaque to the caller: folder, UIDVALIDITY and UID. UIDVALIDITY changes only
// when the server renumbers a folder, and then every old UID is meaningless —
// checking it turns a silent wrong-message read into "search again".
const encodeId = (path, uidValidity, uid) =>
  `a1.${Buffer.from(JSON.stringify([path, String(uidValidity), uid]), 'utf8').toString('base64url')}`;

function decodeId(id) {
  const bad = () => new Error(
    `"${id}" is not a message id from this mailbox — use an id from search_messages, get_thread or list_drafts.`);
  if (typeof id !== 'string' || !id.startsWith('a1.')) throw bad();
  try {
    const [path, uidValidity, uid] = JSON.parse(Buffer.from(id.slice(3), 'base64url').toString('utf8'));
    if (typeof path !== 'string' || !Number.isInteger(uid)) throw bad();
    return { path, uidValidity, uid };
  } catch {
    throw bad();
  }
}

/**
 * A thread id carries two names for the conversation:
 *
 *   t — the server's own THREADID, where it has OBJECTID (RFC 8474). AOL does,
 *       and gives a reply in Sent the same one as its original in the inbox.
 *   r — the root Message-ID: first of References, else In-Reply-To, else the
 *       message's own. The RFC 5322 chain, for servers without THREADID.
 *
 * Either can be missing; a message with neither has no thread.
 */
function encodeThread({ threadId, root }) {
  if (!threadId && !root) return null;
  return `t2.${Buffer.from(JSON.stringify({ t: threadId || null, r: root || null }), 'utf8').toString('base64url')}`;
}

function decodeThread(id) {
  const bad = () => new Error(`"${id}" is not a thread id from this mailbox — use one from search_messages or search_threads.`);
  if (typeof id !== 'string' || !id.startsWith('t2.')) throw bad();
  try {
    const { t, r } = JSON.parse(Buffer.from(id.slice(3), 'base64url').toString('utf8'));
    if (!t && !r) throw bad();
    return { threadId: t || null, root: r || null };
  } catch {
    throw bad();
  }
}

const msgIds = (value) => String(value || '').match(/<[^<>\s]+>/g) || [];

function headerValue(buf, name) {
  if (!buf) return '';
  const unfolded = buf.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const match = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(unfolded);
  return match ? match[1].trim() : '';
}

function threadRoot({ references, inReplyTo, messageId }) {
  return msgIds(references)[0] || msgIds(inReplyTo)[0] || msgIds(messageId)[0] || null;
}

function newMessageId(email) {
  return `<${crypto.randomUUID()}@${String(email).split('@')[1] || 'localhost'}>`;
}

// ─── Shaping ────────────────────────────────────────────────────────────────

// A display name that is just the address again ("x@y <x@y>") is dropped.
const fmtAddrs = (list) =>
  (list || []).map(a => (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address)).filter(Boolean).join(', ');

function dateString(value) {
  const d = value ? new Date(value) : null;
  return d && !isNaN(d) ? d.toUTCString() : '';
}

// Part 1 is the body of a single-part message and the plain-text half of a
// multipart/alternative one — the snippet source for most mail — so it rides
// along with the summary instead of costing a second round trip. 16 KB because
// an HTML mail's first few KB are often nothing but <head> and CSS.
const SNIPPET_BYTES = 16 * 1024;

const summaryQuery = (client) => ({
  uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true,
  headers: ['references'],
  bodyParts: [{ key: '1', maxLength: SNIPPET_BYTES }],
  ...(hasObjectId(client) ? { threadId: true } : {}),
});

const hasObjectId = (client) => Boolean(client.capabilities?.has('OBJECTID'));

/** The part a snippet comes from: first plain-text body part, else first HTML one. */
function bodyPart(node, type) {
  if (!node) return null;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const hit = bodyPart(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const attachment = node.disposition === 'attachment' || node.dispositionParameters?.filename;
  if (attachment || node.type !== type) return null;
  return { part: node.part || '1', encoding: node.encoding, charset: node.parameters?.charset, type };
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachment);
  return Boolean(node.disposition === 'attachment' || node.dispositionParameters?.filename || node.parameters?.name);
}

function decodeTransfer(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') {
    // A partial fetch can cut mid-group; a complete one ends in padding, which must stay.
    const clean = buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
  }
  if (enc === 'quoted-printable') {
    const s = buf.toString('latin1').replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(s.charCodeAt(i) & 0xff);
      }
    }
    return Buffer.from(bytes);
  }
  return buf;
}

function decodeCharset(buf, charset) {
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

/**
 * Text from the first bytes of an HTML part. The fetch is partial, so a
 * <style> or <head> may never close and the last tag may be cut in half —
 * htmlToText expects whole documents and would pass either through as text.
 */
function htmlSnippetText(html) {
  return htmlToText(String(html)
    .replace(/<head[\s>][\s\S]*?(<\/head>|$)/i, '')
    .replace(/<(style|script|title)[\s>][\s\S]*?(<\/\1>|$)/gi, '')
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/<[^>]*$/, ''));
}

function snippetFrom(buf, part) {
  const raw  = decodeCharset(decodeTransfer(buf, part.encoding), part.charset);
  const text = part.type === 'text/html' ? htmlSnippetText(raw) : raw;
  return text.replace(/�+$/, '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
}

/** One message row, shaped like gmail_api's summarize(), plus the threading facts kept aside. */
function summaryOf(msg, { f, path, uidValidity }) {
  const env  = msg.envelope || {};
  const references = msgIds(headerValue(msg.headers, 'references'));
  const root = threadRoot({ references: references.join(' '), inReplyTo: env.inReplyTo, messageId: env.messageId });

  return {
    row: {
      id:        encodeId(path, uidValidity, msg.uid),
      thread_id: encodeThread({ threadId: msg.threadId, root }),
      from:      fmtAddrs(env.from),
      to:        fmtAddrs(env.to),
      subject:   env.subject || '',
      date:      dateString(env.date || msg.internalDate),
      snippet:   '',
      labels:    labelsFor(f, path, msg.flags),
      unread:    !msg.flags?.has('\\Seen'),
    },
    root,
    threadId:  msg.threadId || null,
    // Every Message-ID this one names, itself included: how ancestors are found.
    chain:     [...new Set([...references, ...msgIds(env.inReplyTo), ...msgIds(env.messageId)])],
    messageId: env.messageId || null,
    cc:        fmtAddrs(env.cc),
    uid:       msg.uid,
    path,
    sortTime:  new Date(env.date || msg.internalDate || 0).getTime() || 0,
    structure: msg.bodyStructure,
    partOne:   msg.bodyParts && [...msg.bodyParts.values()][0],
  };
}

/**
 * Fill snippets. Most come from part 1, already fetched with the summary; the
 * rest (a body nested deeper, e.g. mixed → alternative → plain) cost one fetch
 * per distinct part number.
 */
async function fillSnippets(client, entries) {
  const groups = new Map();
  for (const e of entries) {
    const part = bodyPart(e.structure, 'text/plain') || bodyPart(e.structure, 'text/html');
    if (!part) continue;
    if (part.part === '1' && e.partOne) { e.row.snippet = snippetFrom(e.partOne, part); continue; }
    const key = `${part.part}|${part.type}|${part.encoding}|${part.charset}`;
    if (!groups.has(key)) groups.set(key, { part, entries: [] });
    groups.get(key).entries.push(e);
  }
  for (const { part, entries: members } of groups.values()) {
    const byUid = new Map(members.map(e => [e.uid, e]));
    const fetched = await client.fetchAll(members.map(e => e.uid),
      { uid: true, bodyParts: [{ key: part.part, maxLength: SNIPPET_BYTES }] }, { uid: true });
    for (const msg of fetched) {
      const buf = msg.bodyParts && [...msg.bodyParts.values()][0];
      const entry = byUid.get(msg.uid);
      if (buf && entry) entry.row.snippet = snippetFrom(buf, part);
    }
  }
  for (const e of entries) delete e.partOne;
}

async function summaries(client, f, path, uids) {
  if (!uids.length) return [];
  const uidValidity = client.mailbox.uidValidity;
  const fetched = await client.fetchAll(uids, summaryQuery(client), { uid: true });
  const entries = fetched.map(msg => summaryOf(msg, { f, path, uidValidity }));
  await fillSnippets(client, entries);
  return entries;
}

async function inFolder(client, path, { readOnly = true, uidValidity } = {}, fn) {
  const lock = await client.getMailboxLock(path, { readOnly });
  try {
    if (uidValidity !== undefined && String(client.mailbox.uidValidity) !== String(uidValidity)) {
      throw new Error('That id is stale: the server renumbered its folder since it was issued. Search again for a fresh id.');
    }
    return await fn();
  } finally {
    lock.release();
  }
}

// ─── Search ─────────────────────────────────────────────────────────────────

const encodeCursor = (c) => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
function decodeCursor(token) {
  if (!token) return null;
  try { return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch {
    throw new Error('That page_token is not from this mailbox — repeat the search without it.');
  }
}

/**
 * Newest-first matches across the searched folders, one page.
 *
 * Each folder is paged by UID, newest first. The page takes the newest
 * messages across folders, then keeps, per folder, exactly as many of that
 * folder's newest as it contributed — so the cursor can resume each folder
 * just below what it returned, and nothing is skipped between pages.
 */
async function collect(client, f, { query: q, maxResults = 10, pageToken }) {
  const compiled = imapQuery.compile(q);
  const limit    = Math.min(Math.max(Number(maxResults) || 10, 1), 50);
  const cursor   = decodeCursor(pageToken) || { v: {}, u: {} };
  const paths    = searchScope(f, compiled.folders);

  const perFolder = [];
  for (const path of paths) {
    await inFolder(client, path, {}, async () => {
      const uidValidity = String(client.mailbox.uidValidity);
      const sameFolder  = cursor.v[path] === uidValidity;
      const below       = sameFolder ? cursor.u[path] : undefined;
      // Nothing below the cursor, or nothing in the folder at all: no SEARCH
      // round trip, which on AOL is half a second per folder.
      if (below === 0 || below === 1 || !client.mailbox.exists) {
        perFolder.push({ path, uidValidity, uids: [], accepted: [], scanned: 0, below });
        return;
      }

      const criteria = below ? { ...compiled.criteria, uid: `1:${below - 1}` } : compiled.criteria;
      const uids = ((await client.search(criteria, { uid: true })) || []).sort((a, b) => b - a);

      const accepted = [];
      let scanned = 0;
      if (compiled.hasAttachment === undefined) {
        accepted.push(...await summaries(client, f, path, uids.slice(0, limit)));
        scanned = Math.min(limit, uids.length);
      } else {
        const chunk = Math.max(limit * 2, 20);
        while (accepted.length < limit && scanned < uids.length && scanned < MAX_ATTACHMENT_SCAN) {
          const batch = uids.slice(scanned, scanned + chunk);
          scanned += batch.length;
          const rows = await summaries(client, f, path, batch);
          accepted.push(...rows.filter(e => hasAttachment(e.structure) === compiled.hasAttachment));
        }
      }
      accepted.sort((a, b) => b.uid - a.uid);
      perFolder.push({ path, uidValidity, uids, accepted, scanned, below });
    });
  }

  // How many each folder contributes to the newest `limit` overall…
  const pool = perFolder.flatMap(p => p.accepted).sort((a, b) => b.sortTime - a.sortTime).slice(0, limit);
  const take = new Map(perFolder.map(p => [p.path, 0]));
  for (const e of pool) take.set(e.path, take.get(e.path) + 1);

  // …then that many of its newest, so each folder's page is a prefix.
  const picked = [];
  const next   = { v: {}, u: {} };
  let more = false;
  for (const p of perFolder) {
    const k = take.get(p.path);
    picked.push(...p.accepted.slice(0, k));
    next.v[p.path] = p.uidValidity;
    if (k < p.accepted.length) {
      next.u[p.path] = k ? p.accepted[k - 1].uid : p.below;
      more = true;
    } else if (p.scanned < p.uids.length) {
      next.u[p.path] = p.uids[p.scanned - 1] ?? p.below;
      more = true;
    } else {
      next.u[p.path] = 0;
    }
  }
  picked.sort((a, b) => b.sortTime - a.sortTime);

  return { entries: picked, nextPageToken: more ? encodeCursor(next) : null, paths };
}

async function searchMessages(cred, args) {
  return withImap(cred, async (client) => {
    const f = await folders(client);
    const { entries, nextPageToken } = await collect(client, f, args);
    return { messages: entries.map(e => e.row), nextPageToken };
  });
}

// How many of a folder's newest messages are read for their THREADID when
// gathering a thread. One FETCH of uid + thread id each: small and quick.
const THREAD_WINDOW = 500;

/** A search the server refuses finds nothing here, rather than failing the whole thread. */
const quietly = (promise) => Promise.resolve(promise).then(r => r || [], () => []);

const anyHeader = (name, values) => (values.length === 1
  ? { header: { [name]: values[0] } }
  : { or: values.map(v => ({ header: { [name]: v } })) });

/**
 * Every message of the given threads, in the given folders.
 *
 * threads: [{ threadId, root, ids:Set }] — ids are Message-IDs known to belong.
 *
 * Learned against AOL, which is why this is not one OR search:
 *   - HEADER Message-ID works, so ancestors are found by the ids a thread's
 *     messages name in References.
 *   - HEADER References / In-Reply-To find nothing there (and take ~8 s), and
 *     any OR that includes them returns nothing at all, so they are only tried
 *     — separately — on servers without THREADID.
 *   - THREADID as FETCHed is right across folders (a reply in Sent carries its
 *     original's), but SEARCH THREADID found the original one time in three.
 *     So it is not used: the recent window of each folder is read for THREADID
 *     and matched here, and older ancestors come from the Message-ID search.
 */
async function threadMembers(client, f, threads, paths) {
  const objectId  = hasObjectId(client);
  const threadIds = new Set(threads.map(t => t.threadId).filter(Boolean));
  const knownIds  = [...new Set(threads.flatMap(t => [t.root, ...t.ids]).filter(Boolean))].slice(0, 60);
  const roots     = [...new Set(threads.map(t => t.root).filter(Boolean))];

  const found = [];
  const seen  = new Set();
  for (const path of paths) {
    await inFolder(client, path, {}, async () => {
      if (!client.mailbox.exists) return;
      const uids = new Set();
      const add  = (list) => list.forEach(u => uids.add(u));

      // Where the window below already reads every message's THREADID, the
      // Message-ID search finds nothing new — skip its round trip.
      const windowCoversAll = objectId && threadIds.size && client.mailbox.exists <= THREAD_WINDOW;
      if (knownIds.length && !windowCoversAll) {
        add(await quietly(client.search(anyHeader('message-id', knownIds), { uid: true })));
      }

      if (objectId && threadIds.size) {
        const from = Math.max(1, client.mailbox.exists - THREAD_WINDOW + 1);
        for (const m of await client.fetchAll(`${from}:*`, { uid: true, threadId: true })) {
          if (threadIds.has(m.threadId)) uids.add(m.uid);
        }
      } else if (!objectId && roots.length) {
        add(await quietly(client.search(anyHeader('references', roots), { uid: true })));
        add(await quietly(client.search(anyHeader('in-reply-to', roots), { uid: true })));
      }

      for (const e of await summaries(client, f, path, [...uids])) {
        // A copy of one message in two folders (cc to yourself) counts once.
        const key = e.messageId || `${path}:${e.uid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(e);
      }
    });
  }
  return found;
}

const memberOf = (entry, thread) =>
  Boolean((thread.threadId && entry.threadId === thread.threadId)
    || (entry.messageId && thread.ids.has(entry.messageId))
    || (thread.root && entry.root === thread.root));

/** The threads a page of matched messages belongs to, newest match first. */
function threadsOf(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const key = e.threadId ? `t:${e.threadId}` : e.root ? `r:${e.root}` : null;
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { threadId: e.threadId, root: e.root, ids: new Set() });
    const t = byKey.get(key);
    e.chain.forEach(id => t.ids.add(id));
  }
  return [...byKey.values()];
}

/**
 * Every message of one thread. Thread-wide label changes look in every folder
 * (untrash has to reach Trash); reading leaves out Spam and Trash, as Gmail's
 * thread view does.
 */
async function wholeThread(client, f, threadId, { includeBin = true } = {}) {
  const { threadId: t, root } = decodeThread(threadId);
  const thread = { threadId: t, root, ids: new Set(root ? [root] : []) };
  const bin    = new Set([f.special['\\Junk'], f.special['\\Trash']].filter(Boolean));
  const paths  = f.list.map(x => x.path).filter(p => includeBin || !bin.has(p));
  const members = (await threadMembers(client, f, [thread], paths))
    .filter(m => memberOf(m, thread));
  return members.sort((a, b) => a.sortTime - b.sortTime);
}

function summarizeThread(thread, members) {
  const ordered = [...members].sort((a, b) => a.sortTime - b.sortTime);
  const first = ordered[0];
  const last  = ordered[ordered.length - 1];

  const participants = [];
  const seen = new Set();
  for (const m of ordered) {
    for (const entry of [m.row.from, m.row.to, m.cc].flatMap(parseAddresses)) {
      const key = addressOf(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      participants.push(entry);
    }
  }

  return {
    id:            encodeThread(thread),
    subject:       first.row.subject,
    participants,
    message_count: ordered.length,
    first_date:    first.row.date,
    last_date:     last.row.date,
    last_from:     last.row.from,
    snippet:       last.row.snippet,
    labels:        [...new Set(ordered.flatMap(m => m.row.labels))],
    unread_count:  ordered.filter(m => m.row.unread).length,
  };
}

/**
 * Conversations whose messages match. A page of matching messages is grouped
 * by thread, and each thread is then gathered from the searched folders plus
 * Inbox and Sent, so replies you wrote and the mail they answer both count. A
 * long thread can match on two pages and appear on both.
 */
async function searchThreads(cred, args) {
  return withImap(cred, async (client) => {
    const f = await folders(client);
    const { entries, nextPageToken, paths } = await collect(client, f, args);

    const threads = threadsOf(entries);
    if (!threads.length) return { threads: [], nextPageToken };

    const scope   = [...new Set([...paths, f.special['\\Inbox'], f.special['\\Sent']].filter(Boolean))];
    const members = await threadMembers(client, f, threads, scope);

    // A matched message always counts, even where the server's search for
    // the rest of its thread found nothing.
    const pool = [...members];
    for (const e of entries) if (!pool.some(m => m.path === e.path && m.uid === e.uid)) pool.push(e);

    const rows = threads.map((thread) => {
      const own = pool.filter(m => memberOf(m, thread));
      return own.length ? summarizeThread(thread, own) : null;
    }).filter(Boolean);

    return { threads: rows, nextPageToken };
  });
}

// ─── Read ───────────────────────────────────────────────────────────────────

const PARSE_OPTIONS = { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true };

function attachmentsOf(parsed) {
  return (parsed.attachments || []).filter(a => a.filename || a.contentDisposition === 'attachment');
}

/** A parsed message, shaped like gmail_api's getMessage(). */
function messageView(parsed, { f, path, uidValidity, uid, flags, threadId }) {
  const body = parsed.text || (parsed.html ? htmlToText(parsed.html) : '');
  const root = threadRoot({
    references: [].concat(parsed.references || []).join(' '),
    inReplyTo:  parsed.inReplyTo,
    messageId:  parsed.messageId,
  });
  return {
    id:        encodeId(path, uidValidity, uid),
    thread_id: encodeThread({ threadId, root }),
    from:      parsed.from?.text || '',
    to:        parsed.to?.text || '',
    subject:   parsed.subject || '',
    date:      dateString(parsed.date),
    snippet:   body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
    labels:    labelsFor(f, path, flags),
    unread:    !flags?.has('\\Seen'),
    cc:        parsed.cc?.text || '',
    body:      truncateBody(body),
    attachments: attachmentsOf(parsed).map((a, i) => ({
      attachment_id: String(i + 1),
      filename:      a.filename || `attachment-${i + 1}`,
      mime_type:     a.contentType || 'application/octet-stream',
      size_bytes:    a.size || a.content?.length || 0,
    })),
  };
}

/** Raw source + flags of one message. EXAMINE (read-only) and BODY.PEEK, so reading never marks it read. */
async function fetchSource(client, ref) {
  return inFolder(client, ref.path, { uidValidity: ref.uidValidity }, async () => {
    const query = { uid: true, flags: true, source: true, ...(hasObjectId(client) ? { threadId: true } : {}) };
    const msg = await client.fetchOne(String(ref.uid), query, { uid: true });
    if (!msg || !msg.source) {
      throw new Error('That message is no longer in that folder — it was moved or deleted. Search again for its current id.');
    }
    return { source: msg.source, flags: msg.flags, threadId: msg.threadId, uidValidity: client.mailbox.uidValidity };
  });
}

async function readOne(client, f, id) {
  const ref = decodeId(id);
  const { source, flags, threadId, uidValidity } = await fetchSource(client, ref);
  const parsed = await simpleParser(source, PARSE_OPTIONS);
  return { ref, source, parsed, view: messageView(parsed, { f, path: ref.path, uidValidity, uid: ref.uid, flags, threadId }) };
}

async function getMessage(cred, id) {
  return withImap(cred, async (client) => (await readOne(client, await folders(client), id)).view);
}

async function getThread(cred, threadId) {
  return withImap(cred, async (client) => {
    const f = await folders(client);
    const members = await wholeThread(client, f, threadId, { includeBin: false });

    // One folder visit and one FETCH per folder, not one of each per message.
    const views = new Map();
    for (const path of [...new Set(members.map(m => m.path))]) {
      const here = members.filter(m => m.path === path);
      await inFolder(client, path, {}, async () => {
        const query = { uid: true, flags: true, source: true, ...(hasObjectId(client) ? { threadId: true } : {}) };
        for (const msg of await client.fetchAll(here.map(m => m.uid), query, { uid: true })) {
          const parsed = await simpleParser(msg.source, PARSE_OPTIONS);
          views.set(`${path}:${msg.uid}`, messageView(parsed, {
            f, path, uidValidity: client.mailbox.uidValidity, uid: msg.uid, flags: msg.flags, threadId: msg.threadId,
          }));
        }
      });
    }
    return { id: threadId, messages: members.map(m => views.get(`${m.path}:${m.uid}`)).filter(Boolean) };
  });
}

async function getAttachment(cred, messageId, attachmentId) {
  return withImap(cred, async (client) => {
    const { parsed } = await readOne(client, await folders(client), messageId);
    const list = attachmentsOf(parsed);
    const att  = list[Number(attachmentId) - 1];
    if (!att) throw new Error(`No attachment ${attachmentId} on that message — it has ${list.length}.`);
    return { data: att.content, filename: att.filename, mime_type: att.contentType };
  });
}

// ─── Send ───────────────────────────────────────────────────────────────────

/** Remove one header (and its folded continuation lines) from a raw message's header block. */
function stripHeader(raw, name) {
  const text  = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const split = text.search(/\r?\n\r?\n/);
  const head  = split === -1 ? text : text.slice(0, split);
  const rest  = split === -1 ? '' : text.slice(split);
  const lines = head.split(/\r?\n/);
  const out   = [];
  let skipping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && skipping) continue;
    skipping = new RegExp(`^${name}:`, 'i').test(line);
    if (!skipping) out.push(line);
  }
  return out.join('\r\n') + rest;
}

function setHeader(raw, name, value) {
  const stripped = stripHeader(raw, name);
  return `${name}: ${value}\r\n${stripped}`;
}

const rfcDate = (d) => d.toUTCString().replace('GMT', '+0000');

/** Bare addresses for the SMTP envelope — Bcc included, since that is how Bcc is delivered. */
function recipients(...fields) {
  return [...new Set(fields.filter(Boolean).flatMap(parseAddresses).map(addressOf).filter(Boolean))];
}

/**
 * Keep a copy in Sent. AOL may file the SMTP submission there itself, so look
 * for it by Message-ID first and append only when it does not show up — never
 * two copies, and never none.
 */
async function saveToSent(cred, raw, messageId) {
  return withImap(cred, async (client) => {
    const f = await folders(client);
    const sent = f.special['\\Sent'];
    if (!sent) return { id: null, saved: 'no Sent folder' };

    for (const wait of SENT_COPY_WAITS_MS) {
      if (wait) await new Promise(r => setTimeout(r, wait));
      const hit = await inFolder(client, sent, {}, async () => {
        const uids = (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
        return uids.length ? encodeId(sent, client.mailbox.uidValidity, Math.max(...uids)) : null;
      });
      if (hit) return { id: hit, saved: 'by the server' };
    }

    const appended = await client.append(sent, raw, ['\\Seen']);
    const id = appended?.uid ? encodeId(sent, appended.uidValidity, appended.uid) : null;
    return { id, saved: 'appended' };
  });
}

/**
 * The thread a new message joins. A reply arrives with the thread id the tool
 * read off the original (Gmail's threadId slot), which carries the server's
 * THREADID; otherwise the In-Reply-To/References chain names it.
 */
function threadFor(fields, messageId) {
  let known = null;
  try { known = fields.threadId ? decodeThread(fields.threadId) : null; } catch { known = null; }
  return {
    threadId: known?.threadId || null,
    root:     known?.root || msgIds(fields.references)[0] || msgIds(fields.inReplyTo)[0] || messageId,
  };
}

async function deliver(cred, raw, { to, cc, bcc, messageId, thread }) {
  const rcpts = recipients(to, cc, bcc);
  if (!rcpts.length) throw new Error('The message has no recipients.');

  const transport = makeSmtp(smtpOptions(cred));
  try {
    // Bcc recipients are on the envelope only; the header would show them to everyone.
    await transport.sendMail({ envelope: { from: cred.email, to: rcpts }, raw: stripHeader(raw, 'bcc') });
  } catch (err) {
    throw friendly(err, cred);
  } finally {
    transport.close?.();
  }

  const copy = await saveToSent(cred, raw, messageId);
  return { id: copy.id, threadId: encodeThread(thread), sent_copy: copy.saved };
}

/** Threading travels in In-Reply-To/References; fields.threadId only names the thread in the result. */
async function sendMessage(cred, fields) {
  const messageId = newMessageId(cred.email);
  const raw = buildRawMime({ ...fields, date: new Date(), messageId });
  return deliver(cred, raw, { to: fields.to, cc: fields.cc, bcc: fields.bcc, messageId, thread: threadFor(fields, messageId) });
}

async function getReplyContext(cred, id) {
  return withImap(cred, async (client) => {
    const { parsed, view } = await readOne(client, await folders(client), id);
    const subject = parsed.subject || '';
    const references = [].concat(parsed.references || []).join(' ');
    return {
      threadId:   view.thread_id,
      messageId:  parsed.messageId || '',
      references,
      from:       parsed.from?.text || '',
      to:         parsed.to?.text || '',
      cc:         parsed.cc?.text || '',
      subject:    /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    };
  });
}

async function forwardMessage(cred, { from, messageId, to, cc, note }) {
  const { parsed } = await withImap(cred, async (client) => readOne(client, await folders(client), messageId));

  const origSubject = parsed.subject || '';
  const quoted = [
    '---------- Forwarded message ----------',
    `From: ${parsed.from?.text || ''}`,
    `Date: ${parsed.date ? rfcDate(parsed.date) : ''}`,
    `Subject: ${origSubject}`,
    `To: ${parsed.to?.text || ''}`,
    '',
    parsed.text || (parsed.html ? htmlToText(parsed.html) : ''),
  ].join('\n');

  const carried = [];
  const skipped = [];
  let total = 0;
  for (const att of attachmentsOf(parsed)) {
    if (total + att.content.length > MAX_FORWARD_ATTACHMENT_BYTES) { skipped.push(att.filename); continue; }
    total += att.content.length;
    carried.push({ filename: att.filename || 'attachment', mimeType: att.contentType, data: att.content });
  }

  const sent = await sendMessage(cred, {
    from, to, cc,
    subject: /^fwd:/i.test(origSubject) ? origSubject : `Fwd: ${origSubject}`,
    body:    note ? `${note}\n\n${quoted}` : quoted,
    attachments: carried,
  });
  return { sent, skippedAttachments: skipped };
}

// ─── Labels → flags and folders ─────────────────────────────────────────────

/**
 * Turn a Gmail-style label change into flags plus at most one destination.
 *
 * Removing INBOX (or the folder a message is in) archives it; removing SPAM or
 * TRASH restores it — to Sent if you wrote it, else the inbox. Anything that
 * would need the message in two folders is refused.
 */
function planChange(f, current, { add = [], remove = [] }, { fromSelf = false } = {}) {
  const flagsAdd = [];
  const flagsRemove = [];
  const unsupported = [];
  let target = null;

  const moveTo = (path) => {
    if (target && target !== path) {
      throw new Error('A message sits in one folder here, so it cannot take two folder labels at once — pick one.');
    }
    target = path;
  };

  for (const label of add) {
    const upper = String(label).toUpperCase();
    if (upper === 'UNREAD') flagsRemove.push('\\Seen');
    else if (upper === 'STARRED') flagsAdd.push('\\Flagged');
    else if (LABEL_SPECIALS[upper]) moveTo(requireSpecial(f, LABEL_SPECIALS[upper]));
    else if (upper === 'ARCHIVE') moveTo(f.special['\\Archive'] || 'Archive');
    else {
      const hits = f.list.filter(x => x.path === label);
      const byName = hits.length ? hits : folderByName(f, label);
      if (byName.length === 1) moveTo(byName[0].path);
      else unsupported.push(label);
    }
  }

  for (const label of remove) {
    const upper = String(label).toUpperCase();
    if (upper === 'UNREAD') { flagsAdd.push('\\Seen'); continue; }
    if (upper === 'STARRED') { flagsRemove.push('\\Flagged'); continue; }

    let path = null;
    if (LABEL_SPECIALS[upper]) path = f.special[LABEL_SPECIALS[upper]] || null;
    else {
      const hits = folderByName(f, label);
      if (hits.length === 1) path = hits[0].path;
      else { unsupported.push(label); continue; }
    }
    if (path !== current || target) continue;   // not there, or already moving elsewhere

    if (upper === 'SPAM' || upper === 'TRASH') {
      moveTo(fromSelf && f.special['\\Sent'] ? f.special['\\Sent'] : requireSpecial(f, '\\Inbox'));
    } else {
      moveTo(f.special['\\Archive'] || 'Archive');
    }
  }

  if (unsupported.length) {
    throw new Error(
      `Not available on this mailbox: ${unsupported.join(', ')}. Use UNREAD, STARRED, INBOX, SPAM, TRASH, ` +
      'or a folder name from list_labels.',
    );
  }
  return { flagsAdd, flagsRemove, target: target === current ? null : target };
}

/** Moves must not fall back to a mailbox-wide EXPUNGE, which could erase unrelated mail. */
function assertSafeMove(client) {
  const caps = client.capabilities;
  if (caps && !caps.has('MOVE') && !caps.has('UIDPLUS')) {
    throw new Error('This server can only move mail by copy-and-expunge, which could also erase other messages — refusing.');
  }
}

async function ensureFolder(client, f, path) {
  if (f.list.some(x => x.path === path)) return;
  await client.mailboxCreate(path);
  f.list.push({ path, name: path, delimiter: f.delimiter, flags: new Set() });
}

/** Apply a planned change to one message; returns its id afterwards (new if it moved). */
async function applyChange(client, f, ref, plan) {
  if (plan.target) {
    assertSafeMove(client);
    await ensureFolder(client, f, plan.target);
  }
  return inFolder(client, ref.path, { readOnly: false, uidValidity: ref.uidValidity }, async () => {
    const uid = String(ref.uid);
    if (plan.flagsAdd.length)    await client.messageFlagsAdd(uid, plan.flagsAdd, { uid: true });
    if (plan.flagsRemove.length) await client.messageFlagsRemove(uid, plan.flagsRemove, { uid: true });
    if (!plan.target) return encodeId(ref.path, client.mailbox.uidValidity, ref.uid);

    const moved = await client.messageMove(uid, plan.target, { uid: true });
    if (!moved) throw new Error(`The server refused to move the message to ${plan.target}.`);
    const newUid = moved.uidMap?.get(ref.uid);
    return newUid && moved.uidValidity !== undefined ? encodeId(plan.target, moved.uidValidity, newUid) : null;
  });
}

async function fromSelfOf(client, ref, email) {
  return inFolder(client, ref.path, { uidValidity: ref.uidValidity }, async () => {
    const msg = await client.fetchOne(String(ref.uid), { uid: true, envelope: true }, { uid: true });
    return (msg?.envelope?.from || []).some(a => String(a.address).toLowerCase() === email.toLowerCase());
  });
}

async function modifyLabels(cred, id, change) {
  const ref = decodeId(id);
  return withImap(cred, async (client) => {
    const f = await folders(client);
    const fromSelf = await fromSelfOf(client, ref, cred.email);
    const plan  = planChange(f, ref.path, change, { fromSelf });
    const newId = await applyChange(client, f, ref, plan);
    return { id: newId, labelIds: plan.target ? labelsAfter(f, plan) : undefined, ...(newId !== id ? { moved_to: plan.target } : {}) };
  });
}

function labelsAfter(f, plan) {
  return [SPECIAL_LABELS[f.specialOf[plan.target]] || plan.target];
}

async function modifyThreadLabels(cred, threadId, change) {
  decodeThread(threadId);
  return withImap(cred, async (client) => {
    const f = await folders(client);
    const members = await wholeThread(client, f, threadId);
    if (!members.length) throw new Error('No messages of that thread were found in this mailbox.');

    const ids = [];
    for (const m of members) {
      const ref = decodeId(m.row.id);
      const fromSelf = addressOf(m.row.from || '') === cred.email.toLowerCase();
      // Each message is planned from the folder it is in, so a thread-wide
      // archive moves only the ones in the inbox and leaves Sent alone.
      const plan = planChange(f, ref.path, change, { fromSelf });
      ids.push(await applyChange(client, f, ref, plan));
    }
    return { messages: ids.length, ids };
  });
}

const trashMessage   = (cred, id) => modifyLabels(cred, id, { add: ['TRASH'] });
const trashThread    = (cred, id) => modifyThreadLabels(cred, id, { add: ['TRASH'] });

async function untrashMessage(cred, id) {
  const ref = decodeId(id);
  return withImap(cred, async (client) => {
    const f = await folders(client);
    if (ref.path !== f.special['\\Trash']) throw new Error('That message is not in Trash.');
    const fromSelf = await fromSelfOf(client, ref, cred.email);
    const plan = planChange(f, ref.path, { remove: ['TRASH'] }, { fromSelf });
    const newId = await applyChange(client, f, ref, plan);
    return { id: newId, moved_to: plan.target };
  });
}

const untrashThread  = (cred, id) => modifyThreadLabels(cred, id, { remove: ['TRASH'] });

async function listLabels(cred) {
  return withImap(cred, async (client) => {
    const f = await folders(client);
    const system = Object.entries(SPECIAL_LABELS)
      .filter(([use]) => f.special[use])
      .map(([use, id]) => ({ id, name: SPECIAL_NAMES[use], type: 'system', folder: f.special[use] }));
    const flags = [
      { id: 'UNREAD',  name: 'Unread',  type: 'system' },
      { id: 'STARRED', name: 'Starred', type: 'system' },
    ];
    const user = f.list
      .filter(x => !SPECIAL_LABELS[f.specialOf[x.path]])
      .map(x => ({ id: x.path, name: x.path.split(f.delimiter).join('/'), type: f.specialOf[x.path] ? 'system' : 'user' }));
    return [...system, ...flags, ...user];
  });
}

function assertUserFolder(f, id) {
  if (LABEL_SPECIALS[String(id).toUpperCase()] || f.specialOf[id] || String(id).toUpperCase() === 'INBOX') {
    throw new Error(`${id} is a system folder and cannot be renamed or deleted.`);
  }
  if (!f.list.some(x => x.path === id)) throw new Error(`No folder "${id}". Use an id from list_labels.`);
}

async function createLabel(cred, name) {
  return withImap(cred, async (client) => {
    const f = await folders(client);
    const path = String(name).split('/').join(f.delimiter);
    await client.mailboxCreate(path);
    return { id: path, name };
  });
}

async function updateLabel(cred, id, name) {
  return withImap(cred, async (client) => {
    const f = await folders(client);
    assertUserFolder(f, id);
    const path = String(name).split('/').join(f.delimiter);
    await client.mailboxRename(id, path);
    return { id: path, name };
  });
}

/**
 * Deleting a Gmail label keeps the mail; deleting an IMAP folder deletes it.
 * So only an empty folder with no subfolders can go.
 */
async function deleteLabel(cred, id) {
  return withImap(cred, async (client) => {
    const f = await folders(client);
    assertUserFolder(f, id);
    if (f.list.some(x => x.path.startsWith(`${id}${f.delimiter}`))) {
      throw new Error(`"${id}" has subfolders. Delete or move those first.`);
    }
    const status = await client.status(id, { messages: true });
    if (!status || status.messages > 0) {
      throw new Error(
        `"${id}" still holds ${status ? status.messages : 'an unknown number of'} message(s), and deleting a folder ` +
        'here deletes the mail inside it — unlike a Gmail label. Move or trash them first, then delete the empty folder.',
      );
    }
    await client.mailboxDelete(id);
    return { deleted: id };
  });
}

// ─── Drafts ─────────────────────────────────────────────────────────────────

async function appendDraft(client, f, raw, messageId) {
  const drafts = requireSpecial(f, '\\Drafts');
  const appended = await client.append(drafts, raw, ['\\Draft', '\\Seen']);
  if (appended?.uid) return encodeId(drafts, appended.uidValidity, appended.uid);
  // No UIDPLUS: find it again by the Message-ID it was given.
  return inFolder(client, drafts, {}, async () => {
    const uids = (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
    return uids.length ? encodeId(drafts, client.mailbox.uidValidity, Math.max(...uids)) : null;
  });
}

/**
 * The one permanent delete in this module: a single draft, by UID, in the
 * Drafts folder. Without UID EXPUNGE a plain EXPUNGE would also erase every
 * other message flagged \Deleted in that folder, so the draft goes to Trash
 * instead.
 */
async function removeDraft(client, f, ref) {
  if (ref.path !== f.special['\\Drafts']) throw new Error('That id is not a draft — only messages in Drafts can be deleted as drafts.');
  if (!client.capabilities?.has('UIDPLUS')) {
    await applyChange(client, f, ref, { flagsAdd: [], flagsRemove: [], target: requireSpecial(f, '\\Trash') });
    return 'moved to trash';
  }
  await inFolder(client, ref.path, { readOnly: false, uidValidity: ref.uidValidity }, async () => {
    await client.messageDelete(String(ref.uid), { uid: true });
  });
  return 'deleted';
}

async function listDrafts(cred, { maxResults = 15 } = {}) {
  return withImap(cred, async (client) => {
    const f = await folders(client);
    const drafts = requireSpecial(f, '\\Drafts');
    const limit = Math.min(Math.max(Number(maxResults) || 15, 1), 50);
    return inFolder(client, drafts, {}, async () => {
      const uids = ((await client.search({ all: true }, { uid: true })) || []).sort((a, b) => b - a).slice(0, limit);
      const rows = await summaries(client, f, drafts, uids);
      return rows.sort((a, b) => b.uid - a.uid).map(e => ({
        draft_id:   e.row.id,
        message_id: e.row.id,
        thread_id:  e.row.thread_id,
        to:         e.row.to,
        subject:    e.row.subject,
        snippet:    e.row.snippet,
      }));
    });
  });
}

async function getDraft(cred, draftId) {
  const view = await getMessage(cred, draftId);
  return { draft_id: draftId, ...view };
}

async function createDraft(cred, fields) {
  const messageId = newMessageId(cred.email);
  const raw = buildRawMime({ ...fields, date: new Date(), messageId });
  return withImap(cred, async (client) => {
    const f  = await folders(client);
    const id = await appendDraft(client, f, raw, messageId);
    return { draft_id: id, message_id: id, thread_id: encodeThread(threadFor(fields, messageId)) };
  });
}

/** IMAP has no in-place edit: the new version is saved, then the old one removed. The draft id changes. */
async function updateDraft(cred, draftId, fields) {
  const ref = decodeId(draftId);
  return withImap(cred, async (client) => {
    const f = await folders(client);
    if (ref.path !== f.special['\\Drafts']) throw new Error('That id is not a draft.');
    const { parsed } = await readOne(client, f, draftId);

    // A reply-draft stays a reply.
    const inReplyTo  = fields.inReplyTo  || parsed.inReplyTo;
    const references = fields.references || [].concat(parsed.references || []).join(' ') || undefined;

    const messageId = newMessageId(cred.email);
    const raw = buildRawMime({ ...fields, inReplyTo, references, date: new Date(), messageId });
    const id  = await appendDraft(client, f, raw, messageId);
    await removeDraft(client, f, ref);

    const thread = threadFor({ ...fields, inReplyTo, references }, messageId);
    return { draft_id: id, message_id: id, thread_id: encodeThread(thread), replaced_draft_id: draftId };
  });
}

async function sendDraft(cred, draftId) {
  const ref = decodeId(draftId);
  const draft = await withImap(cred, async (client) => {
    const f = await folders(client);
    if (ref.path !== f.special['\\Drafts']) throw new Error('That id is not a draft.');
    return readOne(client, f, draftId);
  });

  const { parsed } = draft;
  const messageId = parsed.messageId || newMessageId(cred.email);
  let raw = setHeader(draft.source, 'Date', rfcDate(new Date()));
  if (!parsed.messageId) raw = setHeader(raw, 'Message-ID', messageId);

  const references = [].concat(parsed.references || []).join(' ');
  const sent = await deliver(cred, raw, {
    to: parsed.to?.text, cc: parsed.cc?.text, bcc: parsed.bcc?.text,
    messageId,
    thread: threadFor({ threadId: draft.view.thread_id, references, inReplyTo: parsed.inReplyTo }, messageId),
  });

  await withImap(cred, async (client) => removeDraft(client, await folders(client), ref));
  return sent;
}

async function deleteDraft(cred, draftId) {
  const ref = decodeId(draftId);
  return withImap(cred, async (client) => ({ status: await removeDraft(client, await folders(client), ref) }));
}

module.exports = {
  verify,
  searchMessages, searchThreads, getMessage, getThread, getAttachment,
  sendMessage, getReplyContext, forwardMessage,
  modifyLabels, modifyThreadLabels,
  listLabels, createLabel, updateLabel, deleteLabel,
  trashMessage, untrashMessage, trashThread, untrashThread,
  listDrafts, getDraft, createDraft, updateDraft, sendDraft, deleteDraft,
  _internal: {
    setFactories({ imap, smtp } = {}) {
      if (imap) makeImap = imap;
      if (smtp) makeSmtp = smtp;
    },
    setSentCopyWaits(waits) { SENT_COPY_WAITS_MS = waits; },
    encodeId, decodeId, encodeThread, decodeThread, stripHeader, setHeader, planChange, threadRoot,
    decodeTransfer, snippetFrom, hasAttachment, bodyPart, searchScope, imapOptions, smtpOptions, relayTransport,
  },
};
