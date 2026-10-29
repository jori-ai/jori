# WATCHLIST DISCOVER (monthly)

Monthly wide pass of the shows & movies discovery pipeline (60-day window, up to 12 adds).
Dispatched by `agent/scripts/trigger-watchlist-discover.sh` (cron, 1st of the month 10:17 local)
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
handles its own outcome — it calls `bin/watch-discover` (model proposes, code enforces
every add rule; see that file's header and `agent/watchlist-rules.md`) and sends one
phone pointer only if something was added. A one-line ack in your turn is enough.

## Why it goes through you

`watch-discover` forks `claude -p` for the web search. A fork only authenticates from inside an
already Max-authenticated session, so cron cannot run it directly (no GUI session → no
keychain → "Not logged in"). `job-run` launched from your turn carries that auth and survives
session rotation.

## Guardrails

- Adds rows to `watch_titles` only. Never removes, rejects or edits existing rows.
- No email. At most one phone pointer, from the run script.
- Inspect a run with `job-list` / `job-status <id>`; the run log is
  `agent/logs/watchlist-discover.log`.
