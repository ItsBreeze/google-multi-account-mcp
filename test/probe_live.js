/**
 * Credential-free liveness probe — run this first, right after a deploy.
 *   npm run probe https://your-deployment.example.com
 *
 * `npm run smoke` is the deeper check, but it needs the deployment's JWT_SECRET
 * and an owner key to mint a session with. This needs neither, so it is what you
 * run when a deploy may not have come up at all.
 *
 * Read-only: every request is a GET, none carries a credential, none writes.
 * It answers three questions in order — is the process listening, did the
 * database come up, and is PUBLIC_BASE_URL what this host actually is — then
 * checks the public pages Google's verification reads.
 *
 * The first question answers the second for free: src/server.js calls
 * app.listen only after migrate() resolves, so anything answering at all is
 * proof the schema was applied and the database replied.
 */

const BASE = (process.argv[2] || process.env.SMOKE_BASE_URL || '').replace(/\/+$/, '');
if (!BASE) { console.error('Usage: npm run probe https://your-deployment.example.com'); process.exit(2); }

let failed = 0;
const ok   = (l, d = '') => console.log(`  ok    ${l}${d ? ' — ' + d : ''}`);
const bad  = (l, d = '') => { failed++; console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`); };
const note = (l, d = '') => console.log(`  --    ${l}${d ? ' — ' + d : ''}`);

/**
 * Everything known about a failure.
 *
 * fetch reports a connect or DNS error as the bare string "fetch failed" and
 * hides the cause one level down in err.cause, so printing err.message alone
 * produces a line that names no cause at all — the same trap src/server.js
 * describes.
 */
function describe(err) {
  if (!err) return 'unknown error';
  const parts = [err.message, err.code, err.address && `${err.address}:${err.port ?? ''}`].filter(Boolean);
  if (err.cause) parts.push(describe(err.cause));
  for (const nested of err.errors || []) parts.push(describe(nested));
  return parts.length ? parts.join(' · ') : String(err);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { res, text, json };
}

(async () => {
  console.log(`Probing ${BASE}\n`);

  // 1. Listening at all. app.listen runs only after migrate() resolves, so a
  //    green /health also proves the schema prep succeeded and the database
  //    answered — the failure the last commit was about.
  try {
    const { res, json } = await get('/health');
    if (res.status === 200 && json && json.status === 'ok') {
      ok('/health', 'process is listening, so migrate() succeeded and the database answered at boot');
    } else {
      bad('/health', `HTTP ${res.status}`);
    }
  } catch (err) {
    bad('/health', describe(err));
    console.log('\nNothing is answering at that origin. The container is down, still deploying, or the URL is wrong.');
    process.exit(1);
  }

  // 2. Its own router is answering, not a platform edge page.
  const miss = await get('/definitely-not-a-route');
  if (miss.res.status === 404 && miss.json && miss.json.error === 'Route not found') ok('404 handler', 'the app is serving, not the platform edge');
  else bad('404 handler', `HTTP ${miss.res.status} ${miss.text.slice(0, 80)}`);

  // 3. Configuration. 503 here is a config answer, not a boot failure.
  const meta = await get('/.well-known/oauth-authorization-server');
  if (meta.res.status === 503) {
    bad('oauth-authorization-server', JSON.stringify(meta.json));
  } else if (meta.res.status === 200 && meta.json) {
    ok('oauth-authorization-server', `issuer ${meta.json.issuer}`);
    if (meta.json.issuer !== BASE) {
      bad('PUBLIC_BASE_URL', `issuer is ${meta.json.issuer} but this host is ${BASE} — Google will answer redirect_uri_mismatch`);
    } else {
      ok('PUBLIC_BASE_URL', 'matches the host being probed');
      note('register with Google', `${BASE}/gmail/oauth/callback`);
    }
  } else {
    bad('oauth-authorization-server', `HTTP ${meta.res.status}`);
  }

  const prm = await get('/.well-known/oauth-protected-resource');
  if (prm.res.status === 200 && prm.json) ok('oauth-protected-resource', `resource ${prm.json.resource}`);
  else bad('oauth-protected-resource', `HTTP ${prm.res.status}`);

  // 4. The MCP endpoint refuses unauthenticated traffic and says where to authenticate.
  const mcp = await get('/mcp');
  const challenge = mcp.res.headers.get('www-authenticate');
  if (mcp.res.status === 401) ok('/mcp unauthenticated', challenge ? `401 with ${challenge}` : '401 (no WWW-Authenticate header)');
  else bad('/mcp unauthenticated', `expected 401, got HTTP ${mcp.res.status}`);

  // 5. The linking page is identity-gated, and says so rather than erroring.
  //    Unauthenticated it answers 401 with the sign-in prompt, which is the
  //    correct response and proof that per-user identity is switched on: a 200
  //    here would mean anyone reaching the URL is offered the link form.
  const connect = await get('/gmail/connect');
  if (connect.res.status === 401 && /\/gmail\/signin/.test(connect.text)) {
    ok('/gmail/connect', '401 with the sign-in prompt — identity gating is on');
  } else if (connect.res.status === 200) {
    bad('/gmail/connect', 'served the link form without a session — identity gating is not active');
  } else {
    bad('/gmail/connect', `expected 401 with a sign-in prompt, got HTTP ${connect.res.status}`);
  }

  // 6. Sign-in hands off to Google rather than 500ing on a missing JWT_SECRET.
  const signin = await get('/gmail/signin');
  const location = signin.res.headers.get('location') || '';
  if (signin.res.status === 302 && /^https:\/\/accounts\.google\.com\//.test(location)) {
    ok('/gmail/signin', 'redirects to Google');
  } else {
    bad('/gmail/signin', `expected a 302 to accounts.google.com, got HTTP ${signin.res.status}`);
  }

  // 7. The pages Google's verification reads. Not behind requireConfigured, so
  //    these answer even on a half-configured deployment — a 404 here means
  //    verification will fail on a deployment that otherwise looks healthy.
  for (const path of ['/', '/privacy', '/terms']) {
    const page = await get(path);
    if (page.res.status === 200) ok(`${path}`, 'public page renders');
    else bad(`${path}`, `expected 200 for Google verification, got HTTP ${page.res.status}`);
  }

  console.log(failed ? `\n${failed} check(s) failed.` : '\nDeployment is up and configured.');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
