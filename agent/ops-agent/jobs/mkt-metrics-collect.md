MKT METRICS COLLECT — Daily silent collector for the marketing module's improvement-traction harness. Pulls Search Console daily clicks/impressions for marketing.json `gsc_site` and App Store Connect daily downloads for `ios_app_id` (via the analytics report requests in `asc_report_requests`). Writes `data/mkt-metrics-state.json` (last 60 days raw, rolling 7d/30d windows, week-over-week deltas). Consumed by the ideation and digest jobs. With neither a site nor an app configured the collector exits 0 and writes nothing.

> **This instance's additions** to this playbook, if any, are in `agent/local/jobs/mkt-metrics-collect.md`.

This is the **measurement spine** of the continuous-improvement harness:
- Site visits → GSC clicks (D-3 lag — typical Google reporting cadence; the script pulls a full 45d window so the rolling 7d/30d figures stay populated)
- Downloads → ASC App Downloads Standard analytics report (D-1 lag; a ONE_TIME_SNAPSHOT request seeds 365d of history at creation; an ONGOING request keeps generating daily after that)

Without this state file, neither the ideation job nor the digest's METRICS section has anything to operate on. If this job dies silently, the rest of the harness goes blind.

## Pipeline

### Step 0 — Pre-flight
1. `~/Dev/jori/bin/doctor-preflight-check mkt-metrics-collect` — logs any failures to `data/logs/mkt-metrics-collect-doctor.log` and always continues. Never call `jori-send-curl` from this step (see `agent/CLAUDE.md` § System Channel — only `watchdog.sh` pages on infra health).
2. Verify `~/Dev/jori/secrets/<gsc_credentials_file>` exists (service-account key for GSC; default `gsc-credentials.json`).
3. Verify the ASC private key `asc-api` uses is in place.

### Step 1 — Run the collector
```bash
~/Dev/jori/bin/mkt-metrics-collect
```

The script does:
- GSC service-account JWT → access token (scope `webmasters.readonly`).
- `POST /webmasters/v3/sites/<gsc_site>/searchAnalytics/query` for the last 45 days, dimension `date`.
- For ASC: lists analytics-report instances on the ONGOING request (`asc_report_requests.ongoing`), falling back to the ONE_TIME_SNAPSHOT (`asc_report_requests.snapshot`) when ongoing data hasn't arrived yet. For each DAILY instance, fetches the segment URLs, gunzips the TSV, sums the `First-Time Downloads` (or `Total Downloads` if first-time column absent).
- Merges GSC + ASC into a single per-date series, trims to last 60 days, recomputes rolling 7d / 30d windows + week-over-week (uses D-3 to D-9 as "this week" vs D-10 to D-16 as "last week" to account for the GSC lag).
- Atomic write to `data/mkt-metrics-state.json`.

Exit code 0 = ok. Exit code 2 = ran with partial errors (one source failed; state still written with `last_run_ok: false` and `run_errors`). Exit code 1 = fatal (no state written).

### Step 2 — Exit silent
**No email. No phone ping. No APNs push.** This is a state-only producer. The digest reads the state file and surfaces the METRICS section; the ideation job reads it for context.

`jori doctor` failures from Step 0 are logged only, never pinged.

### Step 3 — If `last_run_ok` was false
Do NOT phone-ping. The digest section handles staleness/error surfacing. Logging to ops-agent stderr is enough — if a source has been broken for ≥48h, the digest will flag it and the user can ask.

## State file schema

```json
{
  "version": 1,
  "last_run": "2026-05-17T13:52:10.768Z",
  "last_run_ok": true,
  "asc": {
    "ongoing_report_request_id": "<asc_report_requests.ongoing>",
    "snapshot_report_request_id": "<asc_report_requests.snapshot>",
    "app_id": "<ios_app_id>",
    "app_name": "<asc_app_name>",
    "downloads_status": "ok | snapshot_pending | no_instances_yet | report_not_found | no_data_in_segments"
  },
  "gsc": { "site_url": "<gsc_site>" },
  "daily": [
    { "date": "2026-05-14", "gsc_clicks": 0, "gsc_impressions": 66, "gsc_ctr": 0, "gsc_position": 7.0, "asc_downloads": null }
  ],
  "rolling": {
    "7d": { "from": "...", "to": "...", "gsc_clicks": 1, "gsc_impressions": 255, "asc_downloads": 0 },
    "30d": { "from": "...", "to": "...", "gsc_clicks": 2, "gsc_impressions": 589, "asc_downloads": 0 }
  },
  "wow": {
    "this_week": { "from": "...", "to": "...", "gsc_clicks": 1, "gsc_impressions": 331, "asc_downloads": 0 },
    "last_week": { "from": "...", "to": "...", "gsc_clicks": 1, "gsc_impressions": 72, "asc_downloads": 0 },
    "delta_clicks_pct": 0,
    "delta_impressions_pct": 359.7,
    "delta_downloads_pct": 0
  },
  "run_errors": []
}
```

## Guardrails

- **Read-only.** Never POSTs to GSC or ASC except for OAuth token exchange (GSC) and segment-URL fetches (ASC). Never creates or deletes analytics report requests at run time — the two IDs come from marketing.json and are seeded into the state file on its first run.
- **No outbound comms.** Digest + ideation are the surfacing channels.
- **Polite API usage.** 1 GSC token exchange + 1 search-analytics call per run. ASC: ~10–30 ASC API calls per run depending on instance count (reports + instances + per-instance segments). All well under any quota.
- **`asc_downloads: null`** is the correct value for dates where data isn't available yet — distinguish from `0` (actual zero downloads).
- **`delta_*_pct: null`** is correct when the prior-period value was 0 — pct delta of "zero to anything" is undefined; downstream code should render it as `"new!"` not `"+∞%"`.
- **`asc.downloads_status: snapshot_pending`** persists until Apple finishes processing the ONE_TIME_SNAPSHOT (~24–48h after creation). After that, the ONGOING request takes over and `status` flips to `ok`. `not_configured` when no `ios_app_id` is set.

## Failure modes

- **GSC token exchange fails** (creds invalid, network): collector writes `last_run_ok: false` with `run_errors=[{source:"gsc",message:...}]`. ASC half still runs. Digest will show "GSC data unavailable".
- **ASC JWT fails** (key missing/expired): same, on the ASC side. GSC half still runs.
- **Both fail:** state file still written with no new daily entries; rolling/wow recomputed from prior data (gradually goes stale). After 48h of total failure, the digest will flag both as stale.

## Outputs read by other jobs

- `data/mkt-metrics-state.json` → consumed by the ideation and digest jobs

## Schedule

Cron: daily, before the ideation and digest jobs.
Trigger: `~/Dev/jori/agent/scripts/trigger-mkt-metrics-collect.sh`

**Execution: pure cron, NO agent dispatch.** This is a silent, deterministic, state-only producer with zero outbound comms — nothing for an LLM agent to decide — so the trigger `exec`s `bin/mkt-metrics-collect` directly instead of dispatching to the ops supervisor. The steps above describe what the collector binary does; there is no agent in the loop. This playbook is reference documentation for the script's behavior, not a dispatched task.
