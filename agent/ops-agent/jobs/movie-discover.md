# MOVIE DISCOVER (weekly)

Back-catalog film harvester: great films from any year that the viewers haven't seen. Dispatched
by `agent/scripts/trigger-movie-discover.sh` (cron, Saturdays 08:27 local) to ops-light
(job-routing.json: sonnet). New streaming releases stay with `watch-discover`; this covers everything
older.

Since 2026-10-10: a harvester for films; what the viewers have already watched (and how much each liked it) is marked on the ratings site, and fit is judged through Jev.

## Step 1 — launch it detached, then end your turn

**Run this Bash call with the sandbox disabled (`dangerouslyDisableSandbox: true`)** (DNS for
Supabase / TMDB / OMDb fails inside the sandbox).

```bash
bin/job-run --name movie-discover --tier ops -- \
  bash agent/scripts/movie-discover-run.sh
```

No waiting, no `--notify-task`, a one-line ack. The run is silent; anything it adds is introduced
by the next morning's `watchlist-intro-email`.

## What the run does — `bin/movie-discover`

1. **Candidates (code):** TMDB recommendations for every film either of them loved or liked
   (`watch_ratings` from the ratings site + older shared verdicts), plus well-known films they marked
   "haven't seen" on the ratings site (`watch_catalog.seen = false`, TMDB score ≥ 7.3). Ordered by how
   many loved films recommend it, then TMDB score.
2. **Code gates:** not on the list in any status and not marked seen; IMDb ≥ 6.8 (no Rotten
   Tomatoes/Metacritic floor — critics predict their film marks at chance; the scores still go to
   Jev and the intro email); from the past 10 years; released and available in the US (stream/rent/buy,
   TMDB/JustWatch); no kids/family animation, no romance-led films. Up to 15 survivors.
3. **Fit (Jev):** `judgeFit` in `lib/watch-fit.mjs` — Jev site `watchlist-fit`, one boolean
   per candidate for "the viewers together", with each person's ratings by name in the state;
   a batched tool-less Sonnet judgement is the shadow (site week until 2026-10-17) and the
   fallback below the 0.85 threshold. Fails closed.
4. **Add** up to 5 as `queued`, audience `together`, `source: movie-discover`, `source_reason` =
   which loved films recommended it, `platform` = first US streaming service.

Manual: `movie-discover --dry-run [--max N] [--judge N]` prints what it would add.

## Guardrails

- Adds `watch_titles` rows only; never edits, rejects or removes.
- No email, no ping — the intro email is the delivery.
- Runs on API data (TMDB, OMDb, Jev) plus at most one Sonnet call; no web search.
