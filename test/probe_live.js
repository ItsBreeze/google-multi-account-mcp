/**
 * Credential-free liveness probe — run this first, right after a deploy.
 *   npm run probe https://your-deployment.example.com
 *
 * `npm run smoke` is the deeper check, but it needs the operator password and
 * linked accounts. This needs neither, so it is what you run when a deploy may
 * not have come up at all.
 *
 * Read-only: every request is a GET, none carries a credential, none writes.
 * It answers three questions in order — is the process listening, did the
 * database come up, and is PUBLIC_BASE_URL what this host actually is.
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

  // 5. The linking page renders, which is where accounts are re-linked.
  const connect = await get('/gmail/connect');
  if (connect.res.status === 200 && /password/i.test(connect.text)) ok('/gmail/connect', 'password form renders');
  else bad('/gmail/connect', `HTTP ${connect.res.status}`);

  console.log(failed ? `\n${failed} check(s) failed.` : '\nDeployment is up and configured.');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
