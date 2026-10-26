/**
 * Send-as aliases: From header building, alias validation, tool wiring.
 *   npm run test:send-as
 */
const path = require('path');
const sendAs = require('../src/services/send_as');
const { _internal } = require('../src/services/gmail_api');

let fail = 0;
const check = (n, c, e = '') => { c || fail++; console.log(`${c ? ' ok  ' : 'FAIL '} ${n}${e ? ' — ' + e : ''}`); };
const rejects = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

const MAILBOX = 'brisebyme@gmail.com';
const ROWS = [
  { sendAsEmail: MAILBOX, isPrimary: true, displayName: '' },
  { sendAsEmail: 'josh@brisebois.xyz', verificationStatus: 'accepted', displayName: 'Josh Brisebois' },
  { sendAsEmail: 'support@brisebois.xyz', verificationStatus: 'accepted' },
  { sendAsEmail: 'pending@brisebois.xyz', verificationStatus: 'pending' },
];
let listCalls = 0;
const listSendAs = async () => { listCalls++; return ROWS; };

(async () => {
  // ─── formatFrom ───
  check('bare address without name', sendAs.formatFrom('a@b.co') === 'a@b.co');
  check('quoted ASCII name', sendAs.formatFrom('support@brisebois.xyz', 'brisebois.xyz Support') === '"brisebois.xyz Support" <support@brisebois.xyz>');
  check('quotes and backslashes escaped', sendAs.formatFrom('a@b.co', 'A "B" \\ C') === '"A \\"B\\" \\\\ C" <a@b.co>');
  const enc = sendAs.formatFrom('a@b.co', 'Jösh Ü');
  check('non-ASCII RFC 2047 encoded', enc === `=?UTF-8?B?${Buffer.from('Jösh Ü').toString('base64')}?= <a@b.co>`, enc);
  check('CRLF injection rejected', await rejects(async () => sendAs.formatFrom('a@b.co', 'x\r\nBcc: evil@x.co'), /line breaks/));

  // ─── resolveFrom ───
  listCalls = 0;
  let r = await sendAs.resolveFrom({ mailbox: MAILBOX, listSendAs });
  check('no from → bare mailbox, unchanged', r.header === MAILBOX && r.address === MAILBOX);
  check('no from → aliases not listed', listCalls === 0);
  r = await sendAs.resolveFrom({ mailbox: MAILBOX, fromName: 'Josh', listSendAs });
  check('fromName alone names the mailbox', r.header === `"Josh" <${MAILBOX}>`);
  r = await sendAs.resolveFrom({ mailbox: MAILBOX, from: 'support@brisebois.xyz', fromName: 'brisebois.xyz Support', listSendAs });
  check('verified alias accepted', r.header === '"brisebois.xyz Support" <support@brisebois.xyz>' && r.address === 'support@brisebois.xyz', r.header);
  r = await sendAs.resolveFrom({ mailbox: MAILBOX, from: 'JOSH@brisebois.xyz', listSendAs });
  check('case-insensitive, alias display name default', r.header === '"Josh Brisebois" <josh@brisebois.xyz>', r.header);
  r = await sendAs.resolveFrom({ mailbox: MAILBOX, from: MAILBOX, listSendAs });
  check('primary address accepted', r.header === MAILBOX);
  check('pending alias rejected', await rejects(() => sendAs.resolveFrom({ mailbox: MAILBOX, from: 'pending@brisebois.xyz', listSendAs }), /not a verified send-as.*Allowed: brisebyme@gmail.com, josh@brisebois.xyz, support@brisebois.xyz/));
  check('unknown address rejected', await rejects(() => sendAs.resolveFrom({ mailbox: MAILBOX, from: 'ceo@apple.com', listSendAs }), /not a verified send-as/));
  check('"Name <addr>" in from rejected', await rejects(() => sendAs.resolveFrom({ mailbox: MAILBOX, from: 'X <support@brisebois.xyz>', listSendAs }), /plain email address/));
  check('IMAP (no listSendAs) other address rejected', await rejects(() => sendAs.resolveFrom({ mailbox: 'me@aol.com', from: 'x@aol.com' }), /can only send as itself/));
  check('list failure surfaces clearly', await rejects(() => sendAs.resolveFrom({ mailbox: MAILBOX, from: 'support@brisebois.xyz', listSendAs: async () => { throw new Error('403 insufficient scope'); } }), /Could not list send-as aliases.*403/));

  // ─── MIME carries the header ───
  const raw = Buffer.from(_internal.buildMime({ from: '"brisebois.xyz Support" <support@brisebois.xyz>', to: 'x@y.co', subject: 's', body: 'b' }), 'base64url').toString();
  check('MIME From header', raw.includes('\r\nFrom: "brisebois.xyz Support" <support@brisebois.xyz>\r\n') || raw.startsWith('From: "brisebois.xyz Support"'));

  // ─── replaceFromHeader ───
  const draft = 'From: brisebyme@gmail.com\r\nTo: x@y.co\r\nSubject: hi\r\n\r\nFrom: body line stays';
  const out = sendAs.replaceFromHeader(draft, '"S" <support@brisebois.xyz>');
  check('draft From replaced, body untouched', out === 'From: "S" <support@brisebois.xyz>\r\nTo: x@y.co\r\nSubject: hi\r\n\r\nFrom: body line stays', JSON.stringify(out));
  check('folded From removed', sendAs.replaceFromHeader('From: "Long"\r\n <a@b.co>\r\nTo: x\r\n\r\nb', 'n@b.co') === 'From: n@b.co\r\nTo: x\r\n\r\nb');
  check('missing From inserted', sendAs.replaceFromHeader('To: x\n\nb', 'n@b.co') === 'From: n@b.co\nTo: x\n\nb');

  // ─── Tool wiring, with a stubbed mailbox ───
  const sent = [];
  const fakeGmail = {
    listSendAs: listSendAs,
    sendMessage: async (h, m) => { sent.push(m); return { id: 'm1', threadId: 't1' }; },
    createDraft: async (h, m) => { sent.push(m); return { draft_id: 'd1' }; },
    getReplyContext: async () => ({ from: 'a@b.co', to: `${MAILBOX}, support@brisebois.xyz, c@d.co`, cc: '', subject: 'Re: x', threadId: 't', messageId: '<m>' }),
    forwardMessage: async (h, m) => { sent.push(m); return { sent: { id: 'f', threadId: 't' }, skippedAttachments: [] }; },
    getDraftRaw: async () => ({ raw: draft, threadId: 'tt' }),
    putDraftRaw: async (h, id, d) => { sent.push(d); },
    sendDraft: async () => ({ id: 'sd', threadId: 'tt' }),
  };
  const sharedPath = path.resolve(__dirname, '../src/mcp/shared.js');
  const shared = require(sharedPath);
  shared.mailFor = async () => ({ email: MAILBOX, provider: 'gmail', api: fakeGmail, handle: 'tok' });
  const tools = require('../src/mcp/tools/gmail');
  const tool = (n) => tools.find(t => t.name === n);
  const call = async (n, args) => JSON.parse((await tool(n).handler({ ownerKey: 'k', args })).content[0].text);

  for (const n of ['send_message', 'reply_to_message', 'create_draft', 'send_draft', 'forward_message']) {
    const p = tool(n).inputSchema.properties;
    check(`${n} schema has from/fromName`, p.from?.type === 'string' && p.fromName?.type === 'string');
  }

  sent.length = 0;
  let res = await call('send_message', { to: 'x@y.co', subject: 's', body: 'b' });
  check('send_message default From unchanged', sent[0].from === MAILBOX && res.sent_from === MAILBOX && !res.account);
  sent.length = 0;
  res = await call('send_message', { to: 'x@y.co', subject: 's', body: 'b', from: 'support@brisebois.xyz', fromName: 'brisebois.xyz Support' });
  check('send_message alias From', sent[0].from === '"brisebois.xyz Support" <support@brisebois.xyz>' && res.sent_from === 'support@brisebois.xyz' && res.account === MAILBOX);
  check('send_message bad alias rejected before sending', await rejects(() => call('send_message', { to: 'x', subject: 's', body: 'b', from: 'no@x.co' }), /not a verified/) && sent.length === 1);
  sent.length = 0;
  await call('reply_to_message', { message_id: 'm', body: 'b', reply_all: true, from: 'support@brisebois.xyz' });
  check('reply alias From + alias dropped from reply-all', sent[0].from === 'support@brisebois.xyz' && sent[0].cc === 'c@d.co', JSON.stringify(sent[0]));
  sent.length = 0;
  await call('create_draft', { to: 'x', subject: 's', body: 'b', from: 'josh@brisebois.xyz' });
  check('create_draft alias From', sent[0].from === '"Josh Brisebois" <josh@brisebois.xyz>');
  sent.length = 0;
  await call('forward_message', { message_id: 'm', to: 'x', from: 'support@brisebois.xyz', fromName: 'Support' });
  check('forward alias From', sent[0].from === '"Support" <support@brisebois.xyz>');
  sent.length = 0;
  res = await call('send_draft', { draft_id: 'd' });
  check('send_draft without from does not rewrite', sent.length === 0 && res.sent_from === MAILBOX);
  res = await call('send_draft', { draft_id: 'd', from: 'support@brisebois.xyz' });
  check('send_draft rewrites From then sends', sent[0].raw.startsWith('From: support@brisebois.xyz\r\n') && sent[0].threadId === 'tt' && res.sent_from === 'support@brisebois.xyz');

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exit(fail ? 1 : 0);
})();
