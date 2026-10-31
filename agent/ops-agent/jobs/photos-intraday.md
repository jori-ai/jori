PHOTOS INTRADAY — Index *today's* Apple Photos into Supabase throughout the day, so same-day stops/companions surface before the overnight full pass.

**No agent runs this job.** `trigger-photos-intraday.sh` runs from crontab at `:15`/`:45` and executes all three steps below itself — sync, backfill companions, synthesize stops — logging each to `watchdog.log` as `[photos-intraday] <step> ok|FAILED`. Every step is a fixed command, and a webhook dispatch would spend 48 ops turns a day typing them. If you are an agent reading this because someone asked about it: check `grep "\[photos-intraday\]" <install>/agent/logs/watchdog.log | tail`. The steps are kept below as the reference for what the script does.

It runs as photos come in, with no afternoon cutoff: a hard stop would leave evening activity (dinner, a show) invisible until the next morning.

## Purpose

Same three purposes as `photos-daily` (sync -> companions -> stop-synthesis), scoped to *today* and run frequently enough that a stop from an hour ago is already in the daily-summary machinery's confidence ladder if the user asks about it mid-day (e.g. via `location-day today` or a chat question), not just in the next morning's email.

## Step 1 -- Sync (run by the script)

`trigger-photos-intraday.sh` runs `photos sync --date today` itself, from cron, before dispatching you. **You cannot run it** -- `osxphotos` drives Photos.app over Apple events, which your Bash sandbox blocks, and it fails 100% of the time with `applescript.ScriptError: Expected "," but found class name. (-2741)`. See `photos-daily.md` Step 1 for the full story; it once cost five days of photos.

Read the outcome instead:

```
grep "\[photos-intraday\] sync" <install>/agent/logs/watchdog.log | tail -1
```

Same upsert behavior as the nightly job -- safe to re-run every 30 min; each pass only adds/updates rows for photos taken since the last sync. (`--date today` resolves against the home zone inside the CLI, same as the nightly job's default "yesterday": while the user is travelling far from home, "today" here can lag the user's actual local day by several hours.)

## Step 2 -- Backfill companions

`<install>/bin/findme backfill-companions --lookback 2 --json`

A 2h lookback (vs. the nightly job's 48h) -- this job runs every 30 min, so 2h comfortably covers a missed tick or two without re-scanning the whole day each time.

## Step 3 -- Synthesize stops for today

```
DATE=$(<install>/bin/local-day today)
DROP=1 <install>/bin/photos-synthesize-stops "$DATE"
```

Same clustering rule as the nightly job (<=60min gap / <=200m, >=2 photos with at least one GPS-tagged + face tags or a covering calendar event). **Known limitation carried over from the nightly job, not fixed here:** a cluster within 300m of an already-synthesized stop is skipped, so a stop built from the first 2 photos of a long visit won't automatically widen as more photos land later in the day.

## Guardrails

- Read-only on Apple Photos library (osxphotos query only, no edits) -- same as `photos-daily`.
- Write-only to the `photos` table and `location_history` (via `photos-synthesize-stops`).
- No Step 1b gap-catchup sweep here -- that belongs to the nightly job; this one only ever looks at today.
- Silent unless something errors -- no phone notification, this is cataloging infrastructure, not user-facing.
- Budget: max 2 minutes wall-clock, max 5 tool calls (same envelope as `photos-daily`'s per-run budget).
- Runs every 30 min via crontab (`15,45 * * * *`, offset from `photos-daily`'s `:00` slot so they never collide), no local-time-of-day window -- continues through evening/night. The nightly 03:00-local `photos-daily` pass is the natural handoff once the day is over and it re-processes the (by-then-complete) day as *yesterday*.
