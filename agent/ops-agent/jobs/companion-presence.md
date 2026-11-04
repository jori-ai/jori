companion-presence: every 10 minutes, read the Find My position of each person who shares their location with the user, compare it with the user's own GPS trail, and add whoever was with the user to the user's visit rows, so the daily summary knows a companion was there without asking.

**A direct script: no webhook, no agent turn, nothing to dispatch.** This file is the reference for what it does. Cron `8-59/10 * * * *` → `agent/scripts/trigger-companion-presence.sh` → `bin/companion-presence tick`. Crontab line (slot registered in `jori-cron-slots`, low criticality; the :08 offset collides least, and a 1-minute direct script never touches the supervisor queue):

```
# jori: companion-presence — Find My readings every 10 min vs the user's trail → companions on the user's visit rows (jobs/companion-presence.md)
8-59/10 * * * * <install>/bin/cron-run --label trigger-companion-presence -- <install>/agent/scripts/trigger-companion-presence.sh
```
macOS can hold `crontab` on a permission prompt with no one at the screen, so the line may have to be added once from an interactive session (`crontab -e`). Until then nothing samples, and `jori doctor` reports `missing cron: companion-presence`.

**Off by default.** With no one on Find My for `findme presence-sample` to read, a tick records nothing and tags nothing. Who is read is the stop finder's configuration; who may be tagged is `data/known-companions.json` (names canonicalised through `agent/local/config/companion-names.json`, `lib/companions.py`).

## Purpose

When a day's summary had to ask whether a companion was with the user (first thing before coffee, on an evening walk), the answer was usually "together all day". So presence is checked periodically instead of asked.

Before this, the only Find My check was `findme enrich`'s companion detection. It looked once, when a visit row happened to be enriched (often hours later), skipped home stays, never saw a walk, and missed anyone who had already left. Most stops had no companion source, and the reviewer, told that a companion is usually there, kept flagging the companion's absence until the fixer asked. Photos (`findme backfill-companions`) only help when the person is in a picture.

## Pipeline

1. **Sample** (`companion-presence sample`, which runs `findme presence-sample`). One reading per person on Find My (never the user): their freshest device's position, accuracy and the time Find My took the fix. A reading already recorded (same person, same fix time) is skipped. Raw readings go to `samples-<UTC date>.jsonl`, kept 3 days.
2. **Reconcile** (`companion-presence reconcile`, last 72 h). Each reading is compared with where the *user's* trail puts the user **at the reading's own timestamp** (`lib/companion_presence.py` `user_at`): the user's transit fixes within 5 minutes on both sides (interpolated), one fix within 3 minutes (widened by walking pace), a closed visit row covering the moment, or two fixes up to 8 hours apart within 100 m of each other (silence is stillness). A reading the trail cannot place yet stays undecided and is judged again on later runs, because the user's fixes can upload 3+ hours late. A placed reading is **together** within max(100 m, combined uncertainty), capped at 200 m and only when the combined uncertainty is under 300 m. It is **apart** beyond max(400 m, 2× combined uncertainty). Anything in between is undecided.
3. **Tag the user's visit rows.** A person is added to a visit row's `location_history.companions` when the together readings cover at least half the row (each reading stands for ±8 min), a row longer than 30 minutes has at least two of them, and **no apart reading falls inside the row** (5 minutes from either edge excepted, for arrival skew). Only people in `data/known-companions.json`, and only rows that began after the first reading in hand (a row whose start was never observed, at install or once it ages past 72 h, is not judged). Half cover still tolerates a gap of a few hours with no readings (the person's phone off, a Find My outage) inside a long row, as long as nothing inside it says apart. Twin rows are each tagged. The writer re-reads the row's companions just before it adds, so a name another writer put there a moment ago is kept. resolve-day's existing `mergeCompanionsFromVisits` / `rehomeVisitCompanions` carry the names onto the day's stops.
4. **Open rows are provisional.** A row with no departure yet (tonight's stay at home, when the early-morning daily summary builds) is tagged after 30 observed minutes at 80% cover, and listed in `provisional.json`. Every run re-reads it: an apart reading inside the row (the person went out, the user stayed) takes the name back off. It settles once the row has closed and every reading inside it is placed, or 6 hours after it closed.

A visit row places the user only when none of the user's own fixes within 10 minutes is more than 200 m from it, so a solo walk inside a long row at home never reads as "at home" between sparse walk fixes.

## Commands

```bash
companion-presence show 2026-10-17            # who was with the user that day, in the user's timezone
companion-presence who 2026-10-17 19:56 20:35 # one window: "together" / "apart" / "mixed" / "not enough readings", plus the rows it tagged
companion-presence reconcile --dry-run --json # what it would add (and withdraw) now
companion-presence untag <row id> <person> --reason "<the user's words>"  # take a wrong add off, and keep it off
```
`--tz <zone>` overrides `data/user-timezone.json` (the phone's last reported zone; else the home zone).

**Who reads it.** Tagged rows reach the daily summary through resolve-day, so the reviewer sees the companion on record and has nothing to flag. `who` / `show` exist so the Daily Summary Fix and the chat agent can check Find My before asking the user who they were with. Their playbooks (`jobs/daily-summary-fix.md`, `chat-agent/procedures/location-aware.md`) are human-edited only (the self-improvement recursion guard).

## State (`data/companion-presence/`, gitignored)

| File | Contents | Kept |
|---|---|---|
| `samples-<UTC date>.jsonl` | raw readings: person, fix time, lat/lon, accuracy, device | 3 days |
| `readings-<UTC date>.json` | each reading's verdict, distance from the user, basis. No coordinates | 60 days |
| `tagged.jsonl` | every name this added, withdrew, or was told to untag (row id, person, cover, reason) | append-only |
| `provisional.json` | names added to rows that were still open, re-read each run | rewritten each run |
| `blocked.json` | (row, person) pairs taken off with `untag`; never re-added | until removed by hand |
| `last-run.json` | last tick's counts, `find_my_failures`, `last_sample_ok` | rewritten each tick |

Other people's raw positions are kept only 3 days. After that, only how far each was from the user is kept.

## Guardrails

- **Geometry only (Rule #0b).** No words are read; this never decides what the user meant.
- **Never removes a name it did not add.** A name the user's words or photos put on a row stays. It takes back only its own provisional names (step 4) and, through `untag`, its own adds; `untag` refuses (exit 2) any other name.
- `findme enrich` merges its own Find My companions into the row instead of replacing the column, so it never erases these or the photo backfill's.
- **Any apart reading inside a row blocks that row.** A long row at home with a solo walk out of it stays untagged, because resolve-day can carve the walk out of that row and would carry the name onto it.
- **Writes only `location_history.companions` on the user's visit rows.** Never `place_name` / `place_type`, never transit rows, never anyone else's data.
- **Silent.** No chat, no email, no push. One summary line per run in `data/logs/companion-presence.log`.
- **Health/finance:** none involved.

## Failure modes

- **Find My read fails** (iCloud session expired, network): the tick logs it and still reconciles what it has. After 6 consecutive failures (an hour) it posts one silent `--channel system` row (`⚠️ companion-presence: …`, a job reporting its own failure), then nothing more until it recovers and fails again. Fix: the iCloud 2FA re-login `findme` already asks for.
- **Supabase down:** reconcile fails for that tick; the next tick redoes it. Writes are idempotent.
- **Overlapping runs:** a lock file (`.lock`) makes a second tick exit at once; a hand-run `reconcile` or `untag` waits for it.
- **Kill switch:** `touch data/.companion-presence-off`.

## Known gap

resolve-day reads visit rows by **arrival** inside the day's window (`mergeCompanionsFromVisits`), so an overnight row that arrived the evening before is tagged here but not yet carried onto that morning's stop. Widening that query to rows overlapping the day is the follow-up in `lib/resolve-day.js`.
