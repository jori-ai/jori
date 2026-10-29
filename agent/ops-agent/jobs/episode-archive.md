EPISODE ARCHIVE — Nightly commit of yesterday's `daily_summaries` row to the wiki as a `day_YYYY-MM-DD` page (and on Mondays / 1st-of-month, the matching weekly + monthly rollup pages). Runs daily at 7:25 AM home time, after `daily-summary`.

**Pure cron script since 2026-10-04 — no agent turn.** Everything below runs in `agent/scripts/trigger-episode-archive.sh`; this file documents it. There is no language judgment anywhere in this job (Rule #0b). If you are an agent reading this because someone dispatched "EPISODE ARCHIVE" by hand, don't redo the steps — check `wiki read day_<date>` and the `[episode-archive]` lines in `agent/logs/watchdog.log`.

History: on 2026-08-01 the dispatched agent turn ended with zero tool calls ("no user action needed, staying silent per playbook") and `day_2026-07-31` was never written. The day write moved into the trigger that day; the remaining steps followed on 2026-10-04.

## Purpose

Episodic memory ("what happened on April 17?") and permanent memory share one mechanism — the wiki `pages` table, keyed by `type`:

- `day_YYYY-MM-DD` (`type: day`) — one per `daily_summaries` row.
- `week_YYYY-MM-DD` (`type: week`) — one per `weekly_summaries` row, keyed by the Monday.
- `month_YYYY-MM` (`type: month`) — one per `monthly_summaries` row.

Every "what did I do on …?" lookup, `wiki_search`, and `wiki_backlinks <person page>` covers the episodic tier. `data/episodes/` is a render-on-demand backup target (`memory-snapshot` → `wiki render-all`), not the source.

## What the script does

"Yesterday" and "today" are the user's **local** calendar (`bin/local-day`), not the home zone's — the same fix daily-summary got on 2026-10-03, so the page looked for is the page daily-summary named.

1. **Day page.** If `wiki read day_<yesterday>` fails, run `wiki-day-write <yesterday>`, then re-check that the page exists. Verify the outcome, never the exit code: `wiki-day-write` prints `no daily_summaries row for <date>` and **exits 0** on a missing row. Still missing → system-channel alert. Read-then-write is deliberate: `wiki-day-write` is not a no-op on unchanged input — each run appends two identical `page_revisions` rows.
2. **Rollups.** Local Monday → `wiki-week-write <yesterday>`; local 1st → `wiki-month-write <yesterday's YYYY-MM>`. Non-fatal; logged.
3. **Embeddings.** `embed-daily-summaries` fills `daily_summaries.embedding` (local Ollama `nomic-embed-text`) for `episode_search(semantic=true)`. Non-fatal; next run retries.
4. **Verify.** If `episode <yesterday>` renders fewer than 8 lines, alert the system channel (narrative null or a stub) and leave it for manual inspection.

Success is silent: no email, no ping, no push. Failures go to the system channel (`jori-send-curl --channel system --skip-precheck`, class 5 — a job reporting its own failure).

`wiki-day-write` reads the row, converts the narrative HTML with `lib/episode-html-to-md.js`, saves via `wiki.savePage()`, and chains `wiki-linker.applySuggestions` to auto-link the people, pets, restaurants and trips in the concept map.

## Backfill & maintenance

- Re-ingest one day after `daily_summaries` is updated: `wiki-day-write YYYY-MM-DD` (appends revisions — re-run when the row genuinely changed).
- Catch up after an outage: `wiki-day-write --backfill`; force rewrite: `--backfill --refresh`.
- Same for rollups: `wiki-week-write --backfill[--refresh]`, `wiki-month-write --backfill[--refresh]`.
- `wiki history day_<date>` / `wiki show-rev day_<date> <rev>` for the audit log.

## Invariants

- **Read-only against `daily_summaries` / `weekly_summaries` / `monthly_summaries`.**
- **No external delivery** except failure alerts on the system channel.
- **Single mechanism.** Episodic and permanent memory share the `pages` table — never reintroduce a parallel file store.
