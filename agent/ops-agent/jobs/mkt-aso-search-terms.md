MKT ASO SEARCH TERMS — Weekly Apple Search Ads "what users searched" report for the installation's app. Surfaces new query candidates we don't already target. Off without `agent/local/config/marketing.json` (the helper exits 0 with `skipped`); dormant (an `auth_broken` state, exit 0) until the ASA credentials exist.

> **This instance's additions** to this playbook (its activation history and known gaps) are in `agent/local/jobs/mkt-aso-search-terms.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (a by-hand run), `Read` that file before you start.

> **Known gaps:** the helper appends *raw* ASA report rows (`{_campaign_id, _campaign_name, metadata, total, other}`) to `search_terms[]`; the normalized `{term, impressions, taps, ttr, already_in_targets}` schema under "State file schema" is the *target* shape. Real term text is at `metadata.searchTermText`, impressions at `total.impressions`; `other:true` rows are aggregate buckets with no term text. `mkt-aso-opportunity-scan` does not parse this state yet.

## Purpose

Rank-pulse tells us where we stand for keywords we already chose. Search-terms tells us about queries users actually type that we **didn't** pick. Those are the highest-leverage keyword candidates: they have measured impressions on the app's own listing.

## ASA configuration (one-time)

The job is dormant until these two files exist under the installation's `secrets/` (names from marketing.json `asa_meta_file` / `asa_key_file`, default `asa-meta.json` / `asa-private.pem`):

- `secrets/<asa_meta_file>` — JSON with `client_id`, `team_id`, `key_id`, `org_id` and `campaigns` (`[{id, name}]`; the search-terms report is campaign-scoped)
- `secrets/<asa_key_file>` — the Apple Search Ads API private key (PEM)

Until then, every run writes `auth_broken: true` with a `auth_broken_reason` pointer to the setup doc.

To activate:

1. Go to `https://searchads.apple.com/`, sign in with the Apple ID that owns ASC.
2. Create an Apple Search Ads account (free, no campaign spend required).
3. In the ASA dashboard → API → generate a Search Ads API certificate. Save the public/private keypair.
4. Copy the PEM to `~/Dev/jori/secrets/<asa_key_file>` on the host (chmod 600).
5. Write `~/Dev/jori/secrets/<asa_meta_file>` with the IDs from the ASA dashboard.
6. Next cron tick will start collecting.

## Pipeline

### Step 0 — Pre-flight

Helper checks for both ASA cred files. If missing → writes `auth_broken: true` state and exits 0 silently (this is an expected pre-setup state, not a failure).

### Step 1 — Invoke the helper

```bash
~/Dev/jori/bin/aso-search-terms-collect
```

Exit codes: `0` always (helper distinguishes the cred-missing case via state `auth_broken` flag, not exit code).

### Step 2 — Exit silent

Helper writes `data/mkt-aso-search-terms-state.json`. Consumed by `mkt-aso-opportunity-scan` (high-impression untargeted terms become high-score keyword_gap opportunities).

## State file schema

`data/mkt-aso-search-terms-state.json`:

```json
{
  "version": 1,
  "last_run": "2026-06-01T15:00:00Z",
  "last_run_ok": false,
  "auth_broken": true,
  "auth_broken_reason": "ASA account not configured. See ...",
  "search_terms": []
}
```

When activated, `search_terms` will contain:

```json
[
  {
    "term": "<search term>",
    "locale": "en-US",
    "impressions": 1240,
    "taps": 18,
    "ttr": 0.0145,
    "already_in_targets": false,
    "first_seen": "2026-06-01"
  }
]
```

## Guardrails

- **Read-only on ASA API** — never writes campaign settings.
- **Soft auth-broken** — missing creds do NOT trigger an alert; the state file's `auth_broken: true` is enough signal for the orchestrator to mention "setup ASA to unlock search-terms" in the weekly digest.
- **No outbound comms** — silent collector.

## Schedule

- **Cadence:** weekly. Tuesday gives a fresh week of data before the Wednesday opportunity-scan.
- **Slot:** allocated via `jori-cron-slots request --duration 3 --cadence weekly --day tue`.
- **Trigger:** `~/Dev/jori/agent/scripts/trigger-mkt-aso-search-terms.sh`
- **Dispatch task name:** `MKT ASO SEARCH TERMS`

## Future enhancements (post-activation)

- **Play Console export pipeline** — Google doesn't expose search terms via API. Build a manual-export-aware flow: when the user drops a CSV in `data/inbox/play-search-terms-*.csv`, parse and merge.
- **Click-through rate signal** — TTR (taps-to-impression ratio) per term identifies high-intent terms we should win.
- **Locale-spread analysis** — same term high-impression in 3 locales = strong signal vs spike in 1.
- **Auto-feed to creative-draft** — when a high-impression term is missing from our keyword string, auto-enqueue a creative-draft request.
