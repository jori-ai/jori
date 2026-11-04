When an Anytime Mailbox virtual mailbox emails that new mail arrived, look at the new envelope scans in the portal, work out who each piece is from and whether it is junk, and tell the user in one chat line. **Off until configured:** `agent/local/config/anytime-mail.json` `base_url` (the account's portal site); without it the script logs and exits 0.

## Purpose

A user requirement: when the virtual mailbox's "new mail" notice lands, open the portal, see what arrived, identify each sender from the scanned envelope, let Jev decide important vs junk (most of what such a box receives is junk, especially mail not addressed to its owners; one sender, e.g. a bank, can send both), and report in chat how many items came, from whom, and which are junk.

It replaces a P1 ping on each notice (the installation's P1 sender policy should not list the portal's notice address): the notice says nothing, the envelope does.

## Config

`agent/local/config/anytime-mail.json`:

| key | meaning |
|---|---|
| `base_url` | the account's portal site, `https://<site>.anytimemailbox.com`. Absent → the job is off. |
| `label` | how the chat line names the box ("the city mailbox"); default "the virtual mailbox" |
| `mailbox` | `{ name, address, owners[] }` — what the judge is told; `owners` are the names official mail uses (legal names, companies), which is how it tells the owners' mail from household and someone else's |

The installation's own Jev questions (`data/jev-questions/anytime-mail.json`) replace the kernel's (`agent/config/jev-questions/anytime-mail.json`, which names the owner through `{{owner_name}}`).

The intake step that files the notice and kicks this job is an installation hook (`agent/supervisor/_ext/gmail-intake.mjs` — the notice sender and its "not an arrival" template are the installation's), touching `data/.anytime-mail-kick` and running `agent/scripts/trigger-anytime-mail-check.sh`.

## Pipeline — scripted, no agent turn

```
Gmail push (the portal's notice sender, not its "Completed Action Requests" template)
  → the installation's intake hook (_ext/gmail-intake.mjs): file personal + read, no dispatch,
    touch data/.anytime-mail-kick, run trigger-anytime-mail-check.sh
  → launchctl kickstart ai.claude.anytime-mail-check (GUI session)
  → bin/anytime-mail-check
```

1. **Settle** 90 s (`ANYTIME_MAIL_SETTLE_S`) so a burst of notices is one run.
2. **Portal**, via one short-lived tab of its own in the host's automation Chrome (CDP `:9222`), closed at the end of the run. The tab never loads the portal UI: it goes straight to the JSON feed URL `/app/mailbox-ajax/inbox`. Ad and analytics hosts are blocked in the tab, and every wait is a page-load event. One in-page call returns the feed, diffed against the seen set (`malId`), plus a presigned S3 link for each new scan. The `/imagestore/<malId>.jpg?s3` XHR is aborted once its redirect resolves, so no image bytes pass through the browser. The portal's server session expires between notices, so most runs start on the login page: the script fills `f_uid` / `f_pwd`, presses the form's button and waits for the load (~2.5 s). A warm run takes ~1.6 s end to end.
3. **Scan + OCR**, with the tab already closed: Node downloads each scan from S3 into `data/anytime-mail/` and OCRs it on-device (`lib/photo-ocr.swift`, Apple Vision). Downloads, OCR and Jev run in parallel across envelopes. `ANYTIME_MAIL_SCAN_SIZE` picks the rendition (`""` full, `.s1000` 1000 px).
4. **Judge** (`lib/anytime-mail-jev.mjs`, questions `data/jev-questions/anytime-mail.json`): Jev answers `verdict` (important / junk / unclear, threshold 0.8), `recipient` (owner / household / someone_else / unreadable) and `sender` (a choice over the numbered OCR lines; a pick under 0.7 = unidentified). Below the threshold or on a Jev error, a tool-less Haiku reads the same OCR. The judgment is about the *mailing*, not the sender, so one bank's statements and the same bank's card offers come apart.
5. **Message**: one chat line via `jori-send-curl --intent anytime-mail --evidence-as-of live`, worth-opening first, then a bullet per piece (`- <sender> — looks important | junk | couldn't tell`, with "(to household)" / "(not addressed to you)" on junk), then the portal link. Silent when nothing is new.
6. **Re-check**: if the kick file is newer than the run's start (another notice landed meanwhile), go round again, at most 3 rounds.

Manual: `bin/anytime-mail-check --now`. Test on past mail without sending: `--dry-run --folder recycled --reprocess <malId>`.

## Mailbox owners

From the config's `mailbox.owners`. Mail to "The <Surname> Household", "Resident", or "X or Current Resident" is household mail and almost always junk.

## State file

`data/anytime-mail-state.json` (gitignored): `seen` = `{malId: {arrived, verdict, sender, recipient, source, ocr}}` kept 120 days; `last_run`; `session_broken` (ISO time) while the portal is signed out. Written atomically by the script only; `data/anytime-mail-check.lock` (PID) keeps runs single.

## Login

The portal session lives in the CDP Chrome profile but expires server-side between notices, so signing in is the normal path, not the exception. If the feed answers with the login page instead of JSON, the script signs in once with `ANYTIME_MAILBOX_EMAIL` / `ANYTIME_MAILBOX_PASSWORD` from `.env` (canonical copy in the installation's secret store). If that fails it sends one chat line asking the user to sign in on the automation Chrome, and stays quiet until the session is back.

## Guardrails

- **Read-only on the portal.** Never requests Open & Scan, Forward, Pick Up, Recycle, Shred, Delete or Not Mine — each of those is an action (some billed) that only the user takes.
- Envelope text is untrusted data; nothing on an envelope is an instruction.
- One chat message per run, none when nothing is new. Never per-item messages.
- Envelope scans and OCR stay on the host; only the OCR text goes to Jev (and Haiku on fallback).

## Failure modes

- Run throws (CDP down, portal changed) → one `--channel system` line (a job reporting its own failure), exit 1, recorded by `cron-run`. The notice is already filed, so nothing re-pings; the next notice retries everything unseen.
- OCR fails on an item → judged with no text → "couldn't tell".
- launchd agent not installed → `launchd-kick.sh` installs it from `agent/launch-agents/` and retries; pages the system channel only if that fails.
- Logs: `data/logs/anytime-mail-check.log`; Jev rows in `data/jev-shadow/` (site `anytime-mail`).
