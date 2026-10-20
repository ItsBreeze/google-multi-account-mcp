/**
 * One deployment, two domains (a move in progress): each domain describes itself
 * in the OAuth metadata, tokens from either keep working, and an unknown Host is
 * never reflected into a URL.
 *   npm run test:hosts
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'dummy-test-secret-not-a-real-key-000000';
process.env.PUBLIC_BASE_URL = 'https://hub.old.example';
process.env.GOOGLE_CLIENT_ID = 'dummy-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'dummy-client-secret';
process.env.PUBLIC_BASE_URL_ALIASES = ' https://hub.new.example/ ,not a url';

const google = require('../src/services/google_oauth.js');
const o = require('../src/services/mcp_oauth.js');

const req = (host) => ({ get: (h) => (h.toLowerCase() === 'host' ? host : undefined) });
const derived = crypto.createHmac('sha256', process.env.JWT_SECRET).update('google-multi-account-mcp-v1').digest('base64');
const tokenFrom = (issuer) => jwt.sign({ sub: 'owner' }, derived, { audience: 'mcp', issuer, expiresIn: '1h' });
const accepts = (fn) => { try { fn(); return true; } catch { return false; } };

let fail = 0;
const check = (n, c) => { c || fail++; console.log(`${c ? ' ok  ' : 'FAIL '} ${n}`); };

check('both origins listed, junk alias dropped', JSON.stringify(google.baseUrls()) === '["https://hub.old.example","https://hub.new.example"]');
check('new host gets the new origin', google.baseUrlFor(req('hub.new.example')) === 'https://hub.new.example');
check('old host keeps the old origin', google.baseUrlFor(req('hub.old.example')) === 'https://hub.old.example');
check('unknown Host falls back to PUBLIC_BASE_URL', google.baseUrlFor(req('evil.example')) === 'https://hub.old.example');
check('no request falls back to PUBLIC_BASE_URL', google.baseUrlFor() === 'https://hub.old.example');
check('Google redirect follows the host', google.config('https://hub.new.example').redirectUri === 'https://hub.new.example/gmail/oauth/callback');

const prm = o.protectedResourceMetadata(req('hub.new.example'));
const asm = o.authorizationServerMetadata(req('hub.new.example'));
check('resource metadata names the new host', prm.resource === 'https://hub.new.example/mcp' && prm.authorization_servers[0] === 'https://hub.new.example');
check('issuer and endpoints name the new host', asm.issuer === 'https://hub.new.example' && asm.token_endpoint === 'https://hub.new.example/mcp/oauth/token');
check('old host metadata unchanged', o.authorizationServerMetadata(req('hub.old.example')).issuer === 'https://hub.old.example');

check('token issued under the old origin still accepted', accepts(() => o.verifyAccessToken(tokenFrom('https://hub.old.example'))));
check('token issued under the new origin accepted', accepts(() => o.verifyAccessToken(tokenFrom('https://hub.new.example'))));
check('token from a foreign issuer rejected', !accepts(() => o.verifyAccessToken(tokenFrom('https://evil.example'))));

console.log(fail ? `\n${fail} FAILED` : '\nboth domains work');
process.exit(fail ? 1 : 0);
