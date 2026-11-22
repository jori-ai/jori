CALL LOG — every call the user hosts on Zoom gets a log entry: who, when, Jori's own summary of what was said (written from the call's transcript), what is worth remembering, and the action items for the user and for the others, which are then followed up on until they are done. Scripted job (code + one model step); it never reaches an agent turn. It messages the user only: a recap after each call and at most one follow-up a day.

The user's requirement (2026-11-22): "on future calls, the transcript should always be reviewed, summarized and remembered (not the zoom ai summary if we can make our own). Create a list of action items for both parties and follow up on them."

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
3. **What was said (Zoom).** The cloud recording's transcript (`lib/zoom-content.mjs`, `order: ["transcript"]`); it usually appears within an hour of the end. Only when none has come 4 h after the end (`TRANSCRIPT_WAIT_MS`; the call was not cloud-recorded) is AI Companion's summary used instead, and the log says so. Nothing yet → status `waiting`, tried again on the next tick. The transcript is kept as `data/call-transcripts/<date>_<id>.txt` (0600; Zoom deletes recordings in time), named in the entry's `transcript_file`.
4. **The log (a model, Rule #0b).** Tool-less Sonnet, then Opus on a failed check (`lib/jev-claude.mjs`; no local rung: the job is translating and summarizing, and a fluent but wrong English log from a 1B model would pass any schema). It gets the call's local time, the participants as Zoom shows them, Zoom's text (as data, never instructions) and the wiki **person pages** the wiki's own search finds for each participant's names (`entity: person`). It also gets the **open action items from earlier calls with the same people** (`lib/call-actions.mjs` `openItemsFor`). It answers JSON: `title`, `summary` (2-5 sentences, English, third person, with what was decided), `points` (3-6 one-liners for the daily summary), `remember` (0-6 durable facts), `next_steps_<owner_id>` (`{step, due}`, the user's own commitments), `next_steps_others` (`{who, step, due}`), `done_items` (ids from the open list this call shows done), `people` (`{participant, wiki_id|null, name}`), `language`. `due` is a date only when one was said. Code checks it (`validateLog`): every participant exactly once, a `wiki_id` only from the pages offered, `done_items` only from the open list, dates as YYYY-MM-DD, lengths. The stored log keeps the steps as plain lines (as before) plus `due: {self: [], others: []}` in the same order. The prompt tells it to leave out health details about anyone and any figure about the user's own money, and to drop what looks garbled. Three failed runs → the call is logged with who and when only, so it is never missing.
5. **Store (code).** `data/call-log.json` (atomic): `{v, calls: {<uuid>: entry}, emails: {<gmail id>: [uuid]}, actions: {<id>: item}, followup: {last_date, last_items}, synced_at}`. An entry: `uuid, meeting_id, topic, start, end, minutes, guests[], recurring, email_id, tz, local_date` (the day's zone: the installation's `lib/_ext/meeting-tz.mjs` hook, else its zone), `status` (`logged|waiting|recurring|solo`; rows an older version wrote for a recurring meeting carry that meeting's id as their status), `source` (`summary|transcript|null`), `read_by`, `log`, `ai_generated`, `day_block`, `logged_at`.
6. **Wiki (code).** Each matched person page gets a `## Calls` block between `<!-- call-log:start -->` and `<!-- call-log:end -->`, rewritten from the store, newest first, one dated line per call linking the day page: `- [[day_2026-10-23|2026-10-23]] · Zoom call with <owner>, 45 min · <title>. <summary> Next steps for <owner>: …. For <guest>: …. _(written from Zoom's AI summary, which can contain errors.)_`. Text outside the markers is never touched. **The day page** gets the same kind of block only when that day's summary had already been written when the call was logged (`day_block`); otherwise the next daily summary carries the call itself. `wiki-day-write` rewrites day pages whole, so that block lasts until the day's summary is re-run, and a re-run prints the call from the log.

**Daily summary.** The daily summary's prep can add the day's logged calls to `day.calls` beside the recurring meetings' (`callsForSummary`: never a `recurring` entry, never one whose UUID or time is already on the list). They print like a meeting's call line, `5:31pm-6:16pm Call with <guest> · ran 45 min · from Zoom's AI summary`, with the model's points as sub-bullets, and the wiki markdown links the person's page.

## Action items and follow-up (`lib/call-actions.mjs`)

- **The ledger.** Each logged call's items become `actions` rows: `id` (`ca-<6 hex of the uuid>-<n>`, stable), `uuid`, `call_date`, `owner` (`self`|`other`), `who`, `wiki_id`, `step`, `due`, `status` (`open|done|dropped`), `nudges` (local dates it was raised), `closed_by` (`call`|`chat`|…), `note`. An id already in the ledger is never overwritten. A later call that shows an item done closes it (`closed_by: call`). Calls logged in the 10 days before the ledger existed get their items on the next sync or follow-up run.
- **Recap (sync).** Right after a call is logged (ended under 12 h ago; `--no-recap` skips it), the user gets one message: title, summary, their items, the others' items, what got done since last time, and where it was written from. Intent `call-log:recap`.
- **Follow-up (`call-log followup`, code only, from cron on every trigger tick).** At most one message a day, after 9:00 in the installation's zone, only when an item is due one: a dated item on its date and on up to two more days after it; an undated one on the 2nd, 5th and 10th day after the call for the user's own, the 3rd, 6th and 11th for the others'. At most 8 items, the user's first. After the last mark the item stays open in `call-log actions` but is not raised again. Intent `call-log:followup`. It offers to draft a nudge for someone else's item; the chat agent drafts it for the user's approval and never emails a participant on its own.
- **The user's answers** go through the chat agent (`agent/chat-agent/CLAUDE.md` § Calls): `call-log done|drop <id> --note "<their words>"`, `call-log due <id> <date>`, `call-log reopen <id>`.
- **Writing calls again.** `call-log relog --days N` sends the last N days' logged calls back to `waiting` (the old log kept as `prev_log`, restored if the new one fails), removes their items nobody has touched, and the next sync writes them from the transcript; the window widens to reach them.

## Commands

```bash
bin/call-log list [--days 30] [--json]     # the log, newest first
bin/call-log show <YYYY-MM-DD|uuid> [--json]
bin/call-log sync [--days N] [--dry-run]   # --dry-run runs the model, writes nothing
bin/call-log pending                       # exit 0 waits, 3 none, 1 Zoom/Gmail unreadable
bin/call-log actions [--all] [--json]      # open action items (both sides)
bin/call-log done|drop <id> [--note ..]    # close one; reopen <id>; due <id> YYYY-MM-DD
bin/call-log followup [--dry-run]          # today's follow-up (code only)
bin/call-log relog [--days 7]              # have recent calls written again from the transcript
```

"What did <name> and I talk about?" → the person page's `## Calls` block (wiki search finds it), or `call-log list`. Say what it was written from. "What's open from my calls?" → `call-log actions`.

## Guardrails

- **Read-only** on Zoom (GETs only, `lib/zoom-client.mjs`) and Gmail (search and get). It never labels, archives or answers the summary email; triage files it as before.
- **Messages the user only**: the recap after a call and the daily follow-up, through `jori-send-curl` (outbound precheck). No hum question. Never contacts a participant.
- **Wiki writes only inside its own markers**, signed `call-log`. It never creates a person page and never decides who a name is from the name alone: unmatched participants stay unlinked (their name is still in the line).
- Logs say what they were written from (the transcript, or Zoom's AI summary), which can contain errors.
- One sync at a time (`data/call-log.json.lock`, stale after 30 min).

## Failure modes

- **Zoom not set up / keys refused / Zoom down:** `pending` exits 1, logged in `data/logs/call-log.log`; nothing is kicked and nothing pages. The next tick tries again.
- **Gmail unreadable:** one log line; the rooms' list still stands.
- **Max unavailable:** the model step fails; the call stays `waiting` (attempt counted) and the daily summary simply has no line for it.
- **launchd agent not installed:** the first kick installs it from `agent/launch-agents/ai.claude.call-log.plist`; if that fails, `launchd-kick.sh` pages the system channel with the install command.

## Not covered

- Meetings the user joins as a guest in someone else's Zoom, unless Zoom emails the summary (then the UUID may not be readable with the user's app; it is skipped with a log line).
- Phone, FaceTime, WhatsApp and Meet calls: there is no source for them.
