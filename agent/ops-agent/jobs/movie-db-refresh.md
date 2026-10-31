# MOVIE DB REFRESH (daily 10:40 local, cron-run, no LLM)

Keeps the movie database fresh — the films relevant to the viewers and where they can see them.
Since 2026-10-11: a fresh database of relevant films and where to see them (theaters, streaming services), so every recommendation puts the best-predicted first.

`bin/movie-db-refresh` (no agent turn; cron-run calls it directly):
1. **In theaters:** TMDB `now_playing` (US) → `watch_catalog.in_theaters` (true/false), adding
   films not yet in the catalog.
2. **New on streaming/digital:** TMDB discover, US digital releases in the last 120 days → added.
3. **Features** for the new rows via `watch-catalog-enrich --omdb-max 0`.
4. **Where to watch (US):** `providers = {stream:[…], free:[…], rent:bool}` (TMDB/JustWatch,
   names normalised by `lib/tmdb-providers.mjs`), `theatrical_date`, `digital_date` —
   for every relevant film; weekly, daily while it's in theaters.
5. **`model_p`**: the taste model's p(like) (`lib/watch-recsys.mjs`), so every surface sorts
   best-first.

"Relevant" = from the past 10 years (anniversary re-releases in theaters don't count), not seen,
not "not our thing".

**Consumers:** the ratings site "Watch now" tab (best first, filter by theater/service), the weekly
movie email (`watchlist-movies-email.md`), the hum `watchlist` lane's in-theaters pick
(`hum-harvesters/watchlist.mjs` branch T), and the film harvesters' ordering.

Runs after `watch-catalog-enrich` (09:40), so `model_p` uses that morning's IMDb scores.
Log: `agent/logs/movie-db-refresh.log`. Failure = stale data, nothing user-visible breaks.
