# Launch runbook

The connector's code is public-ready: per-user identity, tenant isolation proven in
production, public pages served from the deployment itself (`/`, `/privacy`, `/terms`).
What remains is Google-side and DNS-side work that only the account owner can do —
this file is the order to do it in, and why that order.

Deployment: Railway project `pacific-prosperity` → service `google-multi-account-mcp`.
The service auto-deploys from `main`, gated on a `/health` healthcheck.

---

## Phase A — A Google Cloud project of its own (~30 min)

The connector currently shares a project with Grounders, Radio, and Offhand Notes.
That must end **before** verification, not after: the 100-user cap is per-project and
lifetime (it cannot be reset), the consent-screen branding is per-project (all four
apps show the same name and policy links), and restricted-scope verification + CASA
applies to the whole project — the other apps would be dragged into a security
assessment they don't need.

1. [console.cloud.google.com](https://console.cloud.google.com) → New project, e.g.
   `gma-connector`.
2. **Enable five APIs** (APIs & Services → Library): Gmail API, Google Calendar API,
   Google Drive API, People API, Google Tasks API. Miss one and Google silently drops
   its scope at consent — the linking page will name the product it didn't get.
3. **Consent screen** (Google Auth Platform → Branding): app name
   `Google Multi-Account Connector`, your support email, developer contact.
   User type **External**.
4. **Audience → Publish to Production** immediately. Unverified-in-production shows a
   warning screen but issues **non-expiring refresh tokens**; Testing kills them
   every 7 days. There is no reason to sit in Testing.
5. **Scopes** — declare what the code requests (`src/services/google_oauth.js`):
   - `.../auth/gmail.modify` (restricted)
   - `.../auth/calendar` (sensitive)
   - `.../auth/drive` (restricted)
   - `.../auth/contacts.readonly`, `.../auth/contacts.other.readonly` (sensitive)
   - `.../auth/tasks` (sensitive)
   - `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
6. **OAuth client** (Credentials → Create → OAuth client ID → **Web application**).
   Authorized redirect URI, character for character:
   `https://google-multi-account-mcp-production.up.railway.app/gmail/oauth/callback`
   (add the custom-domain one too once Phase B is done).
7. **Swap credentials on Railway** — service Variables:
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` → the new client's values.
8. **Re-link both accounts** at `/gmail/connect`. A new client means new grants; the
   old tokens die with the old client. This is also what upgrades you off the 7-day
   tokens. `/gmail/check` verifies the new credentials without a full consent trip.

While in Variables, delete the two dead ones: `MCP_ADMIN_PASSWORD` (removed from the
code) and `LEGACY_OWNER_EMAIL` (its cutover turned out to have nothing to adopt).

## Phase B — Custom domain

Google's verification requires the home page and policy pages on a domain you own and
have verified. `up.railway.app` is Railway's domain, not yours.

1. Pick the domain (a subdomain of one you own is fine, e.g. `mcp.example.com`).
2. Railway service → Settings → Networking → **Custom Domain** → add it; Railway
   shows the CNAME target. Create that CNAME at your DNS provider. TLS is automatic.
3. Update `PUBLIC_BASE_URL` on the service to `https://<domain>`.
4. Add `https://<domain>/gmail/oauth/callback` to the OAuth client's redirect URIs,
   and the bare domain to the consent screen's authorized domains.
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
