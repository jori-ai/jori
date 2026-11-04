MKT ASO REVIEW THEMES — Monthly clustering of review language into ASO keyword candidates + complaint patterns. Reads `mkt-reviews-state.json` (collected daily by `mkt-reviews-pulse`), extracts 2-3-gram phrases, surfaces ones mentioned ≥2 times that AREN'T already in target keywords. Output feeds the creative-drafting job (when the installation has one) + `mkt-aso-opportunity-scan`. Off without `agent/local/config/marketing.json` (the helper exits 0 with `skipped`).

> **This instance's additions** to this playbook, if any, are in `agent/local/jobs/mkt-aso-review-themes.md`; the supervisor appends them to the dispatched playbook.

## Purpose

Users describe the app in language that doesn't always match our keyword strings. When a 5-star review names the job the app does in the user's own words, that's a search query candidate worth testing. When a 1-star review complains a feature is buried, that's a complaint theme worth surfacing to the creative drafts.

This job converts qualitative review signal into structured candidates the orchestrator can act on.

## Pipeline

### Step 0 — Pre-flight

Helper handles its own gates.

### Step 1 — Invoke the helper

```bash
~/Dev/jori/bin/aso-review-themes
```

Exit codes: `0` ok (or no-op if no reviews, or not configured), `1` no reviews-state file found.

### Step 2 — Exit silent

The helper writes `data/mkt-aso-review-themes-state.json`. Consumed by `mkt-aso-opportunity-scan` (which surfaces high-impact themes in the weekly digest) and by any creative-drafting job (themes as input when drafting variants).

This job does **not** deliver. It's a silent collector.

## State file schema

`data/mkt-aso-review-themes-state.json`:

```json
{
  "version": 1,
  "updated_at": "2026-06-01T03:00:00Z",
  "reviews_analyzed": 47,
  "lookback_days": 90,
  "keyword_candidates": [
    {"phrase": "<two-word phrase>", "count": 12, "example_review_id": "..."},
    {"phrase": "<another phrase>", "count": 8, "example_review_id": "..."}
  ],
  "complaint_themes": [
    {"phrase": "<complaint phrase>", "count": 4, "example_review_id": "..."}
  ],
  "praise_themes": [
    {"phrase": "easy to use", "count": 9, "example_review_id": "..."}
  ]
}
```

## Algorithm notes

- 2-3-grams (matches ASO keyword phrase shape). Single tokens are too noisy; 4+ grams are too specific.
- Stop-word filter on start/end of n-gram (English; would benefit from per-locale extension once review volume justifies it).
- Each phrase counted at most once per review (so a single chatty review doesn't dominate).
- Phrases already in `mkt-aso-target-keywords.json` are filtered out (we're looking for NEW candidates).
- 90-day lookback window. Older reviews are presumed stale relative to current product state.

## Guardrails

- **Read-only on reviews state** — the reviews-pulse job is the canonical writer.
- **No outbound comms** — silent collector.
- **No-op on empty data** — when the app has zero reviews in the window, the helper writes an empty state file with a `note` and exits 0.

## Schedule

- **Cadence:** monthly. Review volume changes slowly; weekly would surface the same themes repeatedly.
- **Slot:** allocated via `jori-cron-slots request --duration 2 --cadence monthly`. Pick a date-of-month early in the month (e.g. 3rd) to feed that month's opportunity scans.
- **Trigger:** `~/Dev/jori/agent/scripts/trigger-mkt-aso-review-themes.sh`
- **Dispatch task name:** `MKT ASO REVIEW THEMES`

## Future enhancements

- **Per-locale clustering** — currently English-stop-word-aware only. Once reviews accumulate in es/fr/it/de/pt, run separate clusters per locale.
- **LLM thematic extraction** — beyond n-gram frequency, an LLM pass could group semantically related phrases ("easy to use" + "simple interface" + "intuitive"). Defer until n-gram results saturate.
- **Sentiment scoring per phrase** — combine review star rating with phrase appearance to detect mixed-signal terms.
- **Trend over time** — phrase X appeared in 12 reviews this month, 3 last month → emerging theme.
