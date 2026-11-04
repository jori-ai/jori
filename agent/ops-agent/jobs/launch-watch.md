LAUNCH WATCH — every announced launch matching a configured search on the user's calendar as a **free** (transparent) hold, so they can tune in if they're around. **This is a script, not an agent job:** cron → `agent/scripts/trigger-launch-watch.sh` (sleep window + cadence gate) → `bin/launch-watch-run`. Logic: `lib/launch-watch.mjs`, pinned by `tests/launch-watch.test.mjs`. Log: `data/logs/<job>.log`. By hand: `launch-watch-run --dry-run`.

## Config — `agent/local/config/launch-watch.json`

`search` (Launch Library search term, e.g. a vehicle name; **without it the watch is off** and every run exits 0), `label` (vehicle label in titles and pings; default = search), `limit` (10), `horizon_days` (180), `calendar` (`primary`), `event_tag` (the `--jori-event` tag), `intent` (the `jori-send-curl --intent`), `state_file` (`data/launch-watch-state.json`). Holds render in the home zone (`instance().tz`). An installation that scheduled this under an older job name calls `trigger-launch-watch.sh <job-name>` so the log and pause file keep that name.

## Cadence (trigger gate)

Daily while any known launch has a NET within 7 days; otherwise only when `last_check_at` is ≥7 days old (a month-precision placeholder must not hide a firming date for weeks). Pause: `data/<job>-pause.json`. Sleep window 01:00–08:00 in the user's current zone (`data/user-timezone.json`, else the home zone).

## Source

Launch Library 2 — `https://ll.thespacedevs.com/2.3.0/launches/upcoming/?search=<search>&limit=<limit>` (structured JSON, NET in UTC with a precision field; anonymous limit ~15 req/h, one call per run). A failed fetch just sets `last_check_at` and retries next run — never invents launches, never pings.

Normalised per launch: `mission` (`" | "` → space), `net_iso` (verbatim UTC), `net_precision` (`minute|hour|day|month`; Month or coarser → `month`), `window_end_iso`, `site` (`pad.location.name`), `source_url`.

## Reconcile (matched by mission slug)

- not in state → **create**; NET moved >10 min, precision sharpened, or newly calendar-worthy → **update**; else **touch**
- in state but missing from the fetch: NET ≥24h past → **archive** (`launched`); otherwise one miss is tolerated, the second consecutive → **cancel** (calendar event deleted, `removed`)
- prune `launched`/`removed` entries and anything 14+ days past NET

## Calendar (via `jori-calendar`, the sanctioned write path)

Only for launches with day-or-finer precision **and** within `horizon_days` (the manifest carries speculative far-future slots). Title `🚀 <mission> (<label>)`, location = site, `--transparency transparent`, `--event-color 9`, no attendees. Window: minute → NET to `window_end` (else +90 min); hour → floored hour, +2 h unless a window is given; day → +3 h, "TBD time" in the description. Times are rendered in the home zone from the UTC instant (DST from the tz database, never a static offset). Creates pass `--overlap-ok` because a free hold may sit on busy time by design.

## State — `state_file`

`{last_check_at, source, launches:{"<slug>::<net_iso[0:13]>": {mission, vehicle, net_iso, net_precision, window_end_iso, site, source_url, api_status, calendar_event_id, first_seen_at, last_seen_at, status, missing_runs}}}`. Only this script writes it.

## Notify

One `jori-send-curl --no-push` message plus one `jori-notify` push, only when something material changed: a new launch, a NET move of more than 6 hours, or a launch pulled from the manifest. Silent otherwise. No email.

```
🚀 <label> calendar updated:
• ADDED <label> Flight 15 — 2026-10-20 19:30 <zone> (<site>)
• MOVED <label> Flight 14 — 2026-09-18 → 2026-09-25 (<site>)
• REMOVED <label> Flight 13 (off the manifest)
```
