# Launch runbook

The connector's code is public-ready: per-user identity, tenant isolation proven in
production, public pages served from the deployment itself (`/`, `/privacy`, `/terms`).
What remains is Google-side and DNS-side work that only the account owner can do —
this file is the order to do it in, and why that order.

Deployment: Railway project `pacific-prosperity` → service `google-multi-account-mcp`.
The service auto-deploys from `main`, gated on a `/health` healthcheck.

---

## Phase A — Publish the Work Gmail project (~5 min)

**The split already happened.** The connector's OAuth client lives in its own dedicated
Google Cloud project — **Work Gmail** (`work-gmail-507122`, project number 649628663165)
— separate from Grounders, Radio and Offhand Notes. No new project, no client swap, no
credential change. The 100-user lifetime cap is this project's own, and only 2 of 100
slots are used (the two test users).

What actually remains:

1. **Branding — set the App name** (it is the one required field still empty, and it
   blocks publishing): `Google Multi-Account Connector`. Save.
   https://console.cloud.google.com/auth/branding?project=work-gmail-507122
2. **Audience → Publish app.**
   https://console.cloud.google.com/auth/audience?project=work-gmail-507122
   A logo is already uploaded, and Google sometimes demands verification before
   publishing when a logo is set — if the publish flow insists on verification,
   remove the logo for now and re-add it when submitting verification in Phase C.
3. **Re-link both accounts** at `/gmail/connect`. Publishing stops *new* tokens from
   expiring; the currently stored ones were minted under Testing and still die
   ~Sep 8. Two quick consent trips replace them with non-expiring grants.
4. **Railway variables** — delete the two dead ones: `MCP_ADMIN_PASSWORD`,
   `LEGACY_OWNER_EMAIL`.

## Phase B — Custom domain

Google's verification requires the home page and policy pages on a domain you own and
have verified. `up.railway.app` is Railway's domain, not yours.

1. Pick the domain (a subdomain of one you own is fine, e.g. `mcp.example.com`).
2. Railway service → Settings → Networking → **Custom Domain** → add it; Railway
   shows the CNAME target. Create that CNAME at your DNS provider. TLS is automatic.
3. Update `PUBLIC_BASE_URL` on the service to `https://<domain>`.
4. Add `https://<domain>/gmail/oauth/callback` to the OAuth client's redirect URIs;
   add the bare domain under Branding → Authorized domains; and fill in the home page,
   privacy policy and terms links on the Branding page
   (`https://<domain>/`, `/privacy`, `/terms` — already live on the deployment).
5. Verify domain ownership in [Search Console](https://search.google.com/search-console).

**Breaking side effect, by design:** `PUBLIC_BASE_URL` is the OAuth issuer for MCP
tokens, so changing it invalidates existing connector sessions — everyone (i.e. you)
reconnects the connector in Claude once. Linked Google accounts are untouched. Do
Phase B before inviting anyone else, and it costs one reconnect total.

## Phase C — Verification (the long pole; start it, then wait)

With A + B done, submit for OAuth verification from the console. Have ready:

- Home page, privacy policy, terms — already served at `/`, `/privacy`, `/terms` on
  the custom domain. The privacy page already carries the **Limited Use disclosure**
  and per-scope justifications reviewers look for.
- A short screen-recording (YouTube, unlisted is fine) showing the OAuth flow and
  each scope in use — Google asks for this for sensitive/restricted scopes.
- Per-scope written justifications: crib them from the `/privacy` table.

Because the app stores restricted-scope data (Google tokens) on a server, Google will
then require a **CASA security assessment** (Tier 2, third-party assessor, renewed
annually). Weeks of calendar time and real money — start it as soon as verification
asks, and expect to launch to the 100-user unverified cap in the meantime.

## Already done (don't redo)

- Per-user identity; `MCP_ADMIN_PASSWORD` retired; isolation verified live.
- `trust proxy` set; per-IP rate limits actually per-IP behind Railway.
- Healthcheck gates deploys; a failing boot can't replace a serving container.
- Public pages live and domain-agnostic (they render whatever `PUBLIC_BASE_URL` says).
- Sign-in page shows the deployment's redirect URI pre-auth, so a
  `redirect_uri_mismatch` is self-diagnosing.
