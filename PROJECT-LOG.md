# Project log — Google Multi-Account Connector

Why this exists in the shape it does. The reasoning behind a decision is the
part that does not survive in a diff, and it is what you need when changing that
decision later.

Chronological. Each entry is the problem, what was decided, and why the
alternative was rejected.

---

## 1 — The reason for building it at all

Claude's first-party Google connectors hold **exactly one account each**.
Linking a second replaces the first. Anyone with a personal address and a work
address therefore cannot ask a question that spans both, and the workaround —
relinking, asking, relinking back — is worse than not asking.

This server holds as many accounts as you link, and every search tool fans out
across all of them in one call and merges the results by date. That single
property is the justification for the whole thing; everything else follows from
it.

**Kept deliberately self-contained.** It was built inside a larger application
and extracted into this repository without untangling anything: four tables with
no foreign keys into that app's schema, its own env vars, its own route
prefixes, and no imports beyond a Postgres pool. That was a design constraint
from the first commit, not a lucky outcome, and it is why the extraction was a
copy rather than a rewrite.

## 2 — Security decisions made early, because they are hard to reverse

- **Tokens are AES-256-GCM encrypted at rest** under `TOKEN_ENC_KEY`. The
  database never holds a usable Google token.
- **MCP tokens are signed with a key derived from `JWT_SECRET` by HMAC, not with
  `JWT_SECRET` itself.** This is not paranoia: `middleware/auth.js` verifies
  user tokens with no audience check, so sharing the key would have made every
  connector token a valid *user* token for the host application. That mattered
  where it was first deployed and matters for anyone mounting it inside their own
  app. The suite `test:tokens` asserts this in both directions, and it should
  never be deleted.
- **The Gmail scope is `gmail.modify`, excluding `mail.google.com`.** Mail
  therefore *cannot* be permanently deleted — a structural guarantee rather than
  a promise about which tools exist.
- PKCE S256 required; authorization codes single-use and hashed; refresh tokens
  rotated on use; `redirect_uri` matched exactly against registration.

## 3 — Bugs that only production found

Worth recording because each was invisible to a passing test suite.

- **Array query parameters were comma-joined instead of repeated.** Google
  expects `metadataHeaders=From&metadataHeaders=Subject&…` and silently returns a
  message with *no headers at all* when handed `"From,To,Subject,Date"`. Every
  search result came back with empty from/to/subject/date, and the cross-account
  date sort was a no-op because every date compared equal. The same bug sat in
  `getReplyContext`, where it would have broken threading on the first reply
  sent. This is the origin of the rule below about asserting on the wire.
- Diagnosing a bad `GOOGLE_CLIENT_SECRET` meant running the whole consent
  round-trip to fail at the last step. `/gmail/check` posts a deliberately bogus
  authorization code: Google validates client credentials *before* the grant, so
  `invalid_client` and `invalid_grant` cleanly separate "your secret is wrong"
  from "both fine".
- A pasted `PUBLIC_BASE_URL=` prefix or a stray space surfaced as Google's
  `redirect_uri_mismatch`, which points at the OAuth client rather than at the
  real cause. Now validated as a bare origin at both read sites.
- `MCP_ADMIN_PASSWORD` now trims both sides before the constant-time compare.
  Copying a passphrase picks up whitespace, and the resulting "incorrect
  password" is unfixable by careful retyping.

## 4 — Extending past Gmail, and the extraction refusal

Calendar, Drive, Contacts and Tasks each have their own first-party connector
with the same one-account limit, so the argument for mail applied unchanged.

**Document text extraction uses only Node's standard library.** Office formats
are ZIP archives of XML and zlib is in `node:zlib`; PDFs are parsed from their
content streams. The alternative was a parsing dependency to vendor, audit and
keep current, for a job the standard library can do.

**The important decision here is the refusal.** Two kinds of PDF have no text to
recover: a scan, and one whose fonts are CID-keyed or subset, where the content
stream holds glyph numbers rather than characters. A union of the document's
ToUnicode tables would often fix the second case — but subset fonts reuse codes
with different meanings, so it would *sometimes* produce text that reads
correctly and says something the document does not. That is the worst available
failure, so the output is scored for readability and **refused** instead, naming
the cause. `ocr: true` routes those through Drive's own conversion.

Bugs found only by testing against real files: a word boundary after `T*` in the
PDF operator pattern can never match (`*` is not a word character), so every PDF
would have come back as one run-on line; content streams had to be found by
scanning *back* from the `stream` keyword, because a page dictionary nests
`/Resources` inside itself and a forward match spans objects and picks up the
wrong `/Length`.

## 5 — Shared drives, and what the default corpus hides

Drive's `files.list` defaults to `corpora=user`: My Drive plus files shared
directly with the account. Drives owned by an *organisation* are excluded, and a
request naming a file inside one returns `404 File not found` without
`supportsAllDrives` — an error that reads as a wrong id rather than as a missing
capability.

Verified against the live deployment afterwards: for the work account, **the
three most recently modified files in the entire Drive were all invisible**, and
"what did I touch most recently" returned a five-day-old answer with nothing to
indicate anything was missing.

`supportsAllDrives` is applied in one wrapper rather than at each of the eighteen
call sites, so a later endpoint cannot silently reintroduce the gap. Which
methods accept it comes from the v3 discovery document, not from memory:
`files.export`, `comments` and `replies` do **not** take it.

## 6 — Writes land on files you own

Reaching shared drives widened writes as well as reads, and a shared drive holds
colleagues' documents. The rule now:

| Situation | What happens |
|---|---|
| You own the file | The write just happens |
| You do not own it | A **private copy** is made in your My Drive and edited there |
| You want the original | `edit_original` returns a **draft** and writes nothing |
| The user approves the draft | `confirm_edit` applies it |

Three things worth keeping straight:

- **Everything in a shared drive counts as not yours**, including files you
  created there, because a shared drive is owned by the organisation. That is
  the correct reading for this purpose: those documents are colleagues' to lose.
- **The copy must name `parents: ['root']`.** `files.copy` with no parent puts
  the copy beside the source, which for a shared-drive file means the copy lands
  in that same shared drive — still not private. This is easy to get wrong and
  there is a test for it.
- **Sharing and trashing have no copy path**, only a draft. Copying a colleague's
  document and sharing *that* spreads their content further, not less.

**A shared drive you are not a member of cannot be named.** Its id is also its
root folder's id, which suggests `files.get` should name it — but reaching a file
inside a drive grants nothing on the root folder above it, so that call answers
`File not found`. This was built, deployed, and only then found not to work,
because the test stub answered where the real API refuses. It now reports
`shared_drive_member: false` instead. The lesson is narrow and worth keeping: a
stub proves the code sends what you meant, never that the service permits it.

**Revoking and restoring are never gated.** `unshare_file` and `untrash_file`
work without confirmation even on files you do not own. The asymmetry is the
point: widening access needs approval, narrowing never does, and a brake that
needs permission is not a brake.

## 7 — One operator became many people

Everything before this assumed a single user. `MCP_ADMIN_PASSWORD` gated the
consent screen, and the token it produced carried `sub: 'owner'` — a constant.
`gmail_accounts.owner_key` existed and every query filtered on it, but only one
value was ever written, so the column separated nothing. That is correct for a
connector one person runs for themselves, and it is disqualifying the moment a
second person can add the URL: knowing the password would have meant reading the
first person's mail.

**Identity comes from Google, not from a local account.** A password proves
someone knew a secret; opening this up needs to know *which person* is asking.
Adding usernames and passwords here would have meant storing credentials,
resetting them, and getting all of that right. Google is already the identity
provider for every mailbox this server talks to, and every user of it
necessarily has a Google account, so the sign-in asks Google — for identity
only: `openid`, `email`, `profile`, no offline access, reading nothing.

**The key is Google's `sub`, not the email address.** An address can be renamed
or reassigned to a new person, and an owner key that moves between humans hands
one person another's mailboxes. `sub` is stable and opaque. The `google:` prefix
leaves room for a second provider later without collisions.

**Sign-in reuses the existing redirect URI.** Identity and mailbox-linking are
different grants that meet at `/gmail/oauth/callback` and are told apart by a
`purpose` claim in the signed state. A second redirect URI would have been
tidier, but it would have required every existing deployment to edit its OAuth
client in the Cloud console before the upgrade worked. Reusing the one already
registered means the change is deploy-and-go.

**Codes and refresh tokens carry the owner too.** This is the part that would
have been easy to miss: `mcp_auth_codes` and `mcp_refresh_tokens` had no owner
column, so identity established at the consent screen would have been lost at
the first refresh and quietly fallen back to a shared subject — a leak that
appears hours later, in working software, with no error. `issueAuthCode` and
`issueTokens` now refuse to run without an `ownerKey` rather than defaulting to
one, because a default is how the constant would come back.

**The cutover adopts rather than abandons.** An upgraded deployment holds rows
keyed `'owner'` that no identity can now reach — indistinguishable from data
loss to the person who linked them. `LEGACY_OWNER_EMAIL` names who they belong
to, and their first sign-in re-keys them. Idempotent, and unset afterwards.

**What proves it.** `npm run test:isolation` stubs the account store so that
fetching a token for a mailbox its owner does not own *throws*, then asserts the
owner key survives a refresh, that two callers see disjoint mailboxes, that
naming another person's address is refused — including through the partial-match
convenience path, which is the one that would actually have slipped — and that a
session cookie and an MCP token cannot be used as each other. A leak fails loudly
in the suite instead of returning plausible data in production.

## 8 — AOL, the first mailbox that is not Google

The argument in entry 1 does not care which provider the second mailbox is at.
Someone whose other address is AOL had the same relink-ask-relink problem, plus a
second app to check.

**An app password, because there is no other door.** AOL's mail platform offers
OAuth to mail clients only on an approved partner list. An app password is the
supported route for everyone else: generated for one app, mail-only, deletable
without touching the real password. It is stored exactly as Google tokens are
(AES-256-GCM under `TOKEN_ENC_KEY`), and only after it has signed in to both IMAP
and SMTP, so a typo is caught on the link page rather than on Claude's first call.
Hosts live in `imap_providers.js` and never in a request or a row, so linking can
never become "make the server connect where I say".

**Behind the same tools, not beside them.** A parallel `aol_*` set would have
doubled the surface and lost the property the server exists for — one search
across every mailbox. `imap_api` exports `gmail_api`'s functions with
`gmail_api`'s result shapes, and `mailFor` / `fanOutMail` hand each tool the right
client per mailbox. Calendar, Drive, Contacts and Tasks stay Google-only, and
naming an AOL address to one of them says "mail only" instead of "not linked".

**Libraries this time, deliberately.** Entry 4's standard-library rule was about
parsing a file format, where the risk is plausible wrong text and the job is
bounded. IMAP is a stateful protocol with literals, continuations and server
quirks; MIME decoding needs every legacy charset; SMTP needs AUTH and dot-
stuffing. `imapflow`, `mailparser` and `nodemailer` are the maintained standard
for each. They are pinned to exact versions at least two weeks old — `imapflow`
had shipped twice on the day this was written — and both run with logging off,
because their debug logs would otherwise be the one place a password could land.

**What replaces `gmail.modify`.** Gmail's "cannot delete permanently" is a
property of the grant. An app password can do anything, so for AOL it became a
property of the code instead, which is weaker and worth saying plainly:

- The only expunge in `imap_api.js` is `removeDraft`: one UID, in Drafts, by
  `UID EXPUNGE`. Without UIDPLUS a plain `EXPUNGE` would also take every other
  `\Deleted` message in the folder, so the draft goes to Trash instead.
- imapflow emulates MOVE with copy-and-expunge on servers that lack it. Moves
  refuse a server with neither MOVE nor UIDPLUS rather than reach that path.
- Deleting a Gmail label keeps the mail; deleting an IMAP folder deletes it. So
  `delete_label` on AOL refuses any folder that still holds a message.
- `test:imap` asserts that every expunge the scripted server ever saw was a
  single draft, in Drafts.

**Refuse what does not translate.** Gmail search syntax compiles to IMAP SEARCH.
An operator with no equivalent — `category:`, `is:important`, `filename:` — is
refused by name, because dropping it would widen the search and return results
that look like an answer to the question that was not asked (principle 2).
`in:`/`label:` pick folders and `has:attachment` is checked against body
structure, so those three must apply to the whole query and are refused inside
`OR` or parentheses rather than half-applied.

**Ids move.** An IMAP id is folder + UID, so archiving gives a message a new id.
Every moving call returns the new one. UIDVALIDITY rides inside the id, so an id
from a folder the server renumbered is refused as stale instead of silently
naming whichever message now holds that UID.

**What the first live link found** (entry 6 again: the stub had said yes to all
of it). Linking, search, reading, drafts and folder listing worked first time.
Three things did not, and each is now in `test:imap` as an "AOL as measured"
server so it cannot quietly come back:

- **Threads came back empty.** AOL's `SEARCH HEADER` matches Message-ID but
  never References or In-Reply-To (and takes ~8 s to say so), and an `OR` that
  includes either matches *nothing*, taking the Message-ID branch down with it.
  AOL does have OBJECTID, and the THREADID it reports in FETCH is right across
  folders — a reply in Sent carries its original's — but `SEARCH THREADID` found
  the original one time in three. So threads are now gathered by reading
  THREADID off each folder's newest 500 messages, plus a Message-ID search for
  ancestors; References/In-Reply-To are searched only on servers without
  THREADID, and separately.
- **Previews were CSS.** Marketing mail spends its first kilobytes on `<head>`
  and `<style>`; a partial fetch cut inside them, and the HTML-to-text pass
  expects whole documents. Snippets now read 16 KB and strip unclosed head,
  style and comments, and a half-fetched tag.
- **Everything took 8–13 s.** AOL answers each command in 0.4–0.9 s and signing
  in takes four of them. Connections are now kept for a minute between calls,
  part 1 rides along with the summary fetch, and empty folders skip SEARCH. A
  read or a draft is now 0.3–1.5 s; a search across folders is still ~4–8 s and
  a thread ~9–12 s, because the floor is round trips × folders. Searching
  folders in parallel over a few connections is the next step if that matters.

Still unproven: whether AOL files an SMTP submission in Sent itself. Nothing
was sent during the live test; the code checks Sent for the Message-ID and
appends only when it is absent, so either answer leaves exactly one copy.

---

## Principles that keep applying

1. **Every outward action needs an undo, and that is the condition for offering
   it.** `unshare_file` and `untrash_file` exist because `share_file` and
   `trash_file` do. Claude's first-party connector has neither.
2. **Refuse rather than return plausible nonsense.** Text that reads correctly
   and says the wrong thing is worse than an error.
3. **Assert on what goes over the wire, not on the return value.** The failures
   worth catching here are calls that succeed while asking the wrong question,
   and only a wire-level assertion sees those. Hence `global.fetch` stubs
   throughout the suites.
4. **Prefer a structural guarantee to a convention.** `gmail.modify` makes
   permanent deletion impossible; a rule saying "don't call the delete endpoint"
   would not.
5. **Check the API's own discovery document rather than recalling it.** It
   settled which Drive methods accept `supportsAllDrives`, and it disproved an
   assumed conflict between `corpora=allDrives` and `orderBy`.
6. **A count in a README is a test.** Tool counts and check totals are asserted
   in the suites, so documentation that drifts fails the build.

## Operational notes

- Deployed on **Railway**, which auto-deploys from `main`.
- While the Google app stays in **Testing**, refresh tokens expire after 7 days
  and accounts must be re-linked. Publishing stops that, but Gmail, Drive and
  Contacts are restricted scopes, so Google verification applies — and because
  Google data is stored server-side, so does a CASA security assessment, renewed
  annually. That is the long pole on making this public; start it early.
- Granted scopes are fixed at link time and Google will not extend them
  retroactively. Adding a product means re-visiting `/gmail/connect` per account;
  `list_accounts` reports which products each grant actually covers.
- `npm run smoke` is a read-only live check against the deployment, allow-listed
  by construction, reporting counts rather than contents.
