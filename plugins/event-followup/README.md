# Did it happen? (`event-followup`)

When a personal event on the calendar ends (a movie night at home, a dinner,
a concert, an outing), Jori asks whether it happened and how it was. The
answer becomes part of the record and of the user's taste:

- **The day's record:** `bin/day-correction` stores the user's words against
  the event's day and window, so the daily summary, `live-day` and every reader
  of a past day see it.
- **Taste:** the answer is captured by `hum-answer` (→ `hum-responses.jsonl` →
  nightly `hum-consolidate` into the wiki). A film or show that happened is
  marked watched on the watchlist (added if it was not on it); the user's
  opinion becomes `watchlist rate`, or the watchlist lane asks "how was it?".

## How it works

`ai.claude.event-followup` (launchd, every 30 minutes) runs `event-followup check`:

1. **Code** reads the calendars in the settings through `gog` and keeps timed
   events that ended 30 min to 36 h ago, are at most 8 h long, are not
   cancelled or declined, are not a recurring series (setting) and were not
   judged before.
2. **A model** (Haiku → Sonnet → Opus, climbing only on an invalid answer;
   Rule #0b) reads them with the user's open project tasks and decides which are
   personal experiences worth asking about. Work calls, deliveries, flights,
   reminders, appointments and anything that is a step of a task are left
   alone (another flow follows those up). It names the kind, the screen title for
   a film or show, and writes the question in Jori's voice.
3. **Code** paces it (quiet hours 23:00–09:00, 3 a day, 90 min apart, never
   while another question waits) and sends one through `bin/hum-ask`
   (lane `event_followup`, id `evf-<ref>`, memory hook `event_followup:<ref>`)
   with two tappable answers and "Type something".

The chat agent files the reply (`agent/chat-agent/CLAUDE.md`, Hum Inbound
Handling): `hum-answer` first, then `event-followup record <ref> --happened yes|no
--text "<their words>"`, and asks one short follow-up for details when the user
only tapped yes.

## Commands

```
event-followup check [--dry-run] [--force]
event-followup check --adopt <calendar event id> --now <ISO>   backfill one past event, ask nothing
event-followup record <ref> --happened yes|no --text "<the user's words>" [--reading "…"] [--no-watchlist]
event-followup list [--json] | show <ref>
```

State: `data/event-followup.json`. Log: `agent/logs/event-followup.log`.
Settings: `agent/local/config/event-followup.json` (see `config.defaults.json`).
