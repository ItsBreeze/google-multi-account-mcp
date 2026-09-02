# OAuth verification packet

Everything the Google verification submission asks for, pre-written. Submit from
[Verification Center](https://console.cloud.google.com/auth/verification?project=work-gmail-507122)
in the Work Gmail project (`work-gmail-507122`) — **after** the domain cutover to
`mcp.grounders.app`, so the consent-screen links reviewers click are the final ones.

Prerequisites already met: `grounders.app` verified in Search Console (2026-09-01,
brisebyme@gmail.com); home/privacy/terms live; app published to Production.

---

## Per-scope justifications (paste into the submission form)

The pattern reviewers accept: what user-visible feature the scope powers, why the
narrower scope doesn't work, what happens to the data.

**`gmail.modify`** —
The app is a connector that lets a user's AI assistant (Claude, via the Model
Context Protocol) work across the several Gmail accounts the user links: search
and read mail, create and update drafts, send, label, archive, and move messages
to trash — always as an explicit user instruction relayed by their assistant.
Read-only scopes cannot support the write half of the product (drafting, sending,
labeling, archiving), and `gmail.send` alone cannot support reading or organizing.
`gmail.modify` is deliberately preferred over full `mail.google.com` access: it
excludes permanent deletion, so no action the connector can take destroys mail
irrecoverably. Message content is fetched on demand, relayed to the user's
assistant, and never stored on the server; only OAuth tokens are stored,
encrypted with AES-256-GCM.

**`calendar`** —
Users view a merged agenda across every linked account's calendars, search events,
check free/busy to suggest meeting slots, create and update events, and respond to
invitations, through their assistant. Read-only calendar scope cannot support
event creation, editing, or responses. Event data is fetched on demand and never
stored.

**`drive`** —
Users search, read (including text extraction from Office documents and PDFs),
create, edit, share, and trash files in the linked accounts' Drives, through
their assistant. `drive.file` is insufficient because the core feature is
searching and reading files the user already has — files the app did not create.
Permanent deletion is not exposed anywhere in the tool surface; every
destructive action stops at trash. File content is fetched on demand and never
stored.

**`contacts.readonly` + `contacts.other.readonly`** —
When the user tells their assistant "email Ann", the connector resolves the name
to an address from the account's contacts, including the "other contacts" that
Gmail auto-collects (which for most users is where most correspondents live).
Read-only by design: the connector never creates or modifies contacts. Contact
data is fetched on demand and never stored.

**`tasks`** —
Users read and update their Google Tasks lists across linked accounts through
their assistant. Read-only scope cannot support adding or completing tasks.

**`openid`, `userinfo.email`, `userinfo.profile`** —
Sign-in identity, and knowing which address a linked mailbox belongs to. The
Google `sub` of the signed-in user is the key that isolates each user's linked
accounts from every other user's.

## Limited Use statement

Already on the consent-screen privacy link (`/privacy`): use and transfer of
Google user data adheres to the Google API Services User Data Policy including
Limited Use — data is used only to provide the user-facing features above at the
user's request, is not used for advertising, is not sold, is not used to train
ML models, and is not read by humans except with explicit consent for support,
for security, or as required by law. Content is never persisted server-side;
only encrypted OAuth tokens are stored.

## Demo video — shot list (~6 minutes, unlisted YouTube)

Record one continuous screen capture, English narration or on-screen captions:

1. **Consent flow (the part they scrutinize):** open `https://mcp.grounders.app/gmail/connect`
   → sign in with Google → Continue to Google → show the account chooser, the
   consent screen with the app name and scope list, approve → land on the
   "Linked" page. Show the Privacy Policy link on the consent screen briefly.
2. **gmail.modify:** in Claude with the connector attached — search mail across
   accounts; open a message; draft a reply; send it; label/archive something;
   trash a message (and note aloud that permanent delete does not exist).
3. **calendar:** list this week's events across accounts; create an event;
   respond to an invitation.
4. **drive:** search files; read/extract text from a document; create a small
   file; share it with a named person; trash it.
5. **contacts (read-only):** "email <first name>" — show the name resolving to
   an address from contacts.
6. **tasks:** list task lists; add a task; complete it.
7. **Data deletion:** back on `/gmail/connect`, open "Delete everything", type
   the confirmation, show the deleted confirmation page.

Paste the video URL into the submission where it asks for a demonstration.

## After submitting

Because the app stores restricted-scope data (Gmail/Drive OAuth tokens) on a
server, Google will follow up requiring a **CASA Tier 2 assessment** — a
security review by an authorized lab, renewed annually. The follow-up email
names the labs; several offer a low-cost self-scan track for Tier 2. Until
verification completes the app runs published-but-unverified: users see the
"Google hasn't verified this app" interstitial and the lifetime cap is 100
users, of which 2 are used.

Expect at least one back-and-forth with the reviewers (they commonly ask for
scope-usage timestamps in the video or a clarified justification). Reply from
brisebyme@gmail.com, the project's developer contact.
