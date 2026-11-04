MKT ASO BASELINE — Weekly silent snapshot of the installation's app's App Store + Play Store metadata across its locales, plus its competitors' Play listings. Diffs against the prior week's snapshot and surfaces changes (anything the user OR competitors modified). The first job of the ASO set; runs Sundays.

> **This instance's additions** to this playbook (its app, competitors and history) are in `agent/local/jobs/mkt-aso-baseline.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (a by-hand run), `Read` that file before you start.

**Off without config.** Read `agent/local/config/marketing.json` first. With neither `ios_app_id` nor `android_package` set, exit silent — the module is not configured.

## Purpose

ASO begins with knowing where you stand and what changed. Without this snapshot, every other ASO job is blind — rank changes have no metadata context, competitor moves are invisible, and A/B tests can't be attributed to the right variant.

This job is the **observation layer** of the ASO jobs. It feeds `mkt-aso-opportunity-scan` (the weekly orchestrator that synthesizes proposals).

## Inputs (all from `agent/local/config/marketing.json`)

- **iOS app:** `ios_app_id` (and `ios_bundle_id`).
- **Android app:** `android_package`.
- **Locales:** the keys of `locales` are the iOS locales (Apple uses bare codes for some, e.g. `it`); each value is `[iTunes country, Play lang, Play country]` — the Play `(lang, country)` pairs come from it. A locale can target a market other than its language's home country (Spanish for Mexico, Portuguese for Brazil) — use the configured country, never a default.
- **ASC API auth:** through `~/Dev/jori/bin/asc-api-call` only (it reads the App Store Connect key from the installation's `secrets/`).
- **Play Store:** public scraping via the `google-play-scraper` Python package, in the virtualenv named by marketing.json `venv` (or the interpreter `python`). Install on first run if missing: `python3 -m venv <venv> && <venv>/bin/pip install google-play-scraper`.
- **User-Agent:** marketing.json `user_agent`.
- **Competitors:** `data/mkt-aso-competitors.json` (`{"<competitor_id>": {"name": ..., "android_package": ...}}`; expand as relevant).

## State file schema

`~/Dev/jori/data/mkt-aso-baseline-state.json`:

```json
{
  "version": 1,
  "last_run": "2026-05-18T13:00:00Z",
  "last_run_ok": true,
  "current_snapshot": {
    "ios": { "<locale>": { "name": "...", "subtitle": "...", "keywords": "...", "description": "...", "promotional_text": "...", "marketing_url": "...", "support_url": "..." } },
    "android": { "<locale>": { "title": "...", "summary": "...", "description": "...", "score": null, "installs": "...", "version": "..." } },
    "competitors": { "<competitor_id>": { "ios": {}, "android": {} } },
    "pulled_at": "2026-05-18T13:00:00Z"
  },
  "previous_snapshot": "<same shape as current, from prior week>",
  "weekly_diffs": [
    { "date": "2026-05-18", "changes": [
      { "store": "ios", "locale": "en-US", "field": "promotional_text",
        "old": "", "new": "<new text>", "owner": "<baseline_self_owner>" }
    ]}
  ],
  "history_snapshots": [],
  "auth_broken": false,
  "auth_broken_reason": null
}
```

`owner` is marketing.json `baseline_self_owner` (default: `product`) for the app's own listing, else the competitor id — `bin/aso-opportunity-scan` skips the app's own changes when it looks for competitor moves. Keep `history_snapshots` to the last 8 weeks; drop older entries.

## Pipeline

### Step 0 — Pre-flight

- Acquire lock at `data/mkt-aso-baseline.lock` (PID file). Skip if locked.
- If `data/mkt-aso-baseline-pause.json` exists, exit silent.
- If state file missing, initialize with empty `current_snapshot`, `previous_snapshot: null`.

### Step 1 — Use the deterministic ASC API helper

**Do NOT write JWT generation or retry logic inline.** Use the existing helper:

```bash
~/Dev/jori/bin/asc-api-call "<path>"
```

The helper handles JWT generation, 3-attempt retry with 10s/30s backoff on 401/403/5xx, and emits a JSON result.

```bash
# Quick auth probe (also fetches the appInfo id you need for Step 2):
RESULT=$(~/Dev/jori/bin/asc-api-call "/v1/apps/$IOS_APP_ID/appInfos")
EXIT=$?
# Exit codes:
#   0 = ok, parse $RESULT.body.data
#   1 = transient (network/5xx after retries) — exit silent, don't flip auth_broken
#   2 = auth_broken (3 consecutive 401/403) — set state.auth_broken=true, exit silent
#   3 = usage error (programmer mistake)
```

Why a helper script: an agent re-implementing JWT+retry inline once skipped the retry and flipped auth_broken=true on a single transient 401 while a manual retest returned HTTP 200. The helper makes the retry policy deterministic instead of LLM-generated each turn.

**Do not modify the helper to fit a specific call.** If a new endpoint shape is needed, extend the helper's args; do not bypass it with raw `curl`/`urllib` calls.

### Step 2 — Snapshot the app's iOS metadata

For each iOS locale, pull both appInfoLocalizations (cross-version: name, subtitle, privacyPolicyUrl) AND appStoreVersionLocalizations (per-version: description, keywords, promotionalText, marketingUrl, supportUrl, whatsNew) for the most recent appStoreVersion.

```bash
APP_INFO_ID=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['body']['data'][0]['id'])")
ASV_RESULT=$(~/Dev/jori/bin/asc-api-call "/v1/apps/$IOS_APP_ID/appStoreVersions?limit=1")
ASV_ID=$(echo "$ASV_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['body']['data'][0]['id'])")

for path in "/v1/appInfos/$APP_INFO_ID/appInfoLocalizations" \
            "/v1/appStoreVersions/$ASV_ID/appStoreVersionLocalizations"; do
  ~/Dev/jori/bin/asc-api-call "$path"  # exits 1/2 on failure; check $?
done
```

Persist into `current_snapshot.ios`. Per-locale failures (one locale 4xx but others ok) → log to a `run_errors` list, keep partial data, do NOT flip auth_broken (the helper already guards that). Skip this step when `ios_app_id` is empty.

### Step 3 — Snapshot the app's Android metadata

With the configured venv's `google-play-scraper`:

```python
from google_play_scraper import app
# (lang, country) for each configured locale, from marketing.json `locales`
for lang, country in LANG_COUNTRY:
    d = app(ANDROID_PACKAGE, lang=lang, country=country)
    # save: title, summary, description, score, ratings, installs, version, screenshots count
```

Persist into `current_snapshot.android`. Skip this step when `android_package` is empty.

### Step 4 — Snapshot competitor metadata (Android)

For each competitor in `data/mkt-aso-competitors.json`, pull Android metadata across the same locales. Skip the iOS competitor pull (it needs per-app ASC permissions we don't have for competitors; it would need the App Store search API or a scrape).

If a competitor's Play Store listing isn't found, log and skip — don't fail the run.

### Step 5 — Diff against previous_snapshot

If `previous_snapshot` exists, compute per-field diffs:

For each (store, locale, field):
- If `previous != current`, record a diff entry with old, new, store, locale, field, owner (the app's own owner tag or the competitor id).

Specifically watch for changes in:
- iOS: `name`, `subtitle`, `keywords`, `promotional_text`, `description` (first 100 chars only for description — full-diff noise too high)
- Android: `title`, `summary`, `description` (first 100 chars)

### Step 6 — Update state

- Roll `current_snapshot` → `previous_snapshot`
- Set new `current_snapshot` to the fresh pull
- Append today's diff entry to `weekly_diffs`, trim to last 8 weeks
- Set `last_run`, `last_run_ok=true`
- Release lock

Atomic write: `state.tmp` → fsync → rename.

### Step 7 — Exit silent

The marketing digest surfaces it. **This job does not ping.** `mkt-aso-opportunity-scan` turns diffs into opportunities.

On the first run (no `previous_snapshot`), the diff is empty — that's fine. The second run produces the first real diff.

## Guardrails

- **Read-only on Apple ASC** — never writes app metadata.
- **Polite Play scraping** — sequential locale fetch with 1.5s sleep between calls. Respect rate limits.
- **No outbound comms** — silent collector.
- **Lock file** to prevent concurrent dispatches.
- **Auth-broken signal** if the ASC token fetch repeatedly fails.
- **First-run safety** — when previous_snapshot is null, the diff step is a no-op (not an error).

## Failure modes

- **ASC token fetch fails:** auth_broken=true, exit silent.
- **Single locale fails:** record in run errors, keep other locales' data.
- **Competitor not found on Play:** log + skip, don't fail.
- **Disk write fails:** state.tmp left behind, real file untouched. Manual cleanup.

## Outputs

`data/mkt-aso-baseline-state.json` → consumed by `mkt-aso-opportunity-scan` (orchestrator) and surfaced summarily in the marketing digest.

## Schedule

- **Recurring:** every Sunday (slot via `jori-cron-slots request --cadence weekly --day sun`)
- **Trigger:** `~/Dev/jori/agent/scripts/trigger-mkt-aso-baseline.sh`
- **Dispatch task name:** `MKT ASO BASELINE`

## Future enhancements

- iOS competitor metadata via the App Store search API (free, no auth).
- Custom Product Pages snapshot (iOS) — once any CPPs exist.
- In-App Events monitoring (iOS) — for competitors that use them.
- Apple Search Ads popularity scores.
