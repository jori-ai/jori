# Recurring meetings — calendar check, reminders, post-call notes, the daily summary's call line

A recurring meeting is a standing call with one counterpart (a cofounder, a coach, a manager) that sits on the calendar as a recurring series, usually runs in the user's own Zoom room, and keeps a running notes file with a "To Discuss" agenda. Every meeting is configuration (`agent/local/config/meetings.json`, read by `lib/meetings.mjs`); the code is the same for all of them. **No config, or an empty list: the module is off** — every entry point says so and exits 0.

## This job is scripts, not an agent turn

If a meeting job reaches you as an agent turn, run the script named below and end the turn.

| When | What runs | Does |
|---|---|---|
| Each morning (cron) | `agent/scripts/check-meetings.sh` → `bin/meeting-calendar-check` | Reads today's primary calendar through `gog` with the meeting's home-zone day bounds stated explicitly, finds the meeting (`lib/meeting-event.mjs`: the stored series id first, then a configured word — the counterpart's name by default — as a whole token of the title, an attendee's name or mailbox), then `bin/meeting-update set <date> <HH:MM> <tz> <event_id>` or `clear`. A calendar read failure exits 2 and leaves that meeting's state alone. Log: `data/logs/meeting-calendar.log`. |
| Email triage: an invite of the meeting is updated or cancelled | `bin/meeting-calendar-check --meeting <id>` | Re-reads the calendar instead of trusting a date read from the email. |
| T-40 | `meeting-remind prep` | Kicks the meeting's `topics_agent` (when it has one), which writes `topics_file` (`{call_epoch, topics: [{topic, from}]}`) for this call. |
| T-15 | `meeting-remind pre` | The agenda (`lib/meeting-reminder.mjs`): the call time in the user's current zone (via `local-day`) with the home zone in brackets; the open To Discuss items, ranked by the last call's model (`order` in `labels_file`) else the ones git blame dates to the last 30 days; at most 6, the rest behind a `<!-- more: +N more -->` fold; then the topics for this call. Sent with a tappable checklist (`metadata.checklist`, kind = the meeting's `checklist_kind`); a tick runs `bin/meeting-agenda-check --item "<line>" --done` (or `--open`), which flips the line in place after a backup. No model is called. |
| T+60, T+100, T+150, T+240 | `meeting-remind post` | With Zoom set up (`secrets/zoom-s2s.json`, or `ZOOM_*` in `.env`) it only kicks the meeting's `notes_agent` (default `ai.claude.meeting-notes-zoom` → `bin/meeting-notes-from-zoom`); cron cannot read the Max login that `claude -p` needs. Without Zoom, or if the kick fails, it sends the plain "Anything to remember from the call?" ask. |

`bin/meeting-update set` refuses (exit 3) to replace a call that is still ahead with one on a later day: an update for Friday's instance must not move Thursday's call (`MEETING_FORCE=1` overrides). Every crontab change goes through `bin/crontab-safe` (the whole crontab read under a timeout, only "read minus the meeting's `cron_tag` lines plus the new ones" installed; a failed read installs nothing and exits 4). The reminder lines run the meeting's `reminder_bin` (default `bin/meeting-remind … --meeting <id>`).

## After the call: `bin/meeting-notes-from-zoom`

The ended instance(s) of the meeting's room with the counterpart in them (90 min before the slot to 4 h after; the counterpart by `zoom.participant` email or display name, compared in code), Zoom's cloud transcript or AI Companion summary (`lib/zoom-content.mjs`), then a model's structured edit of the notes (`lib/meeting-notes-update.mjs`; tool-less Sonnet, then Opus). Code checks the edit (a closed item must be a To Discuss line copied exactly), backs the notes up to `backups_dir`, refuses if the file changed while the call was read, and applies it by heading: closed items move under `### <date>` as `- [x]`, follow-ups join To Discuss as `- [ ]`, Running Context facts are appended with an `[Mon D]` tag. The same answer carries short `labels` and a `priority` order, kept in `labels_file` for the next reminder. Then the post-call message: a short recap, "Next time", "Done", and "Anything to remember from the call?" (the chat procedure `chat-agent/procedures/meeting-notes.md` answers the reply). The run that sends marks `post_reminder_sent` and removes the remaining tagged lines; a run that finds nothing yet waits; the run at T+230 min or later sends the plain ask, saying why. Applied calls are recorded in `applied_file` by Zoom meeting UUID, so a call is never folded in twice. By hand: `meeting-notes-from-zoom --meeting <id> --dry-run --date YYYY-MM-DD --at <ISO start>`.

## The daily summary's call line

`lib/meeting-call.mjs` `callsForDay({m, date, tz})`: the day's instances on the calendar (only the series or an event with a video link — a dinner that names the counterpart is not a call), screened in code (cancelled, declined, inside a flight on the travel timeline), then Zoom for each slot that ended 2 h ago (the counterpart in the room → the call at their real time; only the user, or no meeting → left out; someone code cannot place → the calendar answers). For the rest, `bin/meeting-call-reading <date> --meeting <id>` has a model read the notes and the user's own words for whether it took place (Jev first when `data/jev-questions/<reading_site>.json` exists, then Sonnet, then Opus; a `held`/`not_held` answer must quote words it was shown), leaving `/tmp/<tmp_prefix>-calls-<date>.json`. With no reading the call ships worded as scheduled, never as a fact. `bin/meeting-call-talk` writes the points and paragraph on what was discussed (Zoom's text, else the notes' dated sections). The day's zone comes from the installation's `lib/_ext/meeting-tz.mjs` hook (`tzForDate`) when there is one, else the installation's zone.

## Configuration (`agent/local/config/meetings.json`)

```json
{"meetings": [{
  "id": "coach", "name": "Sam",
  "calendar_match": ["sam"],
  "zoom": {"room_id": "1234567890", "participant": {"emails": ["sam@example.com"], "names": ["sam lee", "sam"]}},
  "notes_file": "data/meetings/coach/notes.md"
}]}
```

Optional keys and their defaults (paths relative to the installation): `state_file` `data/meetings/<id>/state.json`, `labels_file` `…/agenda-labels.json`, `applied_file` `…/notes-zoom.json`, `topics_file` `…/message-topics.json`, `backups_dir` `data/backups`, `backup_prefix` `meeting-<id>-notes`, `log_name` `meeting-<id>`, `tmp_prefix` `meeting-<id>`, `cron_tag` `# MEETING_REMINDER_<ID>`, `reminder_bin` `bin/meeting-remind`, `reading_site` `meeting-call-held`, `checklist_kind` `meeting_agenda:<id>`, `notes_agent` `ai.claude.meeting-notes-zoom`, `topics_agent` none. The notes file needs the headings `## To Discuss (Upcoming)`, `## Discussed` and `## Running Context (Full History)`. The checklist kind needs a handler registered with `lib/choice-reply.mjs` (`registerChecklistHandler`, or `lib/_ext/choice-handlers.mjs`) that runs `bin/meeting-agenda-check --meeting <id>`.

## Guardrails

- Read-only on Zoom (GETs on past meetings only, `lib/zoom-client.mjs`) and the calendar. The only messages are the user's own reminders and post-call message.
- The model never rewrites the notes: it answers a checked edit, code applies it, and history only grows.
- Tests: `tests/meetings.test.mjs`, `tests/meeting-call-zoom.test.mjs`, `tests/meeting-notes-update.test.mjs`, `tests/meeting-reminder.test.mjs`, `tests/meeting-update.test.mjs`.
