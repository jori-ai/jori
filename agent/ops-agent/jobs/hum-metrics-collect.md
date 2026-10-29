HUM METRICS COLLECT — daily collector + decay detector for the hum improvement loop.

Runs at 06:30 (the install time zone, `instance().tz`) daily via cron. The job is a thin wrapper around `bin/hum-metrics-collect`, which does all the work. This playbook exists because Jori's webhook-task dispatch model requires every cron-triggered job to have a corresponding playbook even when the actual computation is a self-contained CLI.

Canonical design: `data/hum-improvement-loop.md`. Read that before any change to either this playbook or the script.

## What this job does (overview)

1. Reads `hum-runs.jsonl`, `suggestion-history.jsonl`, `hum-feedback.jsonl`, `hum-state.json`, `confirmed-stops.json` for yesterday's local day.
2. Computes daily metrics (signal_score_raw, signal_per_surfaced, surface_rate, silent_rate, per-lane yields, reactions histogram) and writes one row to `data/hum-metrics-state.json.daily[]`.
3. Runs the decay detector against the new row + prior history:
   - `lane_decay_silent`: 5+ days of zero reactions on a lane that has ≥3 surfacings in the window
   - `lane_decay_negative`: trailing 7d mean signal_per_surfaced ≤ -0.5 on a lane with ≥3 surfacings in the window (a lane that's reacted to every time, but always negatively — the silent walk above never sees this since it requires a zero-reaction day)
   - `lane_decay_dark`: trailing 7d average candidates/day ≥3.0 on a lane that surfaced NOTHING across that window — the two walks above both require something to have actually been surfaced; this one reads `candidates` so a lane that never clears the ranker at all still gets caught (hum-i-20260816-01)
   - `global_decay_drop`: rolling 3d signal_per_surfaced drops ≥25% vs prior 7d
   - `surface_rate_collapse` / `surface_rate_chatter`: rolling 3d surface_rate < 0.05 or > 0.55 (requires ≥30 ticks_3d to avoid empty-day false positives; `SURFACE_RATE_HIGH` re-baselined from 0.25 to 0.55 on 2026-09-11 — the old value was set for the retired ~72-tick/day cadence and fired on a majority of ordinary days after the 2026-08-02 event-driven redesign dropped ticks/day to ~15-22)
4. On any decay event: writes a `lane_diagnosis` question to `data/hum-pending-question.json` (honoring the 14-day per-lane cooldown). The chat-agent's existing pending-question handler routes the user's reply via `hum-answer`.
5. **Reconciles approval-gated interventions first** (`bin/hum-interventions-reconcile`, added for hum-i-20260823-04): backfills `commit` + `applied_at` + `measure_at` on any `hum-interventions.jsonl` row that hum-action-executor staged via a Face-ID card (`commit: null`, `approval_id: "<uuid>"`) and that card has since been applied. Without this, such a row never clears the next step's `commit in (None, "pending")` guard — the 7-day before/after measurement would never run for anything approved through that path. See § Attribution-reconciliation below.
6. Re-runs intervention attribution: for every open intervention whose `measure_at` has passed, compute the 7-day before/after deltas and write a `measurement` block to its row in `hum-interventions.jsonl`. A shipped row (real commit sha) with no `applied_at` is dated by its commit's committer time, and one with no `measure_at` is due at `applied_at` + 7 days; neither field is rewritten. A timestamp with no offset (including a bare date) is read in the local timezone.
7. Once a decay's qualitative question is answered, checks (`--dedup-check`) whether that exact answer already has an open fix idea sitting in `hum-improvement-ideas.jsonl` before dispatching another ideation turn — see Step 3.

## Step 1 — Run the script

```bash
~/Dev/jori/bin/hum-interventions-reconcile
~/Dev/jori/bin/hum-metrics-collect --measure
```

**Attribution-reconciliation (hum-i-20260823-04).** `hum-interventions-reconcile` runs first and is a separate, independent CLI (not part of the Python script) — it fetches each unresolved row's `self_improve_approvals` record, and if it's `status: "applied"`, recovers the commit sha by reconstructing `self-improve-approval-poll`'s own deterministic commit-message template (`self-improve: apply owner-approved fix (Face-ID) — <summary>`) and looking it up in `git log` — `self_improve_approvals` has no commit-sha column of its own to read. Rows it can't resolve yet (not applied, or the commit hasn't synced to this clone) are left untouched and retried on the next run. Pure merge logic + tests: `lib/hum-interventions-reconcile.mjs` / `tests/hum-interventions-reconcile.test.mjs`. Exits 0 whether or not anything was resolved — a lookup failure here must never block the metrics collection that follows it.

The script handles the install time zone, idempotency (re-running same date overwrites that row), state-file atomicity, and all data sources. Exit non-zero means the script itself broke — surface in `jori doctor` rather than this playbook trying to recover.

## Step 2 — Surface decay events (if any)

`hum-metrics-collect` already writes the qualitative-diagnosis question to `data/hum-pending-question.json`. The chat-agent picks it up automatically per `agent/chat-agent/CLAUDE.md § Hum Inbound Handling Step 1` — no action needed here.

## Step 3 — Trigger improvement-ideation on answered decay

If `hum-pending-question.json` was already answered today (i.e., a matching `hum-learnings.jsonl` row exists with `category: lane_diagnosis` and `answered_at` ≥ the decay event's ts), dispatch `HUM IMPROVEMENT IDEATION: decay <lane>` via the webhook — **unless the dedup check below says this would be redundant.**

**Dedup check (added, hum-i-20260711-02).** Before dispatching, run `~/Dev/jori/bin/hum-metrics-collect --dedup-check --lane <lane>`. It looks up the lane's most recently *answered* qualitative-diagnosis id (join key: `hum-learnings.jsonl` row `id` ↔ an idea's `evidence.qualitative_id`) and checks whether `hum-improvement-ideas.jsonl` already has an open (`status: proposed`) idea citing that exact `(lane, qualitative_id)` pair — i.e. a prior decay-triggered run already root-caused this same answer and the fix it proposed simply hasn't landed (or been declined) yet. If so, the check returns `{"blocked": true, "idea_id": ..., "recurrence_count": N}`, bumps `recurrence_count`/`recurrence_dispatches` on that idea row, and the trigger script skips the ops-agent dispatch entirely — no turn spent re-deriving a conclusion already on record. Once the blocking idea's status moves off `proposed` (applied / abandoned / retired / no_change_recommended), the check stops blocking and the next matching decay dispatches normally. The check **fails open** (`blocked: false`) on any internal error, so a bug in it can only cost an extra dispatch, never silently swallow a genuinely new decay signal. Before this fix, the `ideas` lane dispatched 4 byte-for-byte redundant ideation turns (7/7, 7/9, 7/10, 7/11) for the identical `qual-ideas-20260707` answer.

Pseudo-code (updated to include the dedup gate):

```bash
TODAY=$(TZ="$JORI_TZ" date +%Y-%m-%d)   # JORI_TZ from lib/instance.sh
LAST_DECAY=$(jq '[.decay_events[] | select(.ts | startswith("'$TODAY'"))] | last' \
  ~/Dev/jori/data/hum-metrics-state.json)
LANE=$(echo "$LAST_DECAY" | jq -r '.lane // "global"')
ANSWERED=$(jq -s --arg lane "$LANE" '[.[] | select(.subject == ("hum " + $lane + " decay"))] | last' \
  ~/Dev/jori/data/hum-learnings.jsonl)
if [ -n "$ANSWERED" ] && [ "$ANSWERED" != "null" ]; then
  DEDUP=$(~/Dev/jori/bin/hum-metrics-collect --dedup-check --lane "$LANE")
  BLOCKED=$(echo "$DEDUP" | jq -r '.blocked // false')
  if [ "$BLOCKED" != "true" ]; then
    TOKEN=$(cat ~/Dev/jori/secrets/webhook-token)
    curl -s -X POST http://localhost:9092 \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"task\":\"HUM IMPROVEMENT IDEATION: decay $LANE\",\"source\":\"cron-hum-metrics\"}"
  fi
fi
```

(The trigger script `agent/scripts/trigger-hum-metrics-collect.sh` will do this; this playbook documents the contract.)

## Step 4 — Silent unless decay

This is a silent job by default: no chat message, no email. Its output is state (`hum-metrics-state.json`), read by the rest of the hum improvement loop; the morning brief's HUM section that used to render it was removed on 2026-10-07.

The exception: if Step 1 errors (script exits nonzero), the trigger script posts one silent system-channel row, never a chat message: `jori-send-curl --intent hum-metrics-collect-error --agent infra --channel system --skip-precheck --no-push "hum-metrics-collect failed (exit <code>) — see data/logs/hum-metrics.log"`.

## Safety invariants

- **Read-only on hum runtime state.** The script never mutates `hum-state.json`, `hum-interests.json`, or any harvester input. It only writes to its own state files (`hum-metrics-state.json`, `hum-pending-question.json`, `hum-qual-cooldown.json`, `hum-interventions.jsonl`) plus, via `--dedup-check`, a `recurrence_count`/`recurrence_dispatches` bump on the one blocking row it identifies in `hum-improvement-ideas.jsonl` (never any other field on that ledger). `hum-interventions-reconcile` (Step 1, run just before the Python script) touches the same `hum-interventions.jsonl` file and nothing else — it never writes `hum-improvement-ideas.jsonl`, so the "awaiting_approval" status on the *idea* row is unaffected even after its intervention row is backfilled to `commit`/`status: "applied"`.
- **Idempotent.** Same date can be collected multiple times; the row gets replaced, not appended.
- **Cooldown honored.** Per-lane qualitative-question cooldown is 14 days; the script reads `hum-qual-cooldown.json` to decide whether to write a new pending question.
- **Time-bounded.** 180-day retention on `daily[]`, 200-row retention on `decay_events[]`. No unbounded growth.
- **Confounder-aware.** Each daily row carries `context_flags` (`traveling`, `hum_paused_hours`, `calendar_density`) so downstream ideation can distinguish "hum broke" from "context was unfavorable."
- **Dedup fails open.** `--dedup-check` never blocks a dispatch on its own error — any read/parse failure returns `blocked: false`, so a bug in the check can only cost an extra (wasteful, harmless) ideation dispatch, never silently suppress a genuinely new decay signal.
