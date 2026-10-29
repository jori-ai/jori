PHOTOS DAILY — Index yesterday's Apple Photos into Supabase and link to location segments. **Pure cron script — no agent turn.** Everything below runs in `agent/scripts/trigger-photos-daily.sh`; this file documents it. If you are an agent reading this because someone dispatched "PHOTOS DAILY" by hand, don't re-run the steps — read the `[photos-daily]` lines in `agent/logs/watchdog.log` and report what they say.

Clock-anchored at **03:00 in the user's local time**, wherever the user physically is (registered in `data/clock-jobs.json`; `cron-tz-sync` rewrites the crontab fields nightly). Runs before photos-backfill-thumbs (03:15 local) and daily-summary (04:00 local) so the `photos` table is populated before either reads it. A run just after midnight is too early: iCloud has not propagated the day's photos yet.

## Purpose

1. Keep the `photos` table in sync with the Apple Photos library one day at a time
2. Link each photo/video to the location segment where it was taken (time + GPS)
3. Enables queries like "photos from lunch on 5/2/25" or "where was I when I shot IMG_1234"

## What the script does

1. **Sync** — `photos sync --date $(local-day yesterday)`: the day daily-summary will compile, in the user's local tz. Queries osxphotos for that day, fetches location_history segments ± 6h, upserts each photo with `segment_id` / `place_name` / `match_confidence`, prints `{date, count, stats: {exact_time, time+gps, gps_only, unmatched}}`.
2. **Outcome check** (code, no model): sync failure → system-channel alert with the error verbatim. `unmatched > 25%` of a non-zero count → system-channel alert (photo GPS or location tracking drifted). Zero photos → silent.
3. **Gap sweep** — `photos-sync-gaps --days 8 --max 2 --json` re-syncs days in the window with no rows, oldest first, ledger in `data/photos-sync-gaps.json` (a cleanly empty day is retried twice then left alone; an erroring day stays a candidate).
4. **Companions** — `findme backfill-companions --lookback 48`: photo face tags (canonical names via `agent/local/config/companion-names.json`) → `location_history.companions[]`. Find My misses companions who walked off before enrich ran.
5. **Synthesize stops** — `DROP=1 photos-synthesize-stops <same local day>`: clusters photos (≤60 min gap, ≤200m) with face tags or a covering calendar event into `place_type=photo-synthesized` visit rows where iOS's visit detector dropped a real stop.
6. **Stale-render repair** — the gap sweep also reports `stale_render`: days whose photos landed *after* the day page rendered (`photos_count == 0` on a record with stops, newest `synced_at` later than the record's `updated_at`). `bin/photos-rerender-plan` decides per date from `data/photos-rerender-ledger.json` (7-day window, `lib/photos-rerender-ledger.mjs`):
   - no prior attempt → `job-run --name day-rerender -- daily-summary-run <date>`
   - one prior attempt → the same with `SILENT`, so a still-broken repair fixes data without re-sending the email
   - two prior attempts → stop and alert the system channel once: render/publish needs a code-level look for that date
   - already escalated → skip

   **The re-render is dispatched to the ops supervisor, not forked here.** It is the one part of photos-daily that cannot run in cron: `daily-summary-run` forks a `claude -p` session, and a fork launched straight from cron has no route to the Max credential in the login keychain (`agent/CLAUDE.md` § Long-Running Jobs — job-run "must be launched from an agent turn … not straight from cron"). Every cron-launched repair fork died inside 10s with "Failed to authenticate: OAuth session expired and could not be refreshed", while the 04:00-local daily-summary run an hour later succeeded every night; the failures paged the system channel as if the subscription were down. `dispatch_rerender()` now POSTs a one-command task (`dispatch_or_skip`, `daily-summary` tier → ops) and the receiving turn just runs `job-run` and ends. Guarded by `tests/photos-daily-rerender-dispatch.test.mjs`.

   This ledger replaced an agent `ls data/jobs | grep day-rerender-<date>` judgment, which re-sent one day's full summary three nights running.

Every step logs one line to `watchdog.log`; failures of any step go to the system channel (`jori-send-curl --channel system --skip-precheck`, class 5: a job reporting its own failure). Success is silent.

## Why it runs in cron, not an agent turn

**`osxphotos` cannot run from an agent's Bash tool.** It drives Photos.app over Apple events, which the Claude Code Bash sandbox blocks; it surfaces as `applescript.ScriptError: Expected "," but found class name. (-2741)` — a sandbox verdict, not a transient library problem (11/11 failures sandboxed, 0 unsandboxed). That misreading once cost five days of photos. The remaining steps moved into the script because none of them involves language judgment.

**If you ever need to sync a day by hand** (a one-off backfill, a date the user asks about), it MUST be `dangerouslyDisableSandbox: true`, and it takes minutes per day, so wrap it in `job-run`:

```
<install>/bin/job-run --name photos-backfill -- \
  <install>/bin/photos sync --date YYYY-MM-DD
```

## Guardrails

- Read-only on the Apple Photos library (osxphotos query only, no edits)
- Writes: `photos` table, `location_history` (companions, synthesized stops), `data/photos-sync-gaps.json`, `data/photos-rerender-ledger.json`
- **Never run `osxphotos`, `photos sync`, or `photos-sync-gaps` from a sandboxed Bash call.**
- No phone notification unless something is broken
