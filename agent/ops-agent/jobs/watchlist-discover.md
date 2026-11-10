# WATCHLIST DISCOVER (monthly)

Monthly wide pass of the shows & movies discovery pipeline (60-day window, up to 12 adds).
Dispatched by `agent/scripts/trigger-watchlist-discover.sh` (cron, 11th of the month 10:17 local)
to the ops-light tier (job-routing.json: sonnet).

## Step 1 — launch it detached, then end your turn

**Run this Bash call with the sandbox disabled (`dangerouslyDisableSandbox: true`).** The
detached job inherits your sandbox, and inside it DNS for Supabase / TMDB / OMDb fails
(`getaddrinfo ENOTFOUND <project>.supabase.co` — two of three runs on 2026-10-04).
**Always launch when dispatched, even if a run already happened today** — a dispatch means
someone wants a run; the pipeline dedups, so a second run cannot double-add.

```bash
bin/job-run --name watchlist-discover --tier ops -- \
  bash agent/scripts/watchlist-discover-run.sh
```

That is the whole job. Do not wait for it, do not add a `--notify-task`: the run script
handles its own outcome — it calls `bin/watch-discover` (a TMDB sweep of new series on the
configured services plus the model's web search propose; code enforces every add rule; a show
too new for a settled IMDb rating is judged on its other reviews by the review check,
`judgeQuality` in `lib/watch-fit.mjs`; see that file's header and `agent/watchlist-rules.md`)
and sends one phone pointer only if something was added. A one-line ack in your turn is enough.

The daily `screen` hum lane runs the same pipeline (21-day model window, max 4) every day,
TMDB sweep included, so this monthly pass is the wide model search (60 days, up to 12, medium
effort), not the only safety net.

## Why it goes through you

`watch-discover` forks `claude -p` for the web search. A fork only authenticates from inside an
already Max-authenticated session, so cron cannot run it directly (no GUI session → no
keychain → "Not logged in"). `job-run` launched from your turn carries that auth and survives
session rotation.

## Guardrails

- Adds rows to `watch_titles` only. Never removes, rejects or edits existing rows.
- Records every series the sweep lists (recommended or not) in the show database,
  `watch_catalog` rows of kind `show`: its facts, its current season (when the season's last
  episode drops: `season_finale_date`, `season_finale_known`), one rating with its source
  (`rating`, `rating_source`: IMDb once it has 1,000 votes, else the review check's reading,
  else an estimate) and where discovery left it (`discover_status`, `discover_reason`).
  It never touches a catalog row's `title_id`, `seen` or `not_for_us`.
- No email. At most one phone pointer, from the run script.
- Inspect a run with `job-list` / `job-status <id>`; the run log is
  `agent/logs/watchlist-discover.log`.
