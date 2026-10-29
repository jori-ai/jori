MKT CONVERSION COLLECT — Nightly paid-funnel conversion collector for the installation's app (paid Reddit ads → landing page → download). Silent collector; its output is consumed by the ideation job (proposals) and the marketing digest (surfacing). Off without `agent/local/config/marketing.json` (the collector exits 0 and writes nothing).

> **This instance's additions** to this playbook (its funnel's current state and blockers) are in `agent/local/jobs/mkt-conversion-collect.md`; the supervisor appends them to the dispatched playbook.

## Purpose

Turn ad spend into a measurable **download funnel**. Each day it assembles, per Reddit creative: impressions → clicks → (LP views → download-clicks) → installs, with CPC, LP CTR, and cost-per-install — so we can see which creative actually drives cheap installs, not just cheap clicks. This is the data layer for nightly conversion optimization.

## Pipeline

### Step 1 — Run the collector
```
node ~/Dev/jori/bin/mkt-conversion-collect
```
It is pure read+compute (no API auth needed for the working half — runs even when 1Password is locked):
- Reads `data/mkt-reddit-ads-state.json` (per-creative impressions/clicks/spend, written by the installation's Reddit-ads monitor, when it has one) and parses each ad's `af_ad` from its OneLink `click_url`.
- Reads `data/mkt-metrics-state.json` (ASC first-time installs, written by `mkt-metrics-collect`).
- GA4 (`secrets/ga4-config.json` = `{"property_id", "sa_key_path"}`, pulled by `bin/mkt-ga4-lp-pull.py` under marketing.json `venv`) fills LP views / download-clicks; AppsFlyer (`secrets/appsflyer-pull-token`) fills per-creative attributed installs / CPI, grouped by `af_ad`. Each is a no-op (`configured:false`) while its cred file is absent. Both read zero while the ads do not route clicks through the OneLink (`reddit.routes_to_onelink:false` → every creative parses `af_ad:null`).
- Writes `data/mkt-conversion-state.json`.

Schedule it after the two upstream collectors and before the ideation and digest jobs, so its data feeds the same-day pass.

### Step 2 — Deliver
None directly. This is a silent collector. The ideation job reads the state and proposes conversion actions; the digest surfaces the funnel. Per the long-form delivery rule, the collector itself never emails/pushes.

## State file

`data/mkt-conversion-state.json`:
- `window.date` — the activity date the funnel is built for.
- `sources.{reddit,asc,ga4,appsflyer}` — each with `configured` + notes; ga4/appsflyer report `configured:false` while their cred file is absent.
- `sources.ga4.lp_views_by_path` — per-`pagePath` map of `/lp/*` screen-page-views (the LP funnel top, by page).
- `sources.ga4.download_clicks_by_path` — per-`pagePath` map of the `app_download_click` event (store-CTA clicks broken out by the page they fired on, mirroring `lp_views_by_path`). Uses the built-in `pagePath` dimension at event time, so it works without a registered custom dimension. Empty `{}` until a store CTA is clicked.
- `funnel.by_creative[]` — `{ad_id, af_ad, name, impressions, clicks, spend, ctr_pct, cpc, lp_views, download_clicks, lp_ctr_pct, installs, cpi}`. LP/install fields are null until GA4/AppsFlyer are wired.
- `funnel.totals` — campaign rollup. `installs_source` = `appsflyer` (per-creative, attributed) or `asc_total_proxy` (campaign-level, not source-attributed).
- `notes[]` — gaps in the funnel (e.g. "Reddit ads not routing through OneLink — paid attribution blind until re-pointed").

## Guardrails
- **Read-only** on all inputs. Only writes its own state file (atomic temp+rename). Idempotent — re-running the same day overwrites with identical data.
- **No spend, no external mutation.** Optimization *proposals* are made by the ideation job in propose-mode; this job never touches ad campaigns.
- **Paid attribution needs OneLink routing.** Until the ad `click_url`s go through the AppsFlyer OneLink, each creative carries no `af_ad`, `reddit.routes_to_onelink:false`, and the LP/install columns read zero even with both sources live.

## Failure modes
- Missing/stale upstream state → the affected source reports `configured:false` / null with a note; the job still writes what it has and exits 0. Never pages.
- `last_run_ok:false` only on an unexpected exception. The daily digest treats >26h stale `last_run` as a stale-collector signal.
