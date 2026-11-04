EXERCISE SCHEDULE — place a 30-minute exercise block on the user's calendar for today, supporting a weekly exercise habit.

> **This instance's additions** to this playbook are in `agent/local/jobs/exercise-schedule.md` (absent = no additions). This job is never dispatched to an agent turn (see **How this job is invoked**), so this playbook is the job's reference, read by whoever changes it.

## Purpose

The user is building an exercise habit with a weekly target (`agent/local/config/exercise.json`: `target_per_week`, `rest_days`, `rest_day_on_track_min`). Each morning this job makes sure today's calendar holds the best available 30-minute slot for it. Rest days are skipped unless the user is behind on the week. **Off unless `exercise.json` sets `"enabled": true`**: the script exits 0 saying so, and a fresh install never places anything.

Wording (event title, notification tails, nudge copy, the place names that count as home) comes from the texts file named by `texts_file` (default `agent/local/exercise/texts.json`).

## Delivery

Short phone notification only (no email): "HH:MM–HH:MM blocked for exercise today." If skipped (rest day and on track), no message.

## How this job is invoked

`agent/scripts/trigger-exercise-schedule.sh` runs `bin/exercise-schedule` **directly** under `cron-run`. It does not POST to the supervisor, so there is no agent turn in this path and nothing here for an agent to execute by hand. Why: inside a **sandboxed** agent Bash child, two independent runtimes lose the network (the workout tracker's fetch fails in Node's resolver, and `gog` dies inside macOS trust evaluation with `x509 OSStatus -26276`, a Security-framework internal error, not a bad certificate), so no block was ever placed while the identical script outside a sandboxed turn succeeded. `cron-run` is not sandboxed. The trigger passes its arguments through, so `trigger-exercise-schedule.sh --dry-run` exercises the whole path without writing a calendar event.

The trigger also stops the job when the `exercise` hum lane is paused in `hum-interests.json` (one switch for the whole habit: a block with no nudges is noise).

**The log.** `data/logs/exercise-schedule.log`. On the scheduled path the trigger runs the script as `exercise-schedule "$@" >> "$LOGFILE" 2>&1`, so **the redirect is the writer**: it captures `log()`'s stderr and any uncaught-exception stack trace. The trigger exports `EXERCISE_SCHEDULE_STDERR_TO_LOG=1` and the script then **skips its own append** (otherwise every line lands twice). The self-append is the durable sink for the **agent-invoked** entry points (`--reschedule`, `--record-response`), which set no marker and do run inside a turn. **If you ever remove the trigger's redirect, remove the export in the same edit.** Guard: `tests/exercise-schedule-log-single-writer.test.mjs`. The append is best-effort inside a try/catch and skipped under `--dry-run`: a logging problem must never become a scheduling problem.

**Script outputs:**
- Creates a calendar event via `jori-calendar create --calendar primary` (the single sanctioned write path — see `agent/CLAUDE.md` § Calendar Invitations).
- Sends a phone notification via `jori-send-curl --suppress-hook "HH:MM–HH:MM blocked for exercise today."`.
- Exits silently (no notification) if today is a rest day and the week is on track.
- Exits silently if an exercise event already exists today (idempotent).

## Handling failures (by hand)

1. Check `data/logs/exercise-schedule.log` for the error.
2. Common failures:
   - `gog` auth expired → `gog auth refresh` and retry.
   - The workout tracker (`tracker_bin`) failed → the run proceeds without a session count (treated as a non-rest day).
   - No slot in the scan window → logged, silent exit (calendar too full; no event).
3. No failure notification unless the failure repeats for 3+ days (a broken auth state worth surfacing).

## Logic summary

| Condition | Action |
|---|---|
| **Away today (travel/flight/trip per `home-presence`)** | **Skip silently (no event) — only schedule when home** |
| Rest day AND sessions this week ≥ `rest_day_on_track_min` | Skip silently |
| Rest day AND behind | Place event (makeup day), note "(makeup day)" in the notification |
| Exercise event already exists today | Skip silently (idempotent) |
| No free slot in `scan_window` | Skip silently |
| Otherwise | Place event at the best slot, send the phone notification |

The away gate runs **first** (after the rest-day check, before the calendar fetch), so a travel day never reaches slot-finding or the calendar-fail fallback.

**Slot preference:** `preferred_slots` in order, then the first free 30-minute window inside `scan_window`. Opaque (busy) events block slots. Transparent/free events are ignored — **except travel/transit markers** (flight, "Stay at", car pickup/return, drive, in-transit), which block even when transparent (`flights-scan` marks accommodation transparent all day). A transparent all-day travel marker blocks the whole day.

## Home / travel gate (only schedule when home)

`bin/home-presence [YYYY-MM-DD] [--json]` answers "is the user at one of their home bases with no travel disruption on this date?" — derived from `data/flights.json`, so it works even when calendar auth is down (exactly when the calendar-fail fallback needs the answer). It returns AWAY when a flight departs or arrives that day, away-lodging covers it, or the most recent prior flight landed outside the home metros. Fail-open: missing/unreadable flights data → assume home (don't silently drop the habit). Exit 0 = home, 1 = away.

`exercise-schedule` calls it before placing; the `exercise` hum harvester calls it too (plus a fresh-GPS "far from any home" check, `far_km`) so travel days and out-of-town moments suppress every nudge — the post-session celebration is the only branch that still fires when away.

## State

`data/exercise-today.json` — written by the script after placing the event:

```json
{
  "date": "2026-05-11",
  "slot": {"start_hhmm": "11:00", "end_hhmm": "11:30", "start_min": 660, "end_min": 690},
  "event_id": "...",
  "is_makeup": false,
  "rescheduled_from": null,
  "calendar_fetch_failed": false,
  "created_at": "2026-05-11T07:30:01Z",
  "et_offset": "-04:00"
}
```

`calendar_fetch_failed` (optional, default `false`) is `true` only on the calendar-fail fallback row (see Failure modes): `event_id` is `null` on both the created path and the fallback, so without it the file cannot tell "this slot because we chose it" from "this slot because we could not read the calendar".

The `exercise` hum harvester reads this every tick to drive pre-slot, post-slot-miss and evening-recovery pings. No file = no slot today; the harvester falls back to morning/afternoon/evening backstops. Stale files from prior days are cleared automatically. **The harvester's own away gate suppresses every nudge branch — including the backstops — on a travel day**; only the post-session celebration still fires.

## Reschedule

`bin/exercise-schedule --reschedule HH:MM` moves today's exercise event **in place**: it patches the same event's start/end (install time zone) via `jori-calendar update` rather than deleting and recreating, so no duplicate is left behind (same `event_id`). Only when no exercise event exists yet does it create one. It updates the state file's `rescheduled_from` (preserving `event_id`) and sends one phone notification. The chat-agent invokes it for free-form reschedule replies (`"7pm"`, `"tonight 8pm"`, `"move to 14:30"`); see `agent/chat-agent/CLAUDE.md` § Exercise Replies — there the notification is the reply.

**`--no-notify`** does the move silently. The hum post-slot-miss branch is the only caller that passes it, because it then sends its own ping naming the missed slot, the new time and the week's count (otherwise the user gets two buzzes about one decision). Idempotent: the same HH:MM twice produces one event.

## Response recording

`bin/exercise-schedule --record-response <kind>` stamps the user's pre-slot reply into the state file so the harvester suppresses redundant pings. Kinds: `yes_will_go`, `going_now`, `on_my_way`, `going`, `skip`, `skip_today`, `cant_today`, `done_for_today`, `no`. The chat-agent calls this on an exercise-ping reply. The post-slot recommit still fires after a `yes_will_go` (the user may not have gone); only `skip` suppresses it.

## Behavioural-science design

The harvester is tuned against the habit-maintenance literature:
- **Cap ~3 touches a day per slot** (Kim & So 2018, message fatigue): pre-slot question, post-slot recommit question, evening recovery (`daily_ping_cap`). Intra-slot pings cross into nagging.
- **If-then framing in the pre-slot question** (Gollwitzer 1999, implementation intentions): "At HH:MM, leave the desk for the gym".
- **A yes/no question, not a statement** (question-behaviour effect, Wood et al. 2016).
- **The post-slot ask is "when instead?", never "why didn't you?"** — a forward-looking recommit with self-compassion language (Semenchuk 2018; Neff 2023).
- **Identity, gain and temptation-bundling encouragement lines** (Clear 2018; Rothman & Salovey 1997; Milkman 2014), rotated so copy doesn't habituate.
- **Weekly progress (N/target), no streak counter** in reminders — a broken streak cuts adherence (Silverman 2023). The streak appears only in the post-session celebration.
- **Honor an explicit "skip"** — suppress the pre-slot question, evening recovery and backstops once recorded. Bake in slack (one under target is still a win).
- **Any workout counts as "exercised today"** — miss-pings are gated on whether *any* session started or finished today, not whether the planned workout type was done.

## Guardrails

- Read-only calendar + `flights.json` check; creates at most one event per day.
- Only schedules when home (no travel/flight/trip that day).
- No email. The phone notification is the only outbound channel.
- Never runs on behalf of other people — the event is on the user's primary calendar only.
- Rest-day logic lives in `bin/exercise-schedule`; never reimplement it here.

## Failure modes

- **Script not found or not executable**: alert via `jori-send-curl` with the exact error; it indicates a deploy issue.
- **`gog` auth failure**: logged, skipped silently for the day; the morning-digest auth check surfaces gog auth failures separately.
- **Calendar read fails (`_fetchFailed`)**: `getTodayEvents()` retries the read **3 times** with a ~2s then ~5s backoff (each attempt tries the owner's account explicitly, then plain `primary`); each `gog` call is capped at 30s. Every attempt is logged. If all three fail, the script writes the defensive `fallback_slot` state row with `calendar_fetch_failed: true` and exits 0 **without creating a calendar event**.

  **Do not "fix" that skip by calling `createExerciseEvent()` on this branch.** An empty busy list from a *failed* read is not a free day; placing a block against it could double-book a real meeting. Lifting that is the user's decision, not a bug fix. The retry absorbs a transient failure, and a persistent one leaves a trace in the log and stamps the state row instead of looking like success. Regression guard: `tests/exercise-schedule-calendar-fallback.test.mjs` (it also asserts the skip is still there).
- **Workout tracker failure**: proceed as a non-rest day (conservative — don't skip by mistake).
- **Calendar full**: no event, no notification; the user self-manages.
