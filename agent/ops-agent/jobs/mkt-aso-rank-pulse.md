MKT ASO RANK PULSE — Daily keyword-rank tracking for the installation's app across its target keywords × locales × both stores. Reads `data/mkt-aso-target-keywords.json`, queries the iTunes Search API + the Play Store, finds the app's position, diffs against the prior run, persists to `data/mkt-aso-ranks-state.json`. Silent collector; consumed by `mkt-aso-opportunity-scan`.

> **This instance's additions** to this playbook (its app, keyword rationale and decisions) are in `agent/local/jobs/mkt-aso-rank-pulse.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (a by-hand run), `Read` that file before you start.

## Purpose

Rank tracking closes the ASO feedback loop. The baseline (`mkt-aso-baseline`) tells us what we ship; rank-pulse tells us how visible we are. Without it, every ASO experiment is blind — a keyword string can change with no way to know whether it lifted the app from rank 42 to rank 18 (or dropped it off-list).

This is the **measurement layer** of the ASO jobs. It feeds the orchestrator's "which keywords moved, what changed in the listing around the same time, is this a win or noise?" logic.

The data source is **free public store search** (no auth, no Apple/Google API account needed). Apple Search Ads popularity scores are a separate job (`mkt-aso-search-terms`).

## Inputs

- **The app and its markets:** `agent/local/config/marketing.json` — `ios_app_id`, `ios_bundle_id`, `android_package`, and `locales` (locale → `[iTunes country, Play lang, Play country]`). With neither an iOS id nor an Android package the module is off and the helper exits 0 with `skipped`.
- **Target keywords:** `data/mkt-aso-target-keywords.json` — `{"keywords": {"<locale>": {"tier_1": [...], "tier_2": [...], "tier_3": [...]}}}`. A locale not in `locales` is skipped.
- **Python deps:** `google-play-scraper`, in the virtualenv named by marketing.json `venv` (the helper re-execs under it when the package is missing).

## Pipeline

This job is a thin playbook over a deterministic helper. The helper does all the API calls + state mutation; the playbook orchestrates pre-flight and reports outcome.

### Step 0 — Pre-flight

Both gates live inside the helper, but the playbook must respect them:

- If `data/mkt-aso-rank-pulse-pause.json` exists → exit silent (the helper does this and exits 0).
- If `data/mkt-aso-rank-pulse.lock` is held by a live PID → exit silent (helper exits 1 with `{"error": "locked"}`).

### Step 1 — Invoke the helper

```bash
~/Dev/jori/bin/aso-rank-pulse-collect
EXIT=$?
```

Exit codes:
- `0` — run succeeded (≥80% of probes returned a result), or the module is not configured / paused. Helper printed a summary JSON.
- `1` — soft failure: <80% probes succeeded (rate limit, transient block, locked, etc.). State may have partial data. Don't escalate; next tick will retry.
- `2` — hard failure (reserved for future auth-style guardrails).

The helper iterates every (locale, keyword) pair on each configured store, sequentially, 1.2s apart on iTunes and 1.5s on Play — tens of minutes of wall time for a few hundred pairs.

### Step 2 — Read the summary

The helper writes `data/mkt-aso-ranks-state.json` and prints a summary like:

```json
{
  "ok": true,
  "ios": {"total": 540, "found": 18, "errors": 0},
  "android": {"total": 540, "found": 12, "errors": 0},
  "changes_this_run": 30
}
```

- `found` = how many keyword positions returned the app in the top 50
- `changes_this_run` = how many (store, locale, keyword) positions changed since the prior run

For a brand-new listing or small app, `found` will be low. That's expected — it means lots of ASO opportunity, not a broken job.

### Step 3 — Exit silent

This job does not deliver. `mkt-aso-opportunity-scan` (the weekly orchestrator) turns rank changes into actionable proposals.

If the helper reported errors on ≥5% of probes → log it but still exit silent. Errors are appended to `state.errors` (last 200 kept). The orchestrator surfaces persistent failures.

## State file schema

`data/mkt-aso-ranks-state.json`:

```json
{
  "version": 1,
  "last_run": "2026-05-18T14:35:00Z",
  "last_run_ok": true,
  "ranks": {
    "ios": {
      "en-US": {
        "<keyword>": {
          "current_rank": 42,
          "first_seen_rank": 42,
          "first_seen_date": "2026-05-18",
          "history": [
            {"date": "2026-05-18", "rank": 42}
          ]
        }
      }
    },
    "android": { "...": "same shape" }
  },
  "rank_changes": [
    {"date": "2026-05-19", "store": "ios", "locale": "en-US", "keyword": "...", "old": 42, "new": 38}
  ],
  "errors": [
    {"date": "...", "store": "...", "locale": "...", "keyword": "...", "error": "..."}
  ]
}
```

- `history` is capped at 90 entries per keyword (~3 months of daily samples).
- `rank_changes` is capped at the last 500 entries.
- `errors` is capped at the last 200 entries.

`current_rank: null` means the app was not in the top 50 results for that keyword in that locale.

## Guardrails

- **Read-only on App Store / Play Store** — public search endpoints; no writes possible.
- **Polite scraping** — sequential, 1.2s spacing on iTunes, 1.5s on Play.
- **No outbound comms** — silent collector. The orchestrator reports; this does not.
- **Lock file** at `data/mkt-aso-rank-pulse.lock` prevents concurrent runs.
- **Atomic state writes** — `state.tmp` → rename. A crash mid-run leaves the previous state intact.
- **Helper is deterministic** — no LLM in the data path. Same input + same store state → same output.

## Failure modes

- **iTunes Search API 429/5xx:** the helper records a per-call error in `state.errors` and continues. If the success rate drops below 80%, the run is flagged `last_run_ok=false` but state is still saved with partial data.
- **Play Store scraping blocked:** same handling.
- **Locale missing from `locales`:** the helper skips that pair (no error, no data).
- **Network gone entirely:** the helper raises; the dispatch exits 1; next tick retries.

## Outputs

`data/mkt-aso-ranks-state.json` → read by `mkt-aso-opportunity-scan` and summarised by the marketing digest.

## Schedule

- **Cadence:** daily
- **Slot:** allocated via `jori-cron-slots request`. Do not pick a round-number minute.
- **Trigger:** `~/Dev/jori/agent/scripts/trigger-mkt-aso-rank-pulse.sh`
- **Dispatch task name:** `MKT ASO RANK PULSE`

## Future enhancements

- **Apple Search Ads popularity scores** — layer in a volume signal per keyword.
- **Competitor rank tracking** — track the top competitors per keyword (from `data/mkt-aso-competitors.json`) to feed "why are they pulling ahead" analysis.
- **Per-tier reporting** — surface Tier 1 drops more prominently than Tier 3.
- **Search-position aggregation** — for each keyword, note who ranks above the app; surfaces emerging competitors.
