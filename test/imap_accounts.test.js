/**
 * AOL mailbox store: app passwords at rest, owner scoping, unlinking.
 * Needs a Postgres with the migration applied:
 *   DATABASE_URL=... npm run test:imap-accounts
 *
 * The IMAP/SMTP sign-in is stubbed — what is asserted is what lands in the
 * table, and that nothing is stored when the sign-in fails.
 */

process.env.DATABASE_URL  = process.env.DATABASE_URL || 'postgresql://postgres@localhost:55432/connector_test';
process.env.TOKEN_ENC_KEY = require('crypto').randomBytes(32).toString('base64');

const pool         = require('../src/db/pool');
const { migrate }  = require('../src/db/migrate');
const imap         = require('../src/services/imap_api');
const imapAccounts = require('../src/services/imap_accounts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? ' ok  ' : 'FAIL '} ${n}${e ? ' — ' + e : ''}`); };
const expectThrow = async (n, fn, needle) => {
  try { await fn(); check(n, false, 'no throw'); }
  catch (err) { check(n, err.message.includes(needle), err.message); }
};

const verified = [];
imap.verify = async (cred) => {
  verified.push(cred);
  if (cred.password !== 'abcdefghijklmnop') {
    const err = new Error('AOL refused the app password for ' + cred.email + '.');
    throw err;
  }
};

(async () => {
  await migrate();
  await pool.query("DELETE FROM imap_accounts WHERE owner_key IN ('owner-a', 'owner-b')");

  await expectThrow('a bad address is refused before any sign-in',
    () => imapAccounts.link({ ownerKey: 'owner-a', email: 'not-an-address', provider: 'aol', password: 'x' }), 'full mailbox address');
  check('…and no sign-in was attempted', verified.length === 0);

  let refused;
  try {
    await imapAccounts.link({ ownerKey: 'owner-a', email: 'Me@AOL.com', provider: 'aol', password: 'wrong' });
  } catch (err) { refused = err; }
  check('a refused sign-in is reported to the page', refused?.userFacing === true, refused?.message);
  const none = await pool.query("SELECT 1 FROM imap_accounts WHERE owner_key = 'owner-a'");
  check('a refused password is never stored', none.rows.length === 0);

  await expectThrow('an unknown provider is refused',
    () => imapAccounts.link({ ownerKey: 'owner-a', email: 'me@aol.com', provider: 'nope', password: 'x' }), 'Unknown mail provider');

  const row = await imapAccounts.link({ ownerKey: 'owner-a', email: ' Me@AOL.com ', provider: 'aol', password: 'abcd efgh ijkl mnop' });
  check('the address is normalised', row.email === 'me@aol.com', row.email);
  check('spaces pasted into an app password are dropped', verified.at(-1).password === 'abcdefghijklmnop');

  const raw = await pool.query("SELECT password_enc FROM imap_accounts WHERE owner_key = 'owner-a' AND email = 'me@aol.com'");
  check('the app password is encrypted at rest',
    raw.rows[0].password_enc.startsWith('v1.') && !raw.rows[0].password_enc.includes('abcdefghijklmnop'));

  const cred = await imapAccounts.credentialsFor('owner-a', 'ME@aol.com');
  check('credentials decrypt for their owner', cred.password === 'abcdefghijklmnop' && cred.provider === 'aol');

  await expectThrow('another owner cannot read them', () => imapAccounts.credentialsFor('owner-b', 'me@aol.com'), 'No linked mailbox');
  check('another owner does not list them', (await imapAccounts.list('owner-b')).length === 0);

  await imapAccounts.link({ ownerKey: 'owner-a', email: 'me@aol.com', provider: 'aol', password: 'abcdefghijklmnop' });
  check('re-linking updates in place', (await imapAccounts.list('owner-a')).length === 1);

  await imapAccounts.link({ ownerKey: 'owner-b', email: 'me@aol.com', provider: 'aol', password: 'abcdefghijklmnop' });
  check('two owners may link the same address separately', (await imapAccounts.list('owner-b')).length === 1);

  check('unlinking another owner\'s row does nothing', (await imapAccounts.remove('owner-b', 'other@aol.com')) === false);
  check('unlinking removes the row', (await imapAccounts.remove('owner-b', 'me@aol.com')) === true &&
    (await imapAccounts.list('owner-b')).length === 0);
  check('…and leaves the other owner\'s alone', (await imapAccounts.list('owner-a')).length === 1);

  const gone = await imapAccounts.removeAll('owner-a');
  check('delete-everything removes every mailbox', gone.length === 1 && (await imapAccounts.list('owner-a')).length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => { console.error('Test harness error:', err); await pool.end(); process.exit(1); });
