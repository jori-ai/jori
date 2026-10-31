Deterministic TMDB enrichment for the watch-list recommendation model. No LLM, no dispatch.

## Purpose

The recommendation model (`lib/watch-recsys.mjs` — used by the ratings site's batches of five,
`bin/movie-discover` and the Jev `watchlist-fit` gate) learns from each title's features:
genres, keywords, director (or show creator), cast, decade, language. It also learns from TMDB's
recommendation graph, stored as film-to-film edges. This job fills both.

Since 2026-10-10: a true recommendation system, trained on all the data already collected.

## Pipeline — `bin/watch-catalog-enrich`

1. **Sync the list:** every `watch_titles` row with a TMDB id (films AND shows, any status) gets a
   `watch_catalog` row (`kind` movie|show, `title_id` linked, `seen` = watched, `not_for_us` =
   rejected), so everything they've watched, rated or rejected teaches the model.
2. **Enrich** up to `--max` rows with no features (or features older than 120 days), list titles
   first: one TMDB call each — films `movie/{id}?append_to_response=keywords,credits,recommendations,external_ids`,
   shows `tv/{id}?append_to_response=keywords,aggregate_credits` (creators stand in for directors).
3. **Edges:** each film's TMDB recommendations → `watch_film_edges` (weight 1 − rank/20).
   Recommended films with ≥ 300 votes that aren't in the catalog are added (enriched next run),
   so the graph grows toward their taste. Shows get no edges.

## Schedule

Daily 09:40 local via `cron-run` (registered with `jori-cron-slots`, low criticality):

(the exact line lives in the installation's crontab; `jori-cron-slots` lists it)

## Inspecting the model

`bin/watch-model summary|batch|backtest|calibrate|tune|predict <title>` — what it has learned,
the batch it would show next, leave-one-out accuracy + AUC against the majority baseline, Platt
calibration (paste the result into `PARAMS.calib`), a hyperparameter grid. 2026-10-10 on 277
labels: AUC 0.840, accuracy 81.1% vs 75.1% baseline.

## Guardrails

- Writes `watch_catalog` facts/links and `watch_film_edges` only; never touches viewing state,
  ratings or the list.
- Silent. TMDB failures for one title are counted and stamped so it isn't retried in a loop.
