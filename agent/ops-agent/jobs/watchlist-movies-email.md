# WATCHLIST MOVIES EMAIL (weekly, Sundays — only when there's something to say)

One email a week about movies: every film added to the list that week, **best predicted first**,
each with photos, cast, reviews, why the viewers will like it, IMDb/Rotten Tomatoes links, a
trailer and **where to watch** (in theaters / which service / free / rent) — plus a short "also new this week"
list of films that just arrived in theaters or on streaming, aren't on the list, and the taste
model rates ≥ 75%. Dispatched by `agent/scripts/trigger-watchlist-movies-email.sh` (cron,
Sundays 04:56 local) to ops-light — **only when the trigger's code gate finds something**.

Since 2026-10-11 films get one email a week, the ones the model rates highest first. Films therefore left the
daily `watchlist-intro-email` (which now covers shows and documentaries only).

## Step 1 — launch it detached, then end your turn

**Run this Bash call with the sandbox disabled (`dangerouslyDisableSandbox: true`)**.

```bash
bin/job-run --name watchlist-movies-email --tier ops -- \
  bash agent/scripts/watchlist-movies-email-run.sh
```

That is the whole job. No waiting, no `--notify-task`; a one-line ack is enough.

## What the run does — `bin/watchlist-intro-email --movies`

Same machinery as `watchlist-intro-email.md` (facts in code, one Sonnet call for the prose,
names never pronouns, digest-deliver: email + pointer + push, `intro_emailed_at` stamped), with:
1. **Select:** pending `watch_titles` rows of kind `movie` (same 30-day / not-introduced rules),
   ordered by the movie database's `model_p` (highest first), at most 12.
2. **Where to watch** on each card from `watch_catalog` (`movie-db-refresh`).
3. **Also new this week:** `watch_catalog` films with a US theatrical or digital release in the
   last 7 days, `title_id` null, not seen / not ours, `model_p ≥ 0.75`, top 6 — compact rows
   (`renderNewRows`): poster, name, % match, IMDb score, genres, where, the TMDB synopsis, and
   IMDb + "▶ Trailer" buttons. Poster, name and synopsis all open the film's IMDb page. One TMDB
   call per row (`videos,external_ids`) fills the trailer and a missing IMDb id or synopsis; OMDb
   fills an IMDb score the catalog doesn't have yet. No IMDb id anywhere → an IMDb search link.
   A failed lookup leaves that row as the catalog has it; it never stops the email.
   No model prose. (2026-10-11)
4. Silent when both are empty.

## Guardrails

- Read-only on the list except the `intro_emailed_at` stamp. Never adds titles.
- One email a week; the daily intro email never includes films.
