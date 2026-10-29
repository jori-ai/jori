Deterministic season sync for the shows & movies list (v2, 2026-10-04). No LLM.

## Purpose

Owns **airing truth** for every show on the list: which seasons exist, how many episodes,
premiere and finale dates, and `fully_dropped` (every episode aired). `next-show`, the hum
`watchlist` lane and the discovery pipeline all read `watch_seasons.fully_dropped` from here
instead of guessing — so a still-airing season is never offered as ready, and a season whose
finale has aired is never left stuck as "airing" (v1's House of the Dragon row stayed
`fully_dropped=false` for two months after its finale).

It is also how **new seasons** reach the list. When the next season of a show the user has
watched becomes fully dropped, that's the most valued recommendation (2026-09-02 rule: new
seasons that just finished dropping, of shows whose earlier seasons they watched), so the
job sends one phone pointer naming it.

v1 history: the job used OMDb `totalSeasons` plus title parsing of "<Show> Season N" rows, a
180-day recency gate, and inserted unfinished shows' seasons into the retired
`require_approval` queue. It never added a single row in its log history and its season data
was visibly wrong (Slow Horses S7/S8 "aired >180d ago"). Replaced wholesale.

## Pipeline — `bin/watchlist-season-check`

1. Load every `watch_titles` row with `kind=show`, a `tmdb_id`, and status not
   `rejected`/`dropped` (queued shows included — next-show needs S1's `fully_dropped`).
2. For each, `syncShowSeasons` (`lib/watch-db.mjs`): one TMDB `tv/{id}` call, plus one
   `tv/{id}/season/{n}` call for the latest season (the only one whose completeness is in
   doubt). Inserts missing seasons and updates air facts on existing ones. **Never touches
   viewing state** (watched / watching / episodes_watched).
3. A season counts as fully dropped when every episode has an air date on or before today (local)
   and TMDB lists no upcoming episode in it.
4. If a season `watchedThrough + 1` of a tracked show flipped to fully dropped this run →
   one pointer via `jori-send-curl --suppress-hook --intent watchlist-season` (goes through
   the outbound precheck).

## Usage

```
bin/watchlist-season-check          # dry run: reports how many shows it would refresh
DROP=1 bin/watchlist-season-check   # refresh + phone pointer when a season became ready
```

## Schedule

Daily 09:37 local via `cron-run` (registered with `jori-cron-slots`, low criticality):

(the exact line lives in the installation's crontab; `jori-cron-slots` lists it)

## State

Stateless — the DB is the state. Idempotent: a second run the same day changes nothing and
sends nothing.

## Guardrails

- Writes `watch_seasons` air facts and `watch_titles.year_end` only.
- Silent on empty (most days).
- Requires `TMDB_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`; exits 1 without TMDB.

## Failure modes

- TMDB error for one show — logged, counted in `errors=`, others continue.
- A show with no `tmdb_id` (2 titles at migration) is skipped; fix with `watchlist sync`
  after adding the id, or re-`add` it.
