# Launch runbook

Status of the public launch of **Grounders MCP** — the multi-account Google connector.
Most of the launch is done and live; what remains is Google-side verification (their
clock) plus a couple of deferred niceties.

Deployment: Railway project `pacific-prosperity` → service `google-multi-account-mcp`,
auto-deploys from `main`, gated on the `/health` healthcheck. Live at
**https://mcp.grounders.app**.

---

## Done and live

- **Per-user identity in production.** Every credential the server issues carries the
  signed-in Google `sub` (`owner_key = google:<sub>`); users are isolated from each other.
- **Custom domain** `mcp.grounders.app` (Railway TLS; needed a `_railway-verify.mcp` TXT
  record for ownership — that was the one-time gotcha). `PUBLIC_BASE_URL` points here.
  Note: `PUBLIC_BASE_URL` is the OAuth **issuer** — changing it invalidates existing
  connector tokens and requires one reconnect in Claude.
- **Published to Production** in the OAuth project **Work Gmail** (`work-gmail-507122`,
  External, billing = "Grounders" account linked, 2/100 user cap). Non-expiring tokens.
- **Identity = "Grounders MCP"**, set identically on the OAuth **consent screen** and the
  **homepage** (`src/routes/pages.js` `APP_NAME`). These MUST match, and the name MUST NOT
  contain "Google" or a Google product name — that's Google's App Identity policy and the
  #1 branding-verification rejection. The green-ring logo matches the Grounders brand.
- **One authorized domain**: `grounders.app` (Search-Console verified, covers the
  subdomain). One redirect URI: `https://mcp.grounders.app/gmail/oauth/callback`. The old
  `*.up.railway.app` domains/redirect were removed (Google can't verify them → they blocked
  branding verification).
- **Public pages** served by the app: `/`, `/privacy` (Limited Use disclosure + per-scope
  justifications), `/terms` — all domain-agnostic via `PUBLIC_BASE_URL`.
- **Self-serve deletion**: "Delete everything" on `/gmail/connect` revokes every grant at
  Google, wipes stored tokens + all owner rows, and signs out. (Running it on your own live
  connector also logs that connector out — expected; just reconnect.)
- **Open MCP registry listing** — `io.github.ItsBreeze/grounders-mcp` (status active) at
  `registry.modelcontextprotocol.io`. Published by `.github/workflows/publish-mcp.yml` via
  **GitHub OIDC** (no secret) on any push to `main` that touches `server.json`. To ship a
  new version: bump `version` in `server.json`, push. Gotchas: registry namespace casing
  must match the GitHub username exactly (`io.github.ItsBreeze`), description ≤ 100 chars.
  This is ecosystem/catalog presence only — it does NOT feed Claude's in-app connector search.
- **Demo video** (unlisted): https://youtu.be/DGh_LkE8IqU. Verification packet:
  `VERIFICATION.md` (per-scope justifications, Limited Use, shot list) — all pre-filled.

## Remaining — Google verification (the long pole)

1. **Branding verification** — a Google-side *async* determination; there is no button for
   it in the console. Now that the name is compliant + matches the homepage, it *can* pass
   (before it couldn't). Watch `brisebyme@gmail.com` and the
   [Verification Center](https://console.cloud.google.com/auth/verification?project=work-gmail-507122):
   when branding verifies, **"Prepare for verification" enables**.
2. **Submit data-access verification** — click "Prepare for verification" and submit; all
   answers (scopes, justifications, demo video) are already saved. Sensitive scopes:
   calendar, contacts.readonly, contacts.other.readonly, tasks. Restricted: gmail.modify, drive.
3. **CASA Tier 2** — Google's follow-up because the app stores restricted-scope tokens on a
   server. Third-party assessor, renewed annually; the follow-up email names the labs.
   Until verification completes, the app runs published-but-unverified (100-user cap, users
   see the "unverified app" interstitial) — which is fine to operate in.

## Deferred / not doing

- **DB backups** — deferred by choice. Railway Hobby blocks scheduled volume backups; set up
  `pg_dump` → R2 (or move to Pro) before real external users rely on it.
- **Anthropic in-app Connectors Directory** — requires a paid Team/Enterprise org where you're
  Owner; skipped. The connector's tools also currently declare no annotations
  (`title`/`readOnlyHint`/`destructiveHint`), which that directory would require.

## Operational notes

- Google's Auth Platform console is flaky under browser automation (screenshots time out
  mid-render); read state via page text / JS rather than screenshots. Dark-theme form fields
  render values invisibly but persist — verify by reading the input value after reload.
- Railway API mutations sometimes return "Not Authorized" (token lapse) — use the Railway web
  UI for variable/billing changes when that happens.
