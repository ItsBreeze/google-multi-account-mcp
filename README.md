# Google Multi-Account Connector

A remote [MCP](https://modelcontextprotocol.io) server that gives Claude access to
**several Google accounts at once** — Gmail, Calendar, Drive, Contacts and Tasks.
Claude's built-in Google connectors each hold exactly one account; connecting a
second replaces the first. This holds as many as you link, and every search tool
fans out across all of them in a single call.

You run it yourself. It holds your Google tokens in your own database, encrypted,
and talks to Google directly — nothing passes through a third party.

Node and Postgres, four tables, and no dependencies beyond Express, `pg` and
`jsonwebtoken`. Document text extraction — PDF, Word, Excel, PowerPoint,
OpenDocument — uses only Node's standard library.

**Status:** running in production against real mailboxes, with 435 automated
checks. Built for one person's needs and published because the one-account limit
is not unique to them. Treat it as working software with a small user base, not
as a hardened product.

## Quick start

```bash
git clone https://github.com/ItsBreeze/google-multi-account-mcp.git
cd google-multi-account-mcp
npm install
cp .env.example .env      # fill it in — see Setup below
npm run migrate           # creates the four tables
npm start
```

Then deploy it somewhere with a public HTTPS URL (Railway, Fly, Render, a VPS —
anything that runs Node and reaches Postgres) and follow **Setup**.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp` | MCP Streamable HTTP endpoint (Bearer auth) |
| GET | `/mcp/oauth/authorize` | Consent screen — operator password |
| POST | `/mcp/oauth/token` | Token + refresh grants |
| POST | `/mcp/oauth/register` | RFC 7591 dynamic client registration |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728 discovery |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 discovery |
| GET | `/gmail/connect` | Link an account (repeat per account) |
| POST | `/gmail/unlink` | Unlink one, revoking the grant at Google |

## Tools (54)

Every tool takes an optional `account`. On a search, **omitting it fans the call
out across every linked account** and merges the results — the thing no
single-account connector can do. On a write it names the one account to act on,
so "create this event" is never ambiguous about whose calendar it lands in.

### Gmail (23)

| Area | Tools | Notes |
|------|-------|-------|
| Accounts | `list_accounts` | Which accounts are linked, with token health |
| Search | `search_messages`, `search_threads` | Gmail query syntax, merged and date-sorted across accounts. `search_threads` returns one row per conversation — subject, every participant, message and unread counts, last activity — for "where does my thread with X stand" without pulling bodies |
| Read | `get_message`, `get_thread`, `get_attachment` | Bodies flattened to text and capped at 60 KB; attachment metadata included. **`get_attachment` extracts text from PDF, Word, Excel, PowerPoint and OpenDocument attachments**, so an emailed contract or invoice is readable directly; anything else comes back base64 (2 MB cap) |
| Send | `send_message`, `reply_to_message`, `forward_message` | Replies thread via `In-Reply-To`/`References`; forwards carry attachments (10 MB cap, skipped ones named) |
| Drafts | `create_draft`, `list_drafts`, `get_draft`, `update_draft`, `send_draft`, `delete_draft` | `create_draft` with `reply_to_message_id` drafts an in-thread reply for review — the safe path for AI-written mail |
| Labels | `modify_labels`, `list_labels`, `create_label`, `update_label`, `delete_label` | `modify_labels` takes `message_id` or `thread_id`; removing `INBOX` archives |
| Trash & spam | `trash_message`, `untrash_message`, `mark_spam` | All take `message_id` or `thread_id`; trash is recoverable for 30 days; `mark_spam` with `unmark: true` restores |

### Calendar (9)

| Area | Tools | Notes |
|------|-------|-------|
| Read | `list_calendars`, `list_events`, `search_events`, `get_event` | `list_events` merges every linked calendar into one timeline, defaulting to the next 7 days; recurring series are expanded into actual occurrences, so a weekly standup appears on each day it happens |
| Write | `create_event`, `update_event`, `delete_event` | Times are ISO 8601; a bare `YYYY-MM-DD` means all-day. `update_event` patches — unmentioned fields keep their value. Attendees are **not** emailed unless `send_updates` says so |
| Repeats | `create_event`, `update_event`, `delete_event` | `repeat: "weekly"` (with `repeat_count` or `repeat_until`) covers the ordinary cases; `recurrence` takes full RFC 5545 rules. On a repeating event, `scope` chooses one occurrence or the whole series — see below |
| RSVP | `respond_to_event` | accepted / declined / tentative, as the account that was invited; notifies the organiser by default |
| Scheduling | `suggest_time` | Free slots across **every** linked calendar at once — busy anywhere means busy. Returns whole gaps rather than chopping a 3-hour opening into six half-hour slots |

### Drive (15)

| Area | Tools | Notes |
|------|-------|-------|
| Find | `search_files`, `list_recent_files`, `get_file_metadata`, `list_shared_drives` | Text search over names and contents, with optional raw Drive query syntax in `filter`. **Covers My Drive and every shared drive at once**; `drive_id` narrows to one. Trashed files excluded unless you ask for them |
| Read | `read_file_content`, `download_file_content` | Docs, Sheets and Slides exported (Sheets as CSV); **PDF, Word, Excel, PowerPoint and OpenDocument extracted to text**; `ocr: true` routes scans and images through Google's own conversion; `include_comments` returns the comment threads. `download_file_content` takes `export_as` — turn a Doc into a PDF or docx, a Sheet into xlsx. Text caps at 60 KB, binaries at 2 MB base64 |
| Write | `create_file`, `update_file`, `copy_file` | Text via `content`, binary via `content_base64`. `convert_to` makes Drive convert the upload into an editable Doc, Sheet or Slides — or a folder. `update_file` renames, moves and describes; overwriting contents additionally needs `replace_content: true`. **On a file you do not own it edits a private copy** — see below |
| Comment | `comment_on_file` | Leave a comment on a draft, or reply to a thread — the review path that changes nothing in the document |
| Sharing | `get_file_permissions`, `share_file`, `unshare_file` | Shares with one named person at reader/commenter/writer. Domain-wide and public-link sharing are off unless `DRIVE_ALLOW_PUBLIC_SHARING=true`, and then still need `confirm_public`. **`unshare_file` withdraws access** — by person, by domain, or by removing the public link |
| Remove | `trash_file`, `untrash_file` | Trash and restore, within the 30-day window — see the scope note below |

### Contacts (2) and Tasks (5)

| Area | Tools | Notes |
|------|-------|-------|
| Contacts | `search_contacts`, `list_contacts` | Read-only. Searches saved contacts **and** people the account has corresponded with, so "email Ann" resolves to an address instead of a guess |
| Tasks | `list_task_lists`, `list_tasks`, `create_task`, `update_task`, `delete_task` | `list_id` defaults to the account's first list. `update_task` with `completed: true` ticks a task off; `false` reopens it. Google Tasks has no trash, so `delete_task` is permanent |

## Document text extraction

`read_file_content` and `get_attachment` both return text for PDF, Word, Excel,
PowerPoint and OpenDocument files, using only Node's standard library — no
parsing dependency to vendor, audit or keep current.

| Format | How | Notes |
|--------|-----|-------|
| .docx / .odt | ZIP + XML | Paragraphs, tabs and line breaks preserved; styles and revision marks dropped |
| .xlsx / .ods | ZIP + XML | One CSV block per sheet, named from the workbook relationships. Cells are placed by column letter, so a gap stays a gap |
| .pptx / .odp | ZIP + XML | One block per slide, in presentation order |
| .pdf | Content-stream parsing | Flate, ASCII85 and ASCIIHex filter chains; literal, hex and octal strings; positioning operators become line breaks |

**Where it stops, and what happens then.** Two kinds of PDF have no text to
extract: a scan, which is a picture of a page, and one whose fonts are CID-keyed
or subset, where the bytes in the content stream are glyph numbers that need the
font's own tables to become letters. Both would decode into confident-looking
nonsense, so the result is scored for readability and **refused** rather than
returned — the refusal names the cause and points at the fix.

That fix is `ocr: true` on `read_file_content`, which copies the file as a Google
Doc (Drive runs OCR during that conversion), exports the text, and deletes the
copy in a `finally` block. It reads scans, photographs and images. Two things
worth knowing: it is the one place this server writes to Drive during a read, and
that delete is the only permanent delete in the whole server — its target is a
file created seconds earlier by that same call, never anything the user put
there. If the cleanup itself fails, the result says so and names the file.

Extraction is capped at 60 KB like every other body, with the cut flagged.

## Shared drives

A shared drive is owned by an organisation rather than by a person, which is
where a company's actual documents live. Drive's own default hides them: a
`files.list` without `corpora=allDrives` searches only My Drive and files shared
directly with the account, and a request naming a file inside a shared drive
comes back `404 File not found` unless it carries `supportsAllDrives` — an error
that reads as a wrong id rather than as a missing capability.

Every Drive request that accepts that parameter now carries it, applied in one
place rather than at each of the eighteen call sites, so the next endpoint added
cannot quietly reintroduce the gap. Which methods accept it is not a guess: it
is taken from the v3 discovery document, and `files.export`, `comments` and
`replies` are deliberately left out because they do not take it.

Searches therefore span My Drive and every shared drive by default, and results
name the drive a file came from rather than just its id. Google recommends
narrowing where you can, so `list_shared_drives` gives the ids and `drive_id`
confines a search to one.

This widens what writes can reach as well as reads: a file in a shared drive was
previously unreachable by `update_file`, `share_file` or `trash_file`, and now is.
Since a shared drive holds an organisation's documents rather than one person's,
that is exactly the case the ownership rule below exists for.

A drive is named where it can be, and says so where it cannot. `drives.list`
covers the drives this account is a **member** of, paged rather than cut off at
Drive's hundred-per-call — an account in more drives than that would otherwise
have the overflow look like non-membership.

A file can also reach you from a drive you are *not* in, through a folder shared
directly. Such a drive cannot be named at all. Its id is also its root folder's
id, but reaching a file inside a drive grants nothing on the root folder above
it, so asking answers `File not found` — verified against a real Workspace
account, where two of three drives holding recent files were reached this way.
Those carry `shared_drive_member: false` rather than a bare id, so "no name
available" is distinguishable from "lookup failed".

## Writes land on files you own

A file owned by someone else — or by an organisation, which is **every file in a
shared drive, including ones you created there** — is not this connector's to
change on a model's judgement.

| Situation | What happens |
|---|---|
| You own it | The write happens |
| You do not | A **private copy** is made in your My Drive and edited there |
| You want the original | `edit_original: true` returns a **draft** and writes nothing |
| The user approves | `confirm_edit: true` applies it |

The draft is the point. It states each field as `from → to`, and for a content
replacement it reads what is there now and shows **the lines that actually
change** — not just "this will overwrite 40 KB". Binary content says a preview is
impossible rather than faking one. Nothing is written until a second call
arrives, so a person sees the specific change before it lands rather than being
told afterwards which of their colleague's documents moved.

The private copy names `parents: ['root']` deliberately: `files.copy` with no
parent puts the copy beside the source, which for a shared-drive file would leave
it in that same shared drive — still not private.

`share_file` and `trash_file` draft too, but have **no copy path**: copying a
colleague's document and sharing that spreads their content further, not less.

**Revoking and restoring are never gated.** `unshare_file` and `untrash_file`
work without confirmation on any file, yours or not. Widening access needs
approval; narrowing never does. A brake that needs permission is not a brake.

## Repeating events

`list_events` expands a series into its occurrences — "what's on Tuesday" means
the standup that Tuesday, not the rule that generates it. The consequence is that
the id in hand is almost always one occurrence, and Google offers no flag saying
whether an edit was meant for that occurrence or for all of them.

So `update_event` and `delete_event` take a `scope`:

| scope | Effect |
|---|---|
| `this_event` (default) | Changes only the occurrence named by `event_id` — "move tomorrow's standup" |
| `series` | Resolves the occurrence back to its series and changes every one — "make it 10am from now on" |

Reads carry `recurring_event_id`, which is what makes that resolution possible at
all, and the result of every write says which it actually did. That matters in
one direction especially: an id naming the series itself changes every occurrence
even under `this_event`, because that is what patching a series does — so the
result says `applies_to: "series"` rather than letting it pass silently.

Creating a repeating event takes `repeat: "daily" | "weekly" | "monthly" |
"yearly"`, with `repeat_count` or `repeat_until` to end it. Anything those cannot
say — every second Tuesday, weekdays only — goes in `recurrence` as RFC 5545
lines. Those are checked here rather than at Google: a rule with no `FREQ`, an
unknown frequency, or a `DTSTART` line all come back naming the problem, where
Google answers a generic `400`. A repeat rule belongs to a series and is silently
dropped if written to one occurrence, so that is refused too.

## Setup

1. **Google Cloud** — create a project; enable the **Gmail, Calendar, Drive, People
   and Tasks** APIs; configure the consent screen as **External**, and add every
   Google address you plan to link as a **test user**. Create an OAuth client of type
   **Web application** with the authorized redirect URI set to exactly
   `<PUBLIC_BASE_URL>/gmail/oauth/callback`.
2. **Env** — set `DATABASE_URL`, `PUBLIC_BASE_URL`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `MCP_ADMIN_PASSWORD`, `TOKEN_ENC_KEY` and `JWT_SECRET`
   (see `.env.example`), then deploy. The schema applies itself on boot.
3. **Link accounts** — visit `<PUBLIC_BASE_URL>/gmail/connect` once per account.
4. **Add to Claude** — Settings → Connectors → Add custom connector →
   `<PUBLIC_BASE_URL>/mcp`. Claude registers itself, sends you to the consent
   screen, and you enter `MCP_ADMIN_PASSWORD` once.

> **If you linked accounts before adding a product:** the granted scopes are fixed at link
> time, so an account linked before Calendar, Drive, Contacts and Tasks existed
> holds a Gmail-only grant. Google will not extend it retroactively. Visit
> `/gmail/connect` again for each account — that adds the missing access and
> changes nothing else. Until then the new tools name the account and say to
> re-link it, rather than failing with an opaque 403.

## Deploying

Any host that runs Node and reaches Postgres works. There is nothing to build,
no container to define, and the schema applies itself on boot — a fresh
deployment needs only environment variables.

### Environment

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres. The four tables create themselves on first boot |
| `PUBLIC_BASE_URL` | The public origin, scheme and host only, no trailing slash. Becomes the OAuth issuer and the Google redirect URI, so it must match what Google has registered |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From the Web application OAuth client |
| `MCP_ADMIN_PASSWORD` | Gates linking an account and approving Claude's consent. The only thing between a stranger who finds the URL and your mailboxes — make it long |
| `TOKEN_ENC_KEY` | 32 bytes, base64. Encrypts Google tokens at rest. **Losing or changing it makes every stored token undecryptable** |
| `JWT_SECRET` | Any long random string; signs MCP tokens via a derived key. Changing it only forces Claude to authenticate again |
| `PORT` | Optional, defaults to 3000. Most platforms set this for you |

`/gmail/check` diagnoses a bad Google client without running the whole consent
round-trip, and reports which of the two variables Google rejected. Values are
never echoed back.

### On Railway

Create a project from this repository and add a Postgres service, which
provides `DATABASE_URL` for the app service to reference. Set the rest above, take the generated domain as
`PUBLIC_BASE_URL`, and register `<PUBLIC_BASE_URL>/gmail/oauth/callback` as an
authorized redirect URI on the OAuth client. Pushes to the default branch
redeploy automatically.

### Moving an existing deployment

Two facts make this a cutover rather than a migration, with no downtime and no
re-linking:

- **Point the new deployment at the same database.** The schema is
  `CREATE TABLE IF NOT EXISTS`, so it is a no-op against tables that already
  exist, and every linked account carries over untouched.
- **Carry `TOKEN_ENC_KEY` across unchanged.** Tokens are AES-256-GCM, which is
  authenticated: a different key fails the tag check and throws rather than
  returning nonsense, so the failure is loud — but every account is unusable
  until the original key is restored.

An OAuth client accepts several redirect URIs, so **add** the new deployment's
callback rather than replacing the old one. Both deployments can then run side
by side against the same database — nothing else writes those four tables —
which leaves room to verify the new one before retiring the old.

Expect Claude to authenticate once more afterwards if `JWT_SECRET` changed.
Linked Google accounts survive it: they are keyed to a constant subject, not to
any particular token.

## Security notes

- Google refresh and access tokens are AES-256-GCM encrypted at rest under
  `TOKEN_ENC_KEY`. The database never holds a usable token.
- **Mail cannot be permanently deleted.** The Gmail scope is `gmail.modify`:
  read, send, label, archive, trash. It deliberately excludes `mail.google.com`,
  so `trash_message` is recoverable for 30 days and nothing here can destroy mail.
- **Drive is different, and the difference is worth knowing.** Drive has no
  equivalent middle scope: `drive.file` only sees files this app itself created,
  which cannot answer "find my lease", so searching and editing existing files
  needs full `drive` — which *does* permit permanent deletion. There the limit is
  enforced by the tool surface instead: `trash_file` trashes, and no tool reaches
  Drive's permanent-delete endpoint. That is a weaker guarantee than Gmail's,
  because it is a matter of what is exposed rather than what is possible.
- **Every outward action has an undo, which is the condition for offering it.**
  `unshare_file` withdraws any grant `share_file` can make, and `untrash_file`
  restores what `trash_file` removed. The first-party connector has neither,
  so a permission it grants cannot be taken back through the same interface.
  This is the one place the wider surface here is also the safer one.
- **Contacts are read-only** by scope, not just by omission.
- **Drive writes are guarded where the first-party connector is simply narrower.**
  Claude's Drive connector shares with one email address and a role — it has no
  way to publish a file — and its `update_file` changes only the title and parent.
  Two guards match that default, because both failures are one-way and neither
  looks alarming in a tool result:
  - `share_file` takes a named person only. Domain-wide and public-link sharing
    need `DRIVE_ALLOW_PUBLIC_SHARING=true`, and are refused outright otherwise
    rather than quietly narrowed to something safer. Even enabled, they need
    `confirm_public: true` as a second signal, and the refusal spells out what
    the grant would actually mean before it is repeated.
  - Overwriting a file's contents needs `replace_content: true` alongside
    `content`, so a rename can never destroy a document as a side effect.
- Authorization codes are single-use and hashed; PKCE S256 is required; refresh
  tokens rotate on every use; `redirect_uri` must match the registration exactly.
- While the Google app stays in **Testing**, refresh tokens expire after 7 days
  and accounts must be re-linked. Publishing the app stops that, but Gmail, Drive
  and Contacts are all restricted scopes, so Google verification applies.

## Architecture

```
src/services/google_http.js     shared transport: URL building, bearer auth,
                                error unwrapping, bounded-concurrency mapLimit
src/services/gmail_api.js       one thin client per Google API, each returning
src/services/calendar_api.js    shaped results rather than raw payloads
src/services/drive_api.js
src/services/people_api.js
src/services/tasks_api.js
src/services/office_text.js     .docx/.xlsx/.pptx/.odt text, via a ZIP reader
src/services/pdf_text.js        PDF content-stream text, with a readability guard
src/services/text_extract.js    one entry point both Drive and Gmail read through
src/services/gmail_accounts.js  linked accounts, token refresh, scope gating
src/mcp/shared.js               resolveAccount / tokenFor / fanOut / mergeSearch
src/mcp/tools/                  one module per product, assembled by index.js
```

Rate limits are respected rather than discovered: Google meters quota per user
per second, so per-item detail fetches run five at a time, and a fetch that fails
anyway is **counted** in `unavailable_*` rather than silently dropped from the
results.

## Tests

Eleven suites, all plain Node — no framework, no new dependencies. 435 checks.

```bash
# No database, no network:
npm run test:tokens     # MCP and user tokens cannot be swapped, in either direction
npm run test:query      # Google query-string construction (repeated array params)
npm run test:mime       # entity decoding, body truncation, MIME construction
npm run test:threads    # address parsing, thread summaries, cross-account fan-out
npm run test:products   # free-slot arithmetic, Drive query quoting, multipart
                        # upload framing, task dates, scope gating, tool-surface shape
npm run test:drive-safety   # the sharing and overwrite guards, both env states
npm run test:extract    # PDF and Office text extraction, against real fixtures
npm run test:drive-parity   # upload framing, conversion, export and comments, on the wire
npm run test:reach      # shared-drive request parameters, recurrence rules, and which
                        # event a scoped write actually lands on
npm run test:ownership  # which file id a write reaches, that a draft writes nothing,
                        # and that revoking is never gated

# Needs a database:
DATABASE_URL=postgres://…  npm run test:accounts   # resolution + encryption at rest

# Needs the API running:
npm start &
TEST_BASE_URL=http://127.0.0.1:3000  npm run test:mcp   # OAuth + MCP protocol
```

## Mounting it inside an existing app

`src/app.js` is the whole standalone server and contains nothing but the
connector, so embedding it is a copy of that file's body: require the two
routers (`routes/mcp`, `routes/gmail_link`), keep the rate limits and the four
`.well-known` discovery routes, and run the migration alongside your own.

One thing not to skip: MCP tokens are signed with a key **derived** from
`JWT_SECRET` by HMAC rather than with `JWT_SECRET` itself. If your app signs its
own user tokens with that secret and verifies them without an audience check,
sharing the key would make every connector token a valid user token for your
app. `npm run test:tokens` asserts the separation in both directions.

## Contributing

Issues and pull requests are welcome. Two conventions worth knowing first:

- **Suites are plain Node** — no framework, no new dependencies. Each is a file
  under `test/` with an `npm run test:<name>` script, one line per check, and a
  non-zero exit on failure.
- **Tests assert on what goes over the wire.** They stub `global.fetch` and
  check the query parameters, the request path, the multipart framing. The
  failures worth catching here are calls that succeed while asking the wrong
  question, and only a wire-level assertion sees those.

`PROJECT-LOG.md` records why things are the way they are, including the
alternatives that were rejected. Read it before changing a decision.

## License

MIT — see [LICENSE](LICENSE).
