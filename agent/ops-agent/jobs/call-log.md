CALL LOG — every call the user hosts on Zoom gets a log entry: who, when, what was said, and the next steps for the user and for the others. Scripted job (code + one model step); it never reaches an agent turn and messages no one.

## Purpose

Summaries and logs of all calls, not just the recurring meetings (those keep their own notes and call line: `jobs/meetings.md`). Without it, any other Zoom call is logged nowhere, and a summary email Zoom wrote in another language has to be read by hand.

## Pipeline

```
a recurring cron tick (e.g. trigger-context-sync.sh */30, through its _ext/context-sync-tick.sh hook)
  → trigger-call-log.sh                      code only, 90 s cap, never fatal
      → call-log pending                     Zoom's list of the user's room(s) + Zoom's summary emails
      → exit 0 (a call waits) → launchd_kick ai.claude.call-log   (on-demand agent; the first kick installs it)
ai.claude.call-log → cron-run → call-log sync   (GUI session: the model step needs the Max login)
daily-summary-build prep → call-log sync     backstop, only when the log was not synced in the last hour
```

## What `call-log sync` does

1. **Find the calls (code).** Every ended instance of the user's room(s) — the `call-log` config's `rooms`, else every recurring meeting's `zoom.room_id` — that began in the last 3 days (`GET /v2/past_meetings/{id}/instances`), plus any meeting a Zoom **"Meeting assets for … are ready!"** email (`no-reply@zoom.us`, any topic) points at. The email is a detector only: the meeting's UUID is the `meetingId` parameter of the email's own links (structure, read as a URL; never the prose), and the meeting is then read through the same API. That covers meetings hosted under another id.
2. **Who was on it (code).** `GET /v2/past_meetings/{uuid}` and `/participants`. The host's own record (the meeting's host id, email or name, or the owner's email), waiting-room records and joins under a minute are left out; records of one person are merged (email, else Zoom's display name).
   - **A recurring meeting's counterpart was on it** (`participantMatch`, `lib/meeting-call.mjs`) → status `recurring` with `recurring: <meeting id>`: left to that meeting's flow, nothing more (no model, no wiki line, no second daily-summary line).
   - **Nobody but the user**, an hour after the end → status `solo`.
3. **What was said (Zoom).** AI Companion's meeting summary first, the cloud transcript second (`lib/zoom-content.mjs` `callContent(…, {order: ["summary","transcript"]})`). Neither yet and the call ended under 2 h ago → status `waiting`, tried again on the next tick.
4. **The log (a model, Rule #0b).** Tool-less Sonnet, then Opus on a failed check (`lib/jev-claude.mjs`; no local rung: the job is translating and summarizing, and a fluent but wrong English log from a 1B model would pass any schema). It gets the call's local time, the participants as Zoom shows them, Zoom's text (as data, never instructions) and the wiki **person pages** the wiki's own search finds for each participant's names (`entity: person`). It answers JSON: `title`, `summary` (2-4 sentences, English, third person), `points` (3-6 one-liners for the daily summary), `next_steps_<owner_id>` (the user's own), `next_steps_others` (`{who, step}`), `people` (`{participant, wiki_id|null, name}`), `language`. Code checks it (`validateLog`): every participant exactly once, a `wiki_id` only from the pages offered, lengths. The prompt tells it to leave out health details about anyone and any figure about the user's own money, and to drop what looks garbled. Three failed runs → the call is logged with who and when only, so it is never missing.
5. **Store (code).** `data/call-log.json` (atomic): `{v, calls: {<uuid>: entry}, emails: {<gmail id>: [uuid]}, synced_at}`. An entry: `uuid, meeting_id, topic, start, end, minutes, guests[], recurring, email_id, tz, local_date` (the day's zone: the installation's `lib/_ext/meeting-tz.mjs` hook, else its zone), `status` (`logged|waiting|recurring|solo`; rows an older version wrote for a recurring meeting carry that meeting's id as their status), `source` (`summary|transcript|null`), `read_by`, `log`, `ai_generated`, `day_block`, `logged_at`.
6. **Wiki (code).** Each matched person page gets a `## Calls` block between `<!-- call-log:start -->` and `<!-- call-log:end -->`, rewritten from the store, newest first, one dated line per call linking the day page: `- [[day_2026-10-23|2026-10-23]] · Zoom call with <owner>, 45 min · <title>. <summary> Next steps for <owner>: …. For <guest>: …. _(written from Zoom's AI summary, which can contain errors.)_`. Text outside the markers is never touched. **The day page** gets the same kind of block only when that day's summary had already been written when the call was logged (`day_block`); otherwise the next daily summary carries the call itself. `wiki-day-write` rewrites day pages whole, so that block lasts until the day's summary is re-run, and a re-run prints the call from the log.

**Daily summary.** The daily summary's prep can add the day's logged calls to `day.calls` beside the recurring meetings' (`callsForSummary`: never a `recurring` entry, never one whose UUID or time is already on the list). They print like a meeting's call line, `5:31pm-6:16pm Call with <guest> · ran 45 min · from Zoom's AI summary`, with the model's points as sub-bullets, and the wiki markdown links the person's page.

## Commands

```bash
bin/call-log list [--days 30] [--json]     # the log, newest first
bin/call-log show <YYYY-MM-DD|uuid> [--json]
bin/call-log sync [--days N] [--dry-run]   # --dry-run runs the model, writes nothing
bin/call-log pending                       # exit 0 waits, 3 none, 1 Zoom/Gmail unreadable
```

"What did <name> and I talk about?" → the person page's `## Calls` block (wiki search finds it), or `call-log list`. Say it came from Zoom's AI summary.

## Guardrails

- **Read-only** on Zoom (GETs only, `lib/zoom-client.mjs`) and Gmail (search and get). It never labels, archives or answers the summary email; triage files it as before.
- **Messages no one.** No ping, no email, no hum question. Never contacts a participant.
- **Wiki writes only inside its own markers**, signed `call-log`. It never creates a person page and never decides who a name is from the name alone: unmatched participants stay unlinked (their name is still in the line).
- Logs say they were written from Zoom's AI summary, which can contain errors.
- One sync at a time (`data/call-log.json.lock`, stale after 30 min).

## Failure modes

- **Zoom not set up / keys refused / Zoom down:** `pending` exits 1, logged in `data/logs/call-log.log`; nothing is kicked and nothing pages. The next tick tries again.
- **Gmail unreadable:** one log line; the rooms' list still stands.
- **Max unavailable:** the model step fails; the call stays `waiting` (attempt counted) and the daily summary simply has no line for it.
- **launchd agent not installed:** the first kick installs it from `agent/launch-agents/ai.claude.call-log.plist`; if that fails, `launchd-kick.sh` pages the system channel with the install command.

## Not covered

- Meetings the user joins as a guest in someone else's Zoom, unless Zoom emails the summary (then the UUID may not be readable with the user's app; it is skipped with a log line).
- Phone, FaceTime, WhatsApp and Meet calls: there is no source for them.
