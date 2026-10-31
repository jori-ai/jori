MKT ASO EXPERIMENTS — Daily check of active iOS Product Page Optimization (PPO) experiments via ASC API. Detects state changes, flags significance via `mkt-aso-opportunity-scan`. Skeleton handles "no active experiments" gracefully so it's safe to run before any experiment exists. The app is marketing.json `ios_app_id`; without it the helper exits 0 with `skipped`.

> **This instance's additions** to this playbook, if any, are in `agent/local/jobs/mkt-aso-experiments.md`; the supervisor appends them to the dispatched playbook.

## Purpose

When a PPO experiment is running, you need to know:
- When it reaches statistical significance (Apple decides; we just read the state)
- When the runtime crosses Apple's 90-day max (Apple auto-ends; we watch)
- Which variant is winning so opportunity-scan can surface "ship the winner"
- Which variants tripped a problem so creative-draft can iterate

Without this job, experiments run in a silo: you have to remember to check the ASC dashboard. With it, every state transition is recorded and the orchestrator surfaces actionable transitions.

## Pipeline

### Step 0 — Pre-flight

Helper handles its own gates (lock, pause file — currently not implemented since the operation is cheap).

### Step 1 — Invoke the helper

```bash
~/Dev/jori/bin/aso-experiments-check
```

Exit codes: `0` ok, `1` API failure (transient).

The helper uses `asc-api-call` for all ASC API access, so JWT generation + retry policy is deterministic.

### Step 2 — Exit silent

Helper writes `data/mkt-aso-experiments-state.json`. Consumed by `mkt-aso-opportunity-scan` (state changes surface as opportunities) and by any creative-drafting job (input when drafting the next variant).

## State file schema

`data/mkt-aso-experiments-state.json`:

```json
{
  "version": 1,
  "last_run": "2026-05-18T15:00:00Z",
  "last_run_ok": true,
  "experiments": [
    {
      "id": "abc-123",
      "name": "subtitle-test-3",
      "state": "PROCESSING",
      "started_at": "2026-05-10T00:00:00Z",
      "ended_at": null,
      "trafficProportion": 50
    }
  ],
  "state_changes_this_run": [
    {"id": "abc-123", "name": "subtitle-test-3", "kind": "state_change", "from": "READY_FOR_REVIEW", "to": "PROCESSING"}
  ],
  "history": [
    {"date": "2026-05-18", "active_count": 1, "total_count": 1}
  ]
}
```

PPO experiment states (per ASC API):
- `PREPARE_FOR_SUBMISSION` — being built
- `READY_FOR_REVIEW` — submitted, waiting Apple review
- `REJECTED_BY_REVIEW` — rejected
- `ACCEPTED` — approved, ready to start
- `PROCESSING` — running
- `STOPPED` — manually stopped
- `COMPLETED` — finished naturally
- `EXPIRED` — past 90-day max

## Guardrails

- **Read-only on ASC** — never writes experiment state.
- **No outbound comms** — silent collector.
- **Uses `asc-api-call`** — never re-implements JWT or retry logic.
- **No-op friendly** — empty `experiments` list is a valid state; the job runs harmlessly daily even when no experiments exist.

## Schedule

- **Cadence:** daily. Experiments can hit significance fast (especially on high-traffic listings) so daily checks are warranted.
- **Slot:** allocated via `jori-cron-slots request --duration 2 --cadence daily`. Pick a quiet morning slot.
- **Trigger:** `~/Dev/jori/agent/scripts/trigger-mkt-aso-experiments.sh`
- **Dispatch task name:** `MKT ASO EXPERIMENTS`

## Future enhancements

- **Play Store Listing Experiments** — Google doesn't expose these via API. Options: (a) selenium-against-console (fragile, requires auth session), (b) manual export → email parsing, (c) leave Android out of this job entirely. Defer until iOS PPO loop is proven.
- **Statistical significance threshold** — currently relies on Apple's "Conclusive" state. Could overlay our own Bayesian calc on conversion rate data once an experiment runs to completion.
- **Auto-promote winners** — when a variant wins, write a proposed-action opportunity into `pending-actions.jsonl` for the user's approval.
- **Pre-experiment health check** — verify listing has enough traffic for an experiment to reach significance within 90 days. Refuse to draft a new experiment if not.
