# Demo video — 6-minute recording script

Google verification wants proof that (a) the consent screen is honest and (b) each
permission actually gets used. That's the whole video. Phone-quality is fine.

**Before you hit record**
- Sign out of the connector first so the consent flow is fresh:
  open `https://hub.grounders.app/gmail/signout` in Chrome (it just clears the cookie).
- Have a normal Claude chat open in another tab with the **Google MCP** connector on.
- Start recording your screen: **Win + Alt + R** (Windows Game Bar).

---

## Part A — the consent flow (~90 sec)  *the part Google scrutinizes*

1. Go to `https://hub.grounders.app/gmail/connect`.
2. Click **Continue with Google**, pick **brisebyme@gmail.com**.
3. On "Google hasn't verified this app" → **Advanced** → **Go to hub.grounders.app**.
   *(Pause a beat here so the screen is readable — this is the key frame.)*
4. On the consent screen, let the **list of permissions** sit on screen for ~3 seconds
   (Gmail, Calendar, Drive, Contacts, Tasks), then **Continue**.
5. You land on the "✓ linked" page. Good — that's Part A.

## Part B — each permission in use (~3 min)

In the Claude chat, paste this and let it run, showing each result:

> Using the Google MCP connector, do these one at a time and show me the result of
> each before moving on:
> 1. Search my Gmail across both accounts for messages about "invoice" in the last month.
> 2. List my calendar events for this coming week across both accounts.
> 3. Find any file in my Google Drive and read me its first paragraph.
> 4. Look up the email address for one of my contacts.
> 5. Add a task called "Google MCP demo" to my task list, then show my task lists.

That single prompt exercises all five scopes: Gmail (search/read), Calendar (read),
Drive (search + read), Contacts (read), Tasks (write + read). Let each tool call and
its result show on screen.

## Part C — data deletion (~30 sec)

1. Back to `https://hub.grounders.app/gmail/connect`.
2. Open **"Delete everything"**, type `delete`, click the button.
3. Show the "Everything is deleted" confirmation page.

**Stop recording (Win + Alt + R).**

---

## After

- Upload to YouTube as **Unlisted**, copy the link.
- Paste it to me and we submit verification together — the written answers are all
  pre-filled in `VERIFICATION.md`.
- **Then re-link both accounts** at `/gmail/connect` (Part C deleted them for the demo —
  that's the point, it proves deletion works, but you'll want them back). I'll walk you
  through it, ~1 min.

One tip: if you fumble a step, just keep going and re-do it — you can trim in YouTube's
editor, or honestly Google's reviewers don't mind a retake mid-video. Don't aim for
polished; aim for "clearly shows the thing happening."
