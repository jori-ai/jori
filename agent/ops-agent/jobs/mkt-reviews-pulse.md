MKT REVIEWS PULSE — Daily silent collector for new App Store reviews of the installation's app (`agent/local/config/marketing.json` `ios_app_id`; with none set, exit silent — the module is off). Polls Apple's customer-reviews RSS feed in each configured storefront, dedups against the persistent seen-set, and records new reviews to a state file. The marketing digest surfaces new reviews — and flags ≤3⭐ as urgent. Play Store polling is deferred until Google Play Developer API credentials are available.

> **This instance's additions** to this playbook, if any, are in `agent/local/jobs/mkt-reviews-pulse.md`; the supervisor appends them to the dispatched playbook.

## Purpose

A new ≤3⭐ review on the app is among the most actionable signals Jori can deliver: it's usually a clear product complaint that, if addressed quickly, can be turned into an updated review (Apple allows users to edit reviews). A new ≥4⭐ review is repurposable content — social proof for the website, social posts, etc.

Apple's customer-reviews RSS is unauthenticated and rate-limit-friendly. No App Store Connect API key required for review polling (the deeper analytics need ASC API; reviews don't).

## Inputs

- **App ID:** marketing.json `ios_app_id`
- **Bundle ID:** marketing.json `ios_bundle_id` (informational)
- **RSS feed:** `https://itunes.apple.com/<cc>/rss/customerreviews/id=<ios_app_id>/sortBy=mostRecent/json`, for each storefront `cc` in marketing.json `review_countries` (default: the iTunes countries of `locales`).
- **State file:** `~/Dev/jori/data/mkt-reviews-state.json`

## State file schema

```json
{
  "version": 1,
  "last_run": "2026-05-13T09:00:00Z",
  "last_run_ok": true,
  "seen_review_ids": ["12345...", "67890..."],
  "new_today": [
    {
      "id": "12345...",
      "rating": 5,
      "title": "<review title>",
      "body": "<review body>",
      "author": "<reviewer handle>",
      "version": "1.1.45",
      "country": "us",
      "first_seen": "2026-05-13T09:00:00Z"
    }
  ],
  "history": [
    { "date": "2026-05-12", "new_count": 0, "avg_rating": null, "low_star_count": 0 }
  ],
  "rolling_stats": {
    "last_30d_count": 0,
    "last_30d_avg_rating": null,
    "last_30d_low_star_count": 0
  }
}
```

`low_star_count` = count of ≤3⭐ reviews.

## Pipeline

### Step 0 — Pre-flight
Standard. Init state file if missing.

### Step 1 — Roll yesterday's `new_today` into history
Snapshot prior `new_today` summary into `history` (date, count, avg rating, low-star count), reset `new_today` to `[]`. Trim history to 30 entries.

### Step 2 — Fetch RSS feeds (all locales in parallel)
For each storefront `cc` in `review_countries`:
```bash
curl -sf "https://itunes.apple.com/<cc>/rss/customerreviews/id=<ios_app_id>/sortBy=mostRecent/json" \
  -A "Mozilla/5.0 (compatible; reviews-pulse/1.0)"
```

Each JSON response has a `feed.entry` array. Each entry beyond the first (the first is feed metadata, not a review) has:
- `id.label` — unique review ID
- `im:rating.label` — "1" through "5"
- `title.label` — review title
- `content.label` — review body
- `author.name.label` — reviewer handle
- `im:version.label` — app version reviewed
- `updated.label` — ISO timestamp

If a locale returns no reviews yet (new market), the feed has only metadata or is empty — that's fine, skip.

If a locale returns 4xx/5xx, log it but continue with other locales. Don't fail the run for one locale.

### Step 3 — Dedup against seen-set
For each review across all locales:
- Skip if `id` is in `seen_review_ids`.
- Otherwise append normalized review to `new_today` (with `country` field) AND add `id` to `seen_review_ids`.

### Step 4 — Update rolling stats
Compute over all reviews seen in last 30 days (filter `history` and `new_today`):
- `last_30d_count`, `last_30d_avg_rating`, `last_30d_low_star_count`.

### Step 5 — Write state atomically
Set `last_run` + `last_run_ok`.

### Step 6 — Exit silent
Digest surfaces. **Note:** the digest is responsible for marking low-star alerts as urgent in the subject line. This job does not ping.

## Guardrails

- **Read-only on Apple.** RSS is unauthenticated GET.
- **No outbound comms.** Even ≤3⭐ reviews don't ping from this job; the digest handles all surfacing.
- **Polite polling.** Daily once. Don't re-fetch within the same run.
- **Stable IDs.** Apple's review IDs are stable, but a user CAN edit a review (Apple lets them update). For now, we only track first-seen — edits won't re-surface. Future enhancement: hash `(rating + body)` as a secondary fingerprint and surface "review edited" if content changes for a known ID.
- **Locale spam protection.** If a single locale returns >20 reviews in one poll, log a warning and only persist the most recent 20 — protects against a corrupted feed flooding state.

## Failure modes

- **All locales fail:** `last_run_ok=false`, state untouched.
- **RSS schema changes:** parse defensively. If a required field is missing, skip that review and log.

## Outputs

- `~/Dev/jori/data/mkt-reviews-state.json` → consumed by the marketing digest and `mkt-aso-review-themes`

## Schedule

Cron: daily (slot via `jori-cron-slots request --cadence daily`)
Trigger: `~/Dev/jori/agent/scripts/trigger-mkt-reviews-pulse.sh`
Dispatch task name: `MKT REVIEWS PULSE`

## Future: Play Store

Google Play Developer API is required for Android review polling. When the credentials exist, add Step 2b that pulls from `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/<android_package>/reviews` and merges into `new_today` with `platform: "android"`. State schema is already platform-agnostic — just add `"platform": "ios"|"android"` to each review record.
