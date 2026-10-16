/**
 * AOL over IMAP/SMTP: query translation, and the client driven against a
 * scripted mailbox.
 *   npm run test:imap
 *
 * No network and no database. The fake server records every command it is
 * sent, so what is asserted is the wire: which folder was opened read-only,
 * which criteria were searched, what was moved where, what went over SMTP —
 * and above all that nothing outside Drafts is ever expunged.
 */

process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || require('crypto').randomBytes(32).toString('base64');

const imapQuery = require('../src/services/imap_query');
const imap      = require('../src/services/imap_api');
const gmailApi  = require('../src/services/gmail_api');

let fail = 0;
const check = (name, cond, extra = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
};
const throwsWith = async (name, fn, needle) => {
  try { await fn(); check(name, false, 'did not throw'); }
  catch (err) { check(name, needle instanceof RegExp ? needle.test(err.message) : err.message.includes(needle), err.message); }
};

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

// ─── 1. Gmail syntax → IMAP criteria ────────────────────────────────────────

(async () => {
  const c = (q) => imapQuery.compile(q, { now: NOW });

  const basic = c('from:ann is:unread newer_than:7d');
  check('operators map to IMAP keys',
    basic.criteria.from === 'ann' && basic.criteria.seen === false &&
    basic.criteria.since.getTime() === NOW - 7 * DAY, JSON.stringify(basic.criteria));

  const twice = c('from:a from:b');
  check('a repeated operator survives the key collision as NOT NOT (…)',
    twice.criteria.from === 'a' && twice.criteria.not?.not?.from === 'b', JSON.stringify(twice.criteria));

  const neg = c('-from:spam subject:"quarterly report"');
  check('negation and quoted values',
    neg.criteria.not?.from === 'spam' && neg.criteria.subject === 'quarterly report', JSON.stringify(neg.criteria));

  const or = c('from:a OR from:b');
  check('OR becomes an IMAP OR', or.criteria.or?.length === 2 && or.criteria.or[1].from === 'b', JSON.stringify(or.criteria));

  const grouped = c('(from:a OR from:b) subject:x');
  check('parentheses group', grouped.criteria.or?.length === 2 && grouped.criteria.subject === 'x', JSON.stringify(grouped.criteria));

  const folder = c('in:sent invoice');
  check('in: selects a folder instead of searching',
    folder.folders.include[0].special === '\\Sent' && folder.criteria.text === 'invoice', JSON.stringify(folder));
  check('-in: excludes a folder', c('-in:inbox').folders.exclude[0].special === '\\Inbox');
  check('label: names a folder', c('label:Receipts').folders.include[0].name === 'Receipts');
  check('has:attachment is a post-filter', c('has:attachment').hasAttachment === true);
  check('-has:attachment is its inverse', c('-has:attachment').hasAttachment === false);
  check('a phrase with a colon is text, not an operator', c('"re: invoice"').criteria.text === 're: invoice');
  check('a URL is text', c('http://example.com').criteria.text === 'http://example.com', JSON.stringify(c('http://example.com').criteria));
  check('an empty query matches everything', c('').criteria.all === true);
  check('after: is an absolute date', c('after:2026/01/02').criteria.since.getTime() === Date.UTC(2026, 0, 2));
  check('sizes parse', c('larger:10M').criteria.larger === 10 * 1024 * 1024);
  check('relative months', c('older_than:1m').criteria.before.getUTCMonth() === 8);

  await throwsWith('category: is refused by name, not dropped', () => c('category:promotions'), 'category:');
  await throwsWith('is:important is refused', () => c('is:important'), 'is:important');
  await throwsWith('grouped operator values are refused with the alternative', () => c('from:(a b)'), 'from:a OR from:b');
  await throwsWith('in: inside OR is refused', () => c('from:a OR in:sent'), 'whole query');
  await throwsWith('an unclosed quote is refused', () => c('subject:"oops'), 'unclosed quote');
  await throwsWith('an unclosed paren is refused', () => c('(from:a'), 'unclosed');

  // ─── 2. A scripted mailbox ──────────────────────────────────────────────

  const server = makeServer();
  // One scripted server per mailbox address, so a second one can behave like AOL.
  const servers = { 'me@aol.com': server };
  imap._internal.setFactories({
    imap: (opts) => new FakeImap(servers[opts.auth.user] || server, opts),
    smtp: (opts) => fakeSmtp(servers[opts.auth.user] || server, opts),
  });
  imap._internal.setSentCopyWaits([0]);

  const ME   = 'me@aol.com';
  const cred = { email: ME, password: 'apppass', provider: 'aol' };

  const original = server.add('INBOX', {
    from: 'Ann <ann@example.com>', to: ME, subject: 'Roof quote', date: new Date(NOW - 3 * DAY),
    body: 'Here is the roof quote you asked for.', messageId: '<orig@example.com>',
    attachment: { filename: 'quote.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4 fake') },
  });
  server.add('Sent', {
    from: ME, to: 'Ann <ann@example.com>', subject: 'Re: Roof quote', date: new Date(NOW - 2 * DAY),
    body: 'Thanks Ann, looks good.', messageId: '<reply@aol.com>',
    inReplyTo: '<orig@example.com>', references: '<orig@example.com>', flags: ['\\Seen'],
  });
  server.add('INBOX', { from: 'Bob <bob@example.com>', to: ME, subject: 'Lunch', date: new Date(NOW - 1 * DAY), body: 'Lunch friday?', messageId: '<lunch@example.com>' });
  server.add('Archive', { from: 'Ann <ann@example.com>', to: ME, subject: 'Old note', date: new Date(NOW - 10 * DAY), body: 'An old note.', messageId: '<old@example.com>', flags: ['\\Seen'] });
  server.add('Trash', { from: 'Ann <ann@example.com>', to: ME, subject: 'Trashed', date: new Date(NOW - 4 * DAY), body: 'Gone.', messageId: '<trashed@example.com>' });
  server.add('Bulk', { from: 'Ann <ann@example.com>', to: ME, subject: 'Spammy', date: new Date(NOW - 5 * DAY), body: 'Win.', messageId: '<spam@example.com>' });

  // ── Search ──
  server.log.length = 0;
  const all = await imap.searchMessages(cred, { query: 'from:ann', maxResults: 10 });
  const subjects = all.messages.map(m => m.subject);
  check('default scope skips Trash and Spam, like Gmail',
    subjects.includes('Roof quote') && subjects.includes('Old note') && !subjects.includes('Trashed') && !subjects.includes('Spammy'),
    subjects.join(' | '));
  check('the criteria went over the wire', server.log.some(e => e[0] === 'search' && e[2].from === 'ann'));
  check('searching opens folders read-only', server.log.filter(e => e[0] === 'select').every(e => e[2] === true));
  check('newest first across folders', subjects[0] === 'Roof quote' && subjects[subjects.length - 1] === 'Old note', subjects.join(' | '));
  const roof = all.messages.find(m => m.subject === 'Roof quote');
  check('snippet is decoded from the body part', roof.snippet === 'Here is the roof quote you asked for.', roof.snippet);
  check('labels carry folder and unread', roof.labels.includes('INBOX') && roof.labels.includes('UNREAD') && roof.unread);

  const sentOnly = await imap.searchMessages(cred, { query: 'in:sent' });
  check('in:sent searches Sent only', sentOnly.messages.length === 1 && sentOnly.messages[0].subject === 'Re: Roof quote');

  const withAtt = await imap.searchMessages(cred, { query: 'has:attachment' });
  check('has:attachment checks body structure', withAtt.messages.length === 1 && withAtt.messages[0].subject === 'Roof quote',
    withAtt.messages.map(m => m.subject).join(' | '));

  // Paging across folders: every message once, none skipped.
  const seen = [];
  let token;
  let pages = 0;
  do {
    const page = await imap.searchMessages(cred, { query: '', maxResults: 2, pageToken: token });
    seen.push(...page.messages.map(m => m.subject));
    token = page.nextPageToken;
    pages++;
  } while (token && pages < 10);
  check('paging covers every searched message exactly once',
    seen.length === 4 && new Set(seen).size === 4, `${pages} pages: ${seen.join(' | ')}`);

  await throwsWith('a page token from elsewhere is refused', () => imap.searchMessages(cred, { query: '', pageToken: '%%%' }), 'page_token');

  // ── Read ──
  server.log.length = 0;
  const full = await imap.getMessage(cred, roof.id);
  check('body text comes back', full.body.includes('roof quote you asked for'), full.body);
  check('attachments are listed', full.attachments.length === 1 && full.attachments[0].filename === 'quote.pdf');
  check('reading never sets a flag', !server.log.some(e => e[0] === 'flagsAdd' || e[0] === 'flagsRemove'));
  check('reading opens the folder read-only', server.log.filter(e => e[0] === 'select').every(e => e[2] === true));

  const att = await imap.getAttachment(cred, roof.id, '1');
  check('attachment bytes and type', att.data.toString() === '%PDF-1.4 fake' && att.mime_type === 'application/pdf');

  const stale = JSON.parse(Buffer.from(roof.id.slice(3), 'base64url').toString());
  stale[1] = '999';
  await throwsWith('a renumbered folder makes the id stale, not wrong',
    () => imap.getMessage(cred, `a1.${Buffer.from(JSON.stringify(stale)).toString('base64url')}`), 'stale');
  await throwsWith('a Gmail id is refused for an AOL mailbox', () => imap.getMessage(cred, '18c2f0a1b2c3d4e5'), 'not a message id');

  // ── Threads ──
  const threads = await imap.searchThreads(cred, { query: 'subject:roof' });
  const t = threads.threads[0];
  check('original and reply are one thread', threads.threads.length === 1 && t.message_count === 2,
    JSON.stringify(threads.threads.map(x => [x.subject, x.message_count])));
  check('thread participants are collected', t.participants.length === 2, t.participants.join(' | '));
  check('thread starts at the original', t.subject === 'Roof quote' && t.last_from === ME, `${t.subject} / ${t.last_from}`);

  const whole = await imap.getThread(cred, t.id);
  check('get_thread returns both, oldest first',
    whole.messages.length === 2 && whole.messages[1].subject === 'Re: Roof quote');

  // ── Send ──
  server.smtp.length = 0;
  const sent = await imap.sendMessage(cred, { from: ME, to: 'ann@example.com', cc: 'Cee <cee@example.com>', bcc: 'secret@example.com', subject: 'Hello', body: 'Hi there' });
  const wire = server.smtp[0];
  check('Bcc is on the SMTP envelope', wire.envelope.to.includes('secret@example.com') && wire.envelope.to.length === 3, wire.envelope.to.join(','));
  check('Bcc is NOT in the transmitted message', !/^bcc:/im.test(wire.raw), wire.raw.split('\r\n\r\n')[0]);
  check('Date and Message-ID are stamped', /^Date: /m.test(wire.raw) && /^Message-ID: <[^>]+@aol\.com>/m.test(wire.raw));
  const sentCopy = server.folders.Sent.messages.find(m => m.subject === 'Hello');
  check('a Sent copy is kept, with Bcc visible to the sender', sentCopy && /^Bcc: secret@example\.com/m.test(sentCopy.raw));
  check('the sent result names the Sent copy', sent.id && sent.sent_copy === 'appended', JSON.stringify(sent));

  server.autoSaveSent = true;
  const before = server.folders.Sent.messages.length;
  const sent2 = await imap.sendMessage(cred, { from: ME, to: 'ann@example.com', subject: 'Second', body: 'x' });
  check('a server that files its own Sent copy gets no duplicate',
    server.folders.Sent.messages.length === before + 1 && sent2.sent_copy === 'by the server', JSON.stringify(sent2));
  server.autoSaveSent = false;

  const ctx = await imap.getReplyContext(cred, roof.id);
  check('reply context threads to the original', ctx.messageId === '<orig@example.com>' && ctx.subject === 'Re: Roof quote');
  const reply = await imap.sendMessage(cred, { from: ME, to: ctx.from, subject: ctx.subject, body: 'ok', inReplyTo: ctx.messageId, references: ctx.messageId });
  check('the reply carries In-Reply-To', /^In-Reply-To: <orig@example\.com>/m.test(server.smtp.at(-1).raw));
  check('the reply joins the original thread', reply.threadId === t.id, `${reply.threadId} vs ${t.id}`);

  const fwd = await imap.forwardMessage(cred, { from: ME, messageId: roof.id, to: 'dee@example.com' });
  check('forward carries the attachment', /quote\.pdf/.test(server.smtp.at(-1).raw) && fwd.skippedAttachments.length === 0);

  // ── Labels → flags and folders ──
  const lunch = (await imap.searchMessages(cred, { query: 'subject:lunch' })).messages[0];
  const starred = await imap.modifyLabels(cred, lunch.id, { add: ['STARRED'], remove: ['UNREAD'] });
  const lunchRow = server.folders.INBOX.messages.find(m => m.subject === 'Lunch');
  check('STARRED and UNREAD map to flags', lunchRow.flags.has('\\Flagged') && lunchRow.flags.has('\\Seen'));
  check('a flag change keeps the id', starred.id === lunch.id && !starred.moved_to);

  const archived = await imap.modifyLabels(cred, lunch.id, { remove: ['INBOX'] });
  check('removing INBOX archives', archived.moved_to === 'Archive' && server.folders.Archive.messages.some(m => m.subject === 'Lunch'));
  check('a move returns the new id', archived.id && archived.id !== lunch.id);
  await throwsWith('the old id no longer resolves', () => imap.getMessage(cred, lunch.id), 'no longer in that folder');

  await throwsWith('two folders at once is refused', () => imap.modifyLabels(cred, archived.id, { add: ['INBOX', 'Receipts'] }), 'one folder');
  await throwsWith('IMPORTANT is refused by name', () => imap.modifyLabels(cred, archived.id, { add: ['IMPORTANT'] }), 'IMPORTANT');

  const filed = await imap.modifyLabels(cred, archived.id, { add: ['Receipts'] });
  check('a folder label moves it there', filed.moved_to === 'Receipts');

  const trashed = await imap.trashMessage(cred, filed.id);
  check('trash moves to Trash', trashed.moved_to === 'Trash');
  const restored = await imap.untrashMessage(cred, trashed.id);
  check('untrash restores someone else\'s mail to the inbox', restored.moved_to === 'INBOX');

  const mine = (await imap.searchMessages(cred, { query: 'in:sent subject:Hello' })).messages[0];
  const mineTrashed = await imap.trashMessage(cred, mine.id);
  const mineBack = await imap.untrashMessage(cred, mineTrashed.id);
  check('untrash restores your own mail to Sent', mineBack.moved_to === 'Sent');

  const spam = await imap.modifyLabels(cred, restored.id, { add: ['SPAM'], remove: ['INBOX'] });
  check('mark_spam moves to the junk folder', spam.moved_to === 'Bulk');
  const unspam = await imap.modifyLabels(cred, spam.id, { add: ['INBOX'], remove: ['SPAM'] });
  check('unmark returns it to the inbox', unspam.moved_to === 'INBOX');

  const threadTrash = await imap.trashThread(cred, t.id);
  // Original, the seeded reply, and the reply sent above.
  check('trashing a thread moves every message in it', threadTrash.messages === 3 &&
    server.folders.Trash.messages.filter(m => /^Re: Roof quote$|^Roof quote$/.test(m.subject)).length === 3,
    String(threadTrash.messages));
  await imap.untrashThread(cred, t.id);
  check('untrashing the thread puts each message back where it belongs',
    server.folders.INBOX.messages.some(m => m.subject === 'Roof quote') &&
    server.folders.Sent.messages.some(m => m.subject === 'Re: Roof quote'));

  // ── Folders ──
  const labels = await imap.listLabels(cred);
  check('system labels map onto special folders', labels.some(l => l.id === 'SPAM' && l.folder === 'Bulk'));
  check('user folders are listed as labels', labels.some(l => l.id === 'Receipts' && l.type === 'user'));

  await imap.createLabel(cred, 'Work/Invoices');
  check('nested labels use the server delimiter', 'Work.Invoices' in server.folders, Object.keys(server.folders).join(','));
  server.add('Receipts', { from: 'Shop <shop@example.com>', to: ME, subject: 'Receipt', date: new Date(NOW), body: 'Paid.', messageId: '<rcpt@example.com>' });
  await throwsWith('a folder with mail cannot be deleted', () => imap.deleteLabel(cred, 'Receipts'), /holds 1 message/);
  check('and nothing was deleted trying', 'Receipts' in server.folders && !server.log.some(e => e[0] === 'mailboxDelete' && e[1] === 'Receipts'));
  await throwsWith('a system folder cannot be deleted', () => imap.deleteLabel(cred, 'Bulk'), 'system folder');
  await imap.deleteLabel(cred, 'Work.Invoices');
  check('an empty folder can be deleted', !('Work.Invoices' in server.folders));

  // ── Drafts ──
  const draft = await imap.createDraft(cred, { from: ME, to: 'ann@example.com', bcc: 'b@example.com', subject: 'Draft one', body: 'first' });
  const draftRow = server.folders.Draft.messages.at(-1);
  check('a draft is saved to Drafts flagged \\Draft', draftRow.flags.has('\\Draft') && draftRow.subject === 'Draft one');
  check('a draft keeps its Bcc', /^Bcc: b@example\.com/m.test(draftRow.raw));

  const listed = await imap.listDrafts(cred);
  check('drafts are listed', listed.some(d => d.draft_id === draft.draft_id && d.subject === 'Draft one'));

  const replyDraft = await imap.createDraft(cred, { from: ME, to: 'ann@example.com', subject: 'Re: Roof quote', body: 'draft reply', inReplyTo: '<orig@example.com>', references: '<orig@example.com>' });
  const updated = await imap.updateDraft(cred, replyDraft.draft_id, { from: ME, to: 'ann@example.com', subject: 'Re: Roof quote', body: 'better reply' });
  const updatedRow = server.folders.Draft.messages.find(m => /better reply/.test(m.bodyText));
  check('an updated reply-draft stays a reply', updatedRow && /^In-Reply-To: <orig@example\.com>/m.test(updatedRow.raw));
  check('the old version is gone and the id changed',
    updated.draft_id !== replyDraft.draft_id && !server.folders.Draft.messages.some(m => /draft reply/.test(m.bodyText)));

  server.smtp.length = 0;
  const sentDraft = await imap.sendDraft(cred, draft.draft_id);
  check('send_draft strips Bcc from the wire', !/^bcc:/im.test(server.smtp[0].raw) && server.smtp[0].envelope.to.includes('b@example.com'));
  check('send_draft removes the draft', !server.folders.Draft.messages.some(m => m.subject === 'Draft one'));
  check('send_draft keeps a Sent copy', sentDraft.id && server.folders.Sent.messages.some(m => m.subject === 'Draft one'));

  await throwsWith('delete_draft refuses a message that is not in Drafts',
    async () => imap.deleteDraft(cred, (await imap.searchMessages(cred, { query: 'subject:lunch' })).messages[0].id), 'not a draft');

  const doomed = await imap.createDraft(cred, { from: ME, to: 'x@example.com', subject: 'Doomed', body: 'x' });
  await imap.deleteDraft(cred, doomed.draft_id);
  check('delete_draft deletes exactly that draft', !server.folders.Draft.messages.some(m => m.subject === 'Doomed'));

  // The guarantee that replaces Gmail's scope: nothing outside Drafts is ever expunged.
  const deletions = server.log.filter(e => e[0] === 'delete');
  check('every expunge was a single draft, in Drafts',
    deletions.length > 0 && deletions.every(e => e[1] === 'Draft' && /^\d+$/.test(e[2])), JSON.stringify(deletions));

  server.caps.delete('UIDPLUS');
  const doomed2 = await imap.createDraft(cred, { from: ME, to: 'x@example.com', subject: 'Doomed two', body: 'x' });
  const deletesBefore = server.log.filter(e => e[0] === 'delete').length;
  const res2 = await imap.deleteDraft(cred, doomed2.draft_id);
  check('without UID EXPUNGE a draft goes to Trash instead',
    res2.status === 'moved to trash' && server.log.filter(e => e[0] === 'delete').length === deletesBefore);

  server.caps.delete('MOVE');
  const victim = (await imap.searchMessages(cred, { query: 'subject:lunch' })).messages[0];
  await throwsWith('a server without MOVE or UIDPLUS cannot move', () => imap.trashMessage(cred, victim.id), 'refusing');
  server.caps.add('MOVE'); server.caps.add('UIDPLUS');

  // ── Sign-in failures ──
  const bad = { ...cred, password: 'wrong-secret-xyz' };
  let authMsg = '';
  try { await imap.searchMessages(bad, { query: '' }); } catch (e) { authMsg = e.message; }
  check('a refused app password says what to do', /app password/.test(authMsg) && /login\.aol\.com/.test(authMsg), authMsg);
  check('the password never appears in an error', !authMsg.includes('wrong-secret-xyz'));
  let smtpMsg = '';
  try { await imap.verify(bad); } catch (e) { smtpMsg = e.message; }
  check('verify refuses a bad password before anything is stored', /refused the app password/.test(smtpMsg), smtpMsg);
  check('connection options never log', imap._internal.imapOptions(cred).logger === false && imap._internal.smtpOptions(cred).logger === false);
  check('hosts come from the preset, not the caller',
    imap._internal.imapOptions({ ...cred, host: 'evil.example' }).host === 'imap.aol.com');

  // ─── 2b. AOL as measured: THREADID, but no References search ─────────────

  const aol = makeServer();
  aol.caps.add('OBJECTID');
  aol.aolQuirks = true;
  aol.password = 'apppass2';
  servers['me2@aol.com'] = aol;
  const aolCred = { email: 'me2@aol.com', password: 'apppass2', provider: 'aol' };
  const ME2 = 'me2@aol.com';

  aol.add('INBOX', { from: 'Ann <ann@example.com>', to: ME2, subject: 'Invoice 42', date: new Date(NOW - 3 * DAY), body: 'Invoice coming.', messageId: '<inv@example.com>' });
  aol.add('Sent', { from: ME2, to: 'ann@example.com', subject: 'Re: Invoice 42', date: new Date(NOW - 2 * DAY), body: 'Thanks.', messageId: '<inv-re@aol.com>', inReplyTo: '<inv@example.com>', references: '<inv@example.com>', flags: ['\\Seen'] });
  aol.add('INBOX', { from: 'Ann <ann@example.com>', to: ME2, subject: 'Re: Invoice 42', date: new Date(NOW - 1 * DAY), body: 'Here it is.', messageId: '<inv-re2@example.com>', inReplyTo: '<inv-re@aol.com>', references: '<inv@example.com> <inv-re@aol.com>' });

  // HTML mail whose first kilobytes are <head> and CSS, as most marketing mail is.
  const htmlMail = (id, cssRepeat, body) => [
    'From: Shop <shop@example.com>', `To: ${ME2}`, `Subject: Sale ${id}`, `Date: ${new Date(NOW).toUTCString()}`,
    `Message-ID: <sale-${id}@example.com>`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 7bit', '',
    `<html><head><title>Shop</title><style>${'.x{color:red}'.repeat(cssRepeat)}</style></head><body><p>${body}</p></body></html>`,
  ].join('\r\n');
  aol.store('INBOX', htmlMail('a', 400, 'Hello there, 40% off.'), [], new Date(NOW));
  aol.store('INBOX', htmlMail('b', 1500, 'Never reached.'), [], new Date(NOW));

  aol.log.length = 0;
  const aolThreads = await imap.searchThreads(aolCred, { query: 'subject:invoice' });
  check('on AOL a thread is gathered by THREADID across Inbox and Sent',
    aolThreads.threads.length === 1 && aolThreads.threads[0].message_count === 3,
    JSON.stringify(aolThreads.threads.map(x => [x.subject, x.message_count])));
  check('…without searching References or In-Reply-To, which AOL cannot answer',
    !aol.log.some(e => e[0] === 'search' && /"references"|"in-reply-to"/.test(JSON.stringify(e[2]))));
  check('…by reading THREADID off each folder\'s recent window', aol.log.some(e => e[0] === 'window'));

  const aolWhole = await imap.getThread(aolCred, aolThreads.threads[0].id);
  check('get_thread on AOL returns all three, oldest first',
    aolWhole.messages.length === 3 && aolWhole.messages[0].subject === 'Invoice 42',
    aolWhole.messages.map(m => m.subject).join(' | '));

  const saleA = (await imap.searchMessages(aolCred, { query: 'subject:"sale a"' })).messages[0];
  check('an HTML preview skips <head> and CSS', saleA.snippet === 'Hello there, 40% off.', JSON.stringify(saleA.snippet));
  const saleB = (await imap.searchMessages(aolCred, { query: 'subject:"sale b"' })).messages[0];
  check('a preview cut off inside <style> is empty, not CSS', saleB.snippet === '', JSON.stringify(saleB.snippet));

  const newest = (await imap.searchMessages(aolCred, { query: 'in:inbox subject:invoice' })).messages[0];
  const ctx2   = await imap.getReplyContext(aolCred, newest.id);
  const reply2 = await imap.sendMessage(aolCred, {
    from: ME2, to: ctx2.from, subject: ctx2.subject, body: 'ok',
    inReplyTo: ctx2.messageId, references: ctx2.messageId, threadId: ctx2.threadId,
  });
  check('a reply on AOL reports the original\'s thread id', reply2.threadId === aolThreads.threads[0].id,
    `${reply2.threadId} vs ${aolThreads.threads[0].id}`);

  // ─── 3. One interface for both providers ──────────────────────────────────

  const shared       = require('../src/mcp/shared');
  const accounts     = require('../src/services/gmail_accounts');
  const imapAccounts = require('../src/services/imap_accounts');

  accounts.emailsFor          = async () => ['me@gmail.com', 'dual@aol.com'];
  accounts.accessTokenFor     = async (_o, email) => `token-${email}`;
  imapAccounts.emailsFor      = async () => [{ email: 'dual@aol.com', provider: 'aol' }, { email: 'me@aol.com', provider: 'aol' }];
  imapAccounts.credentialsFor = async (_o, email) => ({ email, provider: 'aol', password: 'p' });

  const boxes = await shared.mailboxesFor('o');
  check('mailboxes merge Google and AOL', boxes.length === 3, JSON.stringify(boxes));
  check('an address linked both ways is the IMAP mailbox for mail',
    boxes.find(b => b.email === 'dual@aol.com').provider === 'aol');

  const fanned = await shared.fanOutMail('o', undefined, async (api, handle, email) => ({ api, handle, email }));
  check('a mail fan-out reaches every mailbox', fanned.ok.length === 3 && !fanned.failed.length);
  check('each mailbox gets its own client',
    fanned.ok.find(r => r.email === 'me@gmail.com').value.api === gmailApi &&
    fanned.ok.find(r => r.email === 'me@aol.com').value.api === imap &&
    fanned.ok.find(r => r.email === 'me@aol.com').value.handle.password === 'p');

  const one = await shared.mailFor('o', 'me@aol');
  check('naming a mailbox picks it', one.email === 'me@aol.com' && one.provider === 'aol');

  accounts.emailsFor = async () => ['me@gmail.com'];
  await throwsWith('a Google-only tool explains that an AOL mailbox is mail only',
    () => shared.resolveAccount('o', 'me@aol.com'), 'mail only');
  accounts.emailsFor = async () => [];
  await throwsWith('a Google fan-out with only AOL linked says why',
    () => shared.fanOut('o', undefined, 'calendar', async () => 1), 'need a Google account');

  // ─── The SMTP relay: Railway can't reach SMTP, so a send goes over HTTPS ─

  process.env.SMTP_RELAY_URL = 'https://relay.test/';
  process.env.SMTP_RELAY_TOKEN = 'tok';
  const posted = [];
  let relayAnswer = { status: 200, body: { ok: true } };
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    posted.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(relayAnswer.body), { status: relayAnswer.status });
  };
  imap._internal.setFactories({ smtp: imap._internal.relayTransport });

  await imap.sendMessage(cred, { to: 'Ann <ann@example.com>', bcc: 'secret@example.com', subject: 'Via relay', body: 'hi' });
  const relayed = posted[0];
  check('the relay is sent the preset host, not one from the caller', relayed.body.host === 'smtp.aol.com' && relayed.body.port === 465);
  check('the relay call carries its token', relayed.url === 'https://relay.test/' && relayed.init.headers.authorization === 'Bearer tok');
  check('Bcc rides the relay envelope, not the header',
    relayed.body.to.includes('secret@example.com') && !/^bcc:/im.test(relayed.body.raw), relayed.body.to.join(','));

  relayAnswer = { status: 502, body: { error: 'SMTP AUTH: 535 5.7.0 (#AUTH005) Too many bad auth attempts.', code: 535 } };
  await throwsWith('a relayed 535 reads as a refused app password',
    () => imap.sendMessage(cred, { to: 'ann@example.com', subject: 'x', body: 'x' }), 'refused the app password');
  relayAnswer = { status: 401, body: { error: 'unauthorized' } };
  await throwsWith('a relay refusal is reported, not swallowed',
    () => imap.sendMessage(cred, { to: 'ann@example.com', subject: 'x', body: 'x' }), 'unauthorized');
  global.fetch = realFetch;

  console.log(fail ? `\n${fail} FAILED` : '\nimap mail correct');
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('Test harness error:', err); process.exit(1); });

// ─── The fake server ────────────────────────────────────────────────────────

function makeServer() {
  const folder = (path, specialUse, uidValidity) => ({ path, specialUse, uidValidity: BigInt(uidValidity), next: 1, messages: [] });
  const server = {
    password: 'apppass',
    caps: new Set(['MOVE', 'UIDPLUS', 'IMAP4rev1']),
    folders: {
      INBOX:   folder('INBOX', '\\Inbox', 101),
      Sent:    folder('Sent', '\\Sent', 102),
      Draft:   folder('Draft', '\\Drafts', 103),
      Trash:   folder('Trash', '\\Trash', 104),
      Bulk:    folder('Bulk', '\\Junk', 105),
      Archive: folder('Archive', '\\Archive', 106),
      Receipts: folder('Receipts', undefined, 107),
    },
    log: [],
    smtp: [],
    autoSaveSent: false,

    add(path, spec) {
      const raw = gmailApi.buildRawMime({
        from: spec.from, to: spec.to, subject: spec.subject, body: spec.body,
        inReplyTo: spec.inReplyTo, references: spec.references,
        attachments: spec.attachment ? [spec.attachment] : undefined,
        date: spec.date, messageId: spec.messageId,
      });
      return this.store(path, raw, spec.flags || [], spec.date);
    },

    /** Index a raw message the way a server would: envelope, structure, parts. */
    store(path, raw, flags, date) {
      const f = this.folders[path];
      const msg = describe(String(raw));
      msg.uid = f.next++;
      msg.flags = new Set(flags);
      msg.internalDate = date || msg.date || new Date(NOW);
      f.messages.push(msg);
      return msg;
    },
  };
  return server;
}

function describe(raw) {
  const split  = raw.indexOf('\r\n\r\n');
  const head   = raw.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  const body   = raw.slice(split + 4);
  const header = (name) => (new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(head) || [])[1] || '';
  const addr   = (value) => gmailApi.parseAddresses(value).map((e) => {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(e);
    return m ? { name: m[1].replace(/"/g, ''), address: m[2] } : { address: e };
  });

  const boundary = /boundary="([^"]+)"/.exec(head)?.[1];
  let structure;
  let parts;
  let bodyText;
  if (boundary) {
    const chunks = body.split(`--${boundary}`).slice(1, -1).map(c => c.replace(/^\r\n/, ''));
    parts = {};
    structure = { type: 'multipart/mixed', childNodes: [] };
    chunks.forEach((chunk, i) => {
      const at = chunk.indexOf('\r\n\r\n');
      const ph = chunk.slice(0, at);
      const pb = chunk.slice(at + 4).replace(/\r\n$/, '');
      const type = /Content-Type: ([^;\r\n]+)/i.exec(ph)[1].toLowerCase();
      const filename = /filename="([^"]+)"/i.exec(ph)?.[1];
      const node = { part: String(i + 1), type, encoding: 'base64', parameters: { charset: 'utf-8' } };
      if (filename) Object.assign(node, { disposition: 'attachment', dispositionParameters: { filename } });
      structure.childNodes.push(node);
      parts[String(i + 1)] = Buffer.from(pb);
      if (!filename && type === 'text/plain') bodyText = Buffer.from(pb, 'base64').toString('utf8');
    });
  } else {
    const type     = (header('Content-Type').split(';')[0] || 'text/plain').trim().toLowerCase();
    const encoding = (header('Content-Transfer-Encoding') || '7bit').trim().toLowerCase();
    structure = { type, encoding, parameters: { charset: 'utf-8' } };
    parts = { 1: Buffer.from(body) };
    bodyText = encoding === 'base64' ? Buffer.from(body, 'base64').toString('utf8') : body;
  }

  // What an OBJECTID server reports: one id per conversation, in every folder.
  const refs = (header('References').match(/<[^>]+>/g) || []);
  const rootId = refs[0] || header('In-Reply-To') || header('Message-ID') || raw.length;
  const threadId = `T${require('crypto').createHash('sha1').update(String(rootId)).digest('hex').slice(0, 8)}`;

  const date = header('Date') ? new Date(header('Date')) : null;
  return {
    raw, head, bodyText, structure, parts, date, threadId,
    subject: header('Subject'),
    envelope: {
      date, subject: header('Subject'), messageId: header('Message-ID') || undefined,
      inReplyTo: header('In-Reply-To') || undefined,
      from: addr(header('From')), to: addr(header('To')), cc: addr(header('Cc')),
    },
  };
}

function matches(msg, crit, mailboxPath) {
  const has = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());
  const hdr = (name) => (new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(msg.head) || [])[1] || '';
  for (const [key, value] of Object.entries(crit)) {
    switch (key) {
      case 'all': break;
      case 'seen':    if (msg.flags.has('\\Seen') !== value) return false; break;
      case 'flagged': if (msg.flags.has('\\Flagged') !== value) return false; break;
      case 'from': case 'to': case 'cc': case 'subject': if (!has(hdr(key), value)) return false; break;
      case 'text': if (!has(msg.head, value) && !has(msg.bodyText, value)) return false; break;
      case 'since':  if (msg.internalDate < value) return false; break;
      case 'before': if (msg.internalDate >= value) return false; break;
      case 'header':
        for (const [name, v] of Object.entries(value)) if (!has(hdr(name), v)) return false;
        break;
      case 'uid': {
        const [lo, hi] = String(value).split(':').map(Number);
        if (msg.uid < lo || msg.uid > hi) return false;
        break;
      }
      case 'threadId': if (msg.threadId !== value) return false; break;
      case 'or':  if (!value.some(sub => matches(msg, sub, mailboxPath))) return false; break;
      case 'not': if (matches(msg, value, mailboxPath)) return false; break;
      default: throw new Error(`fake server: unhandled search key ${key}`);
    }
  }
  return true;
}

class FakeImap {
  constructor(server, opts) {
    this.server = server;
    this.opts = opts;
    this.mailbox = null;
  }
  // Read live: connections are pooled, and the suite switches capabilities off mid-run.
  get capabilities() { return new Map([...this.server.caps].map(c => [c, true])); }
  on() {}
  async connect() {
    if (this.opts.auth.pass !== this.server.password) {
      const err = new Error('Command failed: AUTHENTICATIONFAILED');
      err.authenticationFailed = true;
      throw err;
    }
  }
  async logout() {}
  close() {}
  async list() {
    return Object.values(this.server.folders).map(f => ({
      path: f.path, name: f.path.split('.').pop(), delimiter: '.', flags: new Set(), specialUse: f.specialUse,
    }));
  }
  folder() { return this.server.folders[this.mailbox.path]; }
  async getMailboxLock(path, { readOnly } = {}) {
    const f = this.server.folders[path];
    if (!f) throw new Error(`fake server: no folder ${path}`);
    this.mailbox = { path, uidValidity: f.uidValidity, exists: f.messages.length };
    this.readOnly = readOnly;
    this.server.log.push(['select', path, Boolean(readOnly)]);
    return { path, release: () => {} };
  }
  async search(criteria, { uid } = {}) {
    if (!uid) throw new Error('fake server: searches must be by UID');
    this.server.log.push(['search', this.mailbox.path, criteria]);
    if (this.server.aolQuirks) {
      // As measured against AOL: References / In-Reply-To never match, and an
      // OR that includes either matches nothing at all; SEARCH THREADID misses.
      const text = JSON.stringify(criteria);
      if (/"references"|"in-reply-to"|"threadId"/.test(text)) return [];
    }
    return this.folder().messages.filter(m => matches(m, criteria, this.mailbox.path)).map(m => m.uid);
  }
  view(m, query) {
    const out = { seq: m.uid, uid: m.uid };
    if (query.flags) out.flags = new Set(m.flags);
    if (query.envelope) out.envelope = m.envelope;
    if (query.internalDate) out.internalDate = m.internalDate;
    if (query.bodyStructure) out.bodyStructure = m.structure;
    if (query.headers) out.headers = Buffer.from(/^References:.*$/im.exec(m.head)?.[0] || '');
    if (query.source) out.source = Buffer.from(m.raw);
    if (query.threadId && this.capabilities.has('OBJECTID')) out.threadId = m.threadId;
    if (query.bodyParts) {
      out.bodyParts = new Map(query.bodyParts.map((p) => {
        const key = typeof p === 'string' ? p : p.key;
        const buf = m.parts[key] || Buffer.alloc(0);
        return [key.toLowerCase(), p.maxLength ? buf.subarray(0, p.maxLength) : buf];
      }));
    }
    return out;
  }
  async fetchAll(uids, query, { uid } = {}) {
    const ordered = [...this.folder().messages].sort((a, b) => a.uid - b.uid);
    if (!uid) {
      // A sequence range "from:*" — the recent window read for THREADID.
      const from = Number(String(uids).split(':')[0]);
      if (!/^\d+:\*$/.test(String(uids))) throw new Error('fake server: unexpected sequence range ' + uids);
      this.server.log.push(['window', this.mailbox.path, String(uids)]);
      return ordered.slice(from - 1).map(m => this.view(m, query));
    }
    const wanted = new Set(uids.map(Number));
    return this.folder().messages.filter(m => wanted.has(m.uid)).sort((a, b) => a.uid - b.uid).map(m => this.view(m, query));
  }
  async fetchOne(uid, query) {
    const m = this.folder().messages.find(x => x.uid === Number(uid));
    return m ? this.view(m, query) : false;
  }
  writable() { if (this.readOnly) throw new Error('fake server: write to a read-only (EXAMINE) folder'); }
  async messageFlagsAdd(uid, flags) {
    this.writable();
    this.server.log.push(['flagsAdd', this.mailbox.path, uid, flags]);
    const m = this.folder().messages.find(x => x.uid === Number(uid));
    flags.forEach(fl => m.flags.add(fl));
    return true;
  }
  async messageFlagsRemove(uid, flags) {
    this.writable();
    this.server.log.push(['flagsRemove', this.mailbox.path, uid, flags]);
    const m = this.folder().messages.find(x => x.uid === Number(uid));
    flags.forEach(fl => m.flags.delete(fl));
    return true;
  }
  async messageMove(uid, destination) {
    this.writable();
    if (!this.capabilities.has('MOVE') && !this.capabilities.has('UIDPLUS')) throw new Error('fake server: unsafe move attempted');
    const src = this.folder();
    const dst = this.server.folders[destination];
    const i = src.messages.findIndex(x => x.uid === Number(uid));
    const [m] = src.messages.splice(i, 1);
    const oldUid = m.uid;
    m.uid = dst.next++;
    dst.messages.push(m);
    this.server.log.push(['move', src.path, String(uid), destination]);
    return { path: src.path, destination, uidValidity: dst.uidValidity, uidMap: new Map([[oldUid, m.uid]]) };
  }
  async messageDelete(uid) {
    this.writable();
    this.server.log.push(['delete', this.mailbox.path, String(uid)]);
    const f = this.folder();
    f.messages = f.messages.filter(x => x.uid !== Number(uid));
    return true;
  }
  async append(path, raw, flags) {
    const f = this.server.folders[path];
    const msg = this.server.store(path, raw, flags);
    this.server.log.push(['append', path]);
    return this.capabilities.has('UIDPLUS') ? { destination: path, uid: msg.uid, uidValidity: f.uidValidity } : { destination: path };
  }
  async mailboxCreate(path) {
    this.server.folders[path] = { path, uidValidity: 900n + BigInt(Object.keys(this.server.folders).length), next: 1, messages: [] };
    return { path, created: true };
  }
  async mailboxRename(path, newPath) {
    this.server.folders[newPath] = { ...this.server.folders[path], path: newPath };
    delete this.server.folders[path];
    return { path, newPath };
  }
  async mailboxDelete(path) {
    this.server.log.push(['mailboxDelete', path]);
    delete this.server.folders[path];
    return { path };
  }
  async status(path) {
    const f = this.server.folders[path];
    return f ? { path, messages: f.messages.length } : false;
  }
}

function fakeSmtp(server, opts) {
  return {
    async verify() {
      if (opts.auth.pass !== server.password) {
        const err = new Error('Invalid login: 535 5.7.0 (#AUTH005) Too many bad auth attempts.');
        err.code = 'EAUTH';
        throw err;
      }
      return true;
    },
    async sendMail(msg) {
      server.smtp.push({ envelope: msg.envelope, raw: String(msg.raw) });
      if (server.autoSaveSent) server.store('Sent', String(msg.raw), ['\\Seen']);
      return { messageId: 'x' };
    },
    close() {},
  };
}
