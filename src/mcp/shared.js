/**
 * Helpers every tool module shares.
 *
 * The `account` argument selects a linked Google account by email address.
 * Where it is optional, omitting it fans the call out across all of them —
 * that cross-account reach is the reason this server exists, since Claude's
 * first-party connectors hold exactly one Google account each.
 */

const accounts     = require('../services/gmail_accounts');
const imapAccounts = require('../services/imap_accounts');
const providers    = require('../services/imap_providers');
const gmailApi     = require('../services/gmail_api');
const imapApi      = require('../services/imap_api');

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/** Pick one address out of a linked list from what the caller said. */
function pick(linked, requested) {
  if (!linked.length) {
    throw new Error('No accounts are linked yet. Visit /gmail/connect to link one.');
  }

  if (!requested) {
    if (linked.length === 1) return linked[0];
    throw new Error(`Which account? Linked: ${linked.join(', ')}`);
  }

  const wanted = String(requested).toLowerCase().trim();
  const exact  = linked.find(e => e === wanted);
  if (exact) return exact;

  // Tolerate a bare local-part ("work" for work@example.com) — Claude often
  // passes whatever the user said rather than the full address.
  const partial = linked.filter(e => e.startsWith(`${wanted}@`) || e.includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${requested}" matches ${partial.join(', ')} — be specific.`);

  throw new Error(`"${requested}" is not linked. Linked: ${linked.join(', ')}`);
}

/**
 * Explain a Google-only miss that is really an IMAP mailbox, rather than
 * calling a linked address "not linked". Returns null when it is not one.
 */
async function mailOnlyHint(ownerKey, requested, googleLinked) {
  // Best-effort: a hint that cannot be computed must not replace the real error.
  let mail;
  try { mail = await imapAccounts.emailsFor(ownerKey); } catch { return null; }
  if (!mail.length) return null;

  const wanted = String(requested || '').toLowerCase().trim();
  const hits = requested
    ? mail.filter(m => m.email === wanted || m.email.startsWith(`${wanted}@`) || m.email.includes(wanted))
    : mail;
  if (requested && !hits.length) return null;

  const named = hits.map(m => `${m.email} (${providers.preset(m.provider).name})`).join(', ');
  return new Error(
    `${named} ${hits.length > 1 ? 'are mailboxes' : 'is a mailbox'} with mail only — Calendar, Drive, Contacts and ` +
    `Tasks need a Google account. ${googleLinked.length ? `Google accounts: ${googleLinked.join(', ')}` :
      'No Google account is linked; link one at /gmail/connect.'}`,
  );
}

/** Resolve the caller's `account` argument to a linked Google address, with a helpful error. */
async function resolveAccount(ownerKey, requested) {
  const linked = await accounts.emailsFor(ownerKey);
  try {
    return pick(linked, requested);
  } catch (err) {
    if (!linked.length || requested) {
      const hint = await mailOnlyHint(ownerKey, requested, linked);
      if (hint) throw hint;
    }
    throw err;
  }
}

// ─── Mail: Gmail and IMAP mailboxes behind one interface ────────────────────

/**
 * Every linked mailbox, Google and IMAP. An address linked both ways (a
 * Google account whose login is an AOL address has no Gmail mailbox) is the
 * IMAP one for mail.
 */
async function mailboxesFor(ownerKey) {
  const [google, imap] = await Promise.all([accounts.emailsFor(ownerKey), imapAccounts.emailsFor(ownerKey)]);
  const viaImap = new Set(imap.map(m => m.email));
  return [
    ...google.filter(email => !viaImap.has(email)).map(email => ({ email, provider: 'gmail' })),
    ...imap,
  ].sort((a, b) => a.email.localeCompare(b.email));
}

/** The client and its credential for one mailbox — an access token for Gmail, a login for IMAP. */
async function clientFor(ownerKey, box) {
  if (box.provider === 'gmail') {
    return { email: box.email, provider: 'gmail', api: gmailApi,
             handle: await accounts.accessTokenFor(ownerKey, box.email, 'gmail') };
  }
  return { email: box.email, provider: box.provider, api: imapApi,
           handle: await imapAccounts.credentialsFor(ownerKey, box.email) };
}

/** Resolve `account` across every mailbox and return its client — every mail tool starts this way. */
async function mailFor(ownerKey, requested) {
  const boxes = await mailboxesFor(ownerKey);
  const email = pick(boxes.map(b => b.email), requested);
  return clientFor(ownerKey, boxes.find(b => b.email === email));
}

/** The provider's display name, for messages that point the user at their mail app. */
const providerName = (provider) => (provider === 'gmail' ? 'Gmail' : providers.preset(provider).name);

/**
 * fanOut for mail: one mailbox, or every Gmail and IMAP mailbox when none is
 * named. perAccount receives (api, handle, email).
 */
async function fanOutMail(ownerKey, account, perAccount) {
  const boxes   = await mailboxesFor(ownerKey);
  const targets = account
    ? [boxes.find(b => b.email === pick(boxes.map(x => x.email), account))]
    : boxes;

  if (!targets.length) throw new Error('No accounts are linked yet. Visit /gmail/connect to link one.');

  const settled = await Promise.allSettled(targets.map(async (box) => {
    const { api, handle } = await clientFor(ownerKey, box);
    return { email: box.email, value: await perAccount(api, handle, box.email) };
  }));

  const ok     = [];
  const failed = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') ok.push(result.value);
    else failed.push(`${targets[i].email}: ${result.reason.message}`);
  });

  return { targets: targets.map(b => b.email), ok, failed };
}

/**
 * Account + access token in one step — nearly every tool starts this way.
 * `product` names the scope family the tool needs, so an account linked before
 * that product existed says "re-link me" instead of hitting an opaque 403.
 */
async function tokenFor(ownerKey, requested, product) {
  const email = await resolveAccount(ownerKey, requested);
  return { email, token: await accounts.accessTokenFor(ownerKey, email, product) };
}

/**
 * Run a per-account call against one account, or against every linked account
 * when none is named. allSettled throughout: one dead grant must not blank out
 * the accounts that still answer.
 */
async function fanOut(ownerKey, account, product, perAccount) {
  const targets = account
    ? [await resolveAccount(ownerKey, account)]
    : await accounts.emailsFor(ownerKey);

  // Hard error, not an empty result: "no matches" and "nothing was searched"
  // must never look the same to the model.
  if (!targets.length) {
    throw (await mailOnlyHint(ownerKey, undefined, []))
      || new Error('No accounts are linked yet. Visit /gmail/connect to link one.');
  }

  const settled = await Promise.allSettled(targets.map(async (email) => ({
    email,
    value: await perAccount(await accounts.accessTokenFor(ownerKey, email, product), email),
  })));

  const ok     = [];
  const failed = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') ok.push(result.value);
    else failed.push(`${targets[i]}: ${result.reason.message}`);
  });

  return { targets, ok, failed };
}

/**
 * Shape a fanned-out search the same way for every product: merged rows tagged
 * with the account they came from, per-account pagination and error reporting,
 * and newest first by whichever field carries the date.
 */
function mergeSearch({ targets, ok, failed }, { key, dateField, unavailableKey }) {
  const found       = [];
  const nextTokens  = {};
  const unavailable = {};

  for (const { email, value } of ok) {
    found.push(...(value[key] || []).map(row => ({ account: email, ...row })));
    if (value.nextPageToken) nextTokens[email] = value.nextPageToken;
    if (value.unavailable)   unavailable[email] = value.unavailable;
  }

  if (dateField) found.sort((a, b) => new Date(b[dateField] || 0) - new Date(a[dateField] || 0));

  if (!found.length && failed.length) throw new Error(`All accounts failed — ${failed.join('; ')}`);

  return {
    searched: targets,
    ...(failed.length ? { errors: failed } : {}),
    ...(Object.keys(nextTokens).length ? { next_page_token: nextTokens } : {}),
    ...(Object.keys(unavailable).length && unavailableKey ? { [unavailableKey]: unavailable } : {}),
    count: found.length,
    [key]: found,
  };
}

/** Exactly one of message_id / thread_id, so a tool can act on either level. */
function oneTarget(args) {
  if (args.message_id && args.thread_id) throw new Error('Pass message_id OR thread_id, not both.');
  if (!args.message_id && !args.thread_id) throw new Error('Pass message_id or thread_id.');
  return args.message_id ? { kind: 'message', id: args.message_id } : { kind: 'thread', id: args.thread_id };
}

const ACCOUNT_PROP = { account: { type: 'string', description: 'Account holding the item. May be omitted when only one account is linked.' } };

const SEARCH_PROPS = {
  account:     { type: 'string', description: 'Account to search. Omit to search all linked accounts.' },
  max_results: { type: 'number', description: 'Max results per account (1-50, default 10).' },
  page_token:  { type: 'string', description: 'Continue a previous search. Requires `account`.' },
};

/** page_token is per-account, so it is meaningless without one. */
function checkPageToken(args) {
  if (args.page_token && !args.account) {
    throw new Error('page_token requires `account` — pagination is per-account.');
  }
}

module.exports = {
  text, resolveAccount, tokenFor, fanOut, mergeSearch, oneTarget,
  mailboxesFor, mailFor, fanOutMail, providerName, pick,
  ACCOUNT_PROP, SEARCH_PROPS, checkPageToken,
};
