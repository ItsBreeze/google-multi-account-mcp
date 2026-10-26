/**
 * Send-as aliases: pick and validate the From address for an outgoing message.
 *
 * With no `from` and no `fromName` the From header is the bare mailbox
 * address, exactly as before. A `from` must be the mailbox itself or one of
 * its Gmail send-as aliases with verificationStatus "accepted"
 * (users.settings.sendAs.list — readable under gmail.modify). AOL mailboxes
 * have no aliases here, so only their own address is accepted.
 */

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** RFC 5322 display-name: quoted string when ASCII, RFC 2047 B-encoded word otherwise. */
function encodeDisplayName(name) {
  if (/^[\x20-\x7E]*$/.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}"`;
  return `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`;
}

/** Build the From header value: `"Name" <addr>`, or the bare address with no name. */
function formatFrom(address, name) {
  if (/[\r\n]/.test(address) || (name && /[\r\n]/.test(name))) throw new Error('`from` / `fromName` must not contain line breaks.');
  const n = (name || '').trim();
  return n ? `${encodeDisplayName(n)} <${address}>` : address;
}

/** Verified send-as identities for a Gmail mailbox: [{ email, displayName, isPrimary }]. */
async function listVerified(listSendAs) {
  const rows = await listSendAs();
  return rows
    .filter(r => r.isPrimary || r.verificationStatus === 'accepted')
    .map(r => ({ email: r.sendAsEmail, displayName: r.displayName || '', isPrimary: !!r.isPrimary }));
}

/**
 * Resolve the From header for a send.
 *   mailbox   — the linked account's address
 *   from      — optional alias address
 *   fromName  — optional display name
 *   listSendAs — async () => raw sendAs rows (Gmail only; omit for IMAP)
 * Returns { header, address }.
 */
async function resolveFrom({ mailbox, from, fromName, listSendAs }) {
  if (fromName != null && typeof fromName !== 'string') throw new Error('`fromName` must be a string.');
  if (from == null || from === '') {
    // Unchanged default: bare mailbox address, unless a display name is asked for.
    return { header: fromName ? formatFrom(mailbox, fromName) : mailbox, address: mailbox };
  }
  if (typeof from !== 'string' || !EMAIL_RE.test(from.trim())) {
    throw new Error(`\`from\` must be a plain email address (e.g. support@example.com), got "${from}". Put the display name in \`fromName\`.`);
  }
  const wanted = from.trim().toLowerCase();
  if (wanted === mailbox.toLowerCase()) return { header: formatFrom(mailbox, fromName), address: mailbox };

  if (!listSendAs) {
    throw new Error(`"${from}" is not ${mailbox}. This mailbox has no send-as aliases here, so it can only send as itself.`);
  }
  let verified;
  try {
    verified = await listVerified(listSendAs);
  } catch (e) {
    throw new Error(`Could not list send-as aliases for ${mailbox} to check "${from}": ${e.message}`);
  }
  const hit = verified.find(v => v.email.toLowerCase() === wanted);
  if (!hit) {
    const allowed = verified.map(v => v.email).join(', ') || mailbox;
    throw new Error(`"${from}" is not a verified send-as address for ${mailbox}. Allowed: ${allowed}. ` +
      'Add and verify it in Gmail → Settings → Accounts → "Send mail as" first.');
  }
  return { header: formatFrom(hit.email, fromName || hit.displayName), address: hit.email };
}

/** Replace (or insert) the From header in a raw RFC 5322 message string. */
function replaceFromHeader(raw, fromValue) {
  const split = raw.search(/\r?\n\r?\n/);
  const head  = split === -1 ? raw : raw.slice(0, split);
  const rest  = split === -1 ? '' : raw.slice(split);
  const eol   = head.includes('\r\n') ? '\r\n' : '\n';
  const lines = head.split(/\r?\n/);
  const out = [];
  let replaced = false, skipping = false;
  for (const line of lines) {
    if (skipping && /^[ \t]/.test(line)) continue;
    skipping = false;
    if (/^from:/i.test(line)) {
      if (!replaced) out.push(`From: ${fromValue}`);
      replaced = true; skipping = true;
      continue;
    }
    out.push(line);
  }
  if (!replaced) out.unshift(`From: ${fromValue}`);
  return out.join(eol) + rest;
}

module.exports = { resolveFrom, formatFrom, encodeDisplayName, replaceFromHeader, listVerified, EMAIL_RE };
