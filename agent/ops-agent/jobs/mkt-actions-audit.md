MKT ACTIONS AUDIT — Weekly. Ledger-hygiene pass over `data/mkt-actions-state.json`: reconciles every OPEN action against reality, auto-resolves the clear-cut (already-done → completed, dead-premise/duplicate → retired), and flags the ambiguous for the user. Keeps the action queue honest so the executor + digest aren't working off stale or already-done rows. With no ledger (`bin/mkt-actions list` shows 0 actions) exit silent.

> **This instance's additions** to this playbook (its live site and history) are in `agent/local/jobs/mkt-actions-audit.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (a by-hand run), `Read` that file before you start.

## Purpose

The action ledger drifts: the ideation job appends `proposed` rows daily, the executor advances some, but rows silently rot — marked `proposed` when the deliverable already shipped (a page built, App Store copy pushed), premises go stale (a stale local-clone read once concluded live pages "don't exist"), and near-duplicate actions pile up. Before this job that reconciliation was manual eyeballing of JSON. This job automates it: it is the **hygiene half** of the harness, complementing ideation (the brain), the executor (the hands), and the digest (the report).

It uses the `bin/mkt-actions` CLI for all reads + mutations — never hand-edits the JSON.

## Pipeline

### Step 0 — Pre-flight
1. If `~/Dev/jori/data/mkt-actions-audit-pause.json` exists → exit silent.
2. The trigger script already gated the sleep window + dispatched. Begin.

### Step 1 — Pull the open queue
`bin/mkt-actions list --open --json` → the full set of `proposed`/`in_progress` actions (both scopes). Also run `bin/mkt-actions stale --days 14 --json` to get the aged-out subset.

### Step 2 — Reconcile each open action against reality (use judgment)
For each open action, determine its true state. Verification depends on the action:
- **`site_content_deploys` / content actions** with a target page → GET the live URL on the product's site (marketing.json `site_url`) and check whether the described change already exists (the FAQ is present, the title is already shortened, the page/section already shipped). Use the live site, NOT a local clone of the site's repo (a stale clone once produced a false "doesn't exist" verdict — always verify against production).
- **`seo_mechanics` / indexing / state-tuning** → check the relevant state file or re-confirm the mechanic already ran.
- **off-cycle dispatch / measurement** → check whether the dispatched job / scheduled check-in already exists.
- **duplicate check** → does this action overlap a row already `completed`? If its deliverable is covered by a completed action, it's a duplicate.

### Step 3 — Classify + act
Sort each open action into exactly one bucket:

| Bucket | Criterion | Action |
|---|---|---|
| **Auto-complete** | Live-site / state verification proves the deliverable already exists | `mkt-actions complete <id> "<evidence: live URL + what was confirmed>"` |
| **Auto-retire** | Premise provably dead (target 404/gone, feature already shipped by other means making it moot, or it's a duplicate of a completed row) — OR aged-out **>21 days AND low-impact AND zero executor attempt** | `mkt-actions retire <id> "<reason + evidence>"` |
| **Flag (do NOT touch)** | Aged-out but still-valid (medium+ impact, just pending behind the executor's budget — that's a backlog, not staleness); anything ambiguous; anything needing the user's judgment | Leave as-is; list it in the report |
| **Parked (do NOT flag as stale)** | `manual_<owner_id>` rows (the user's own) that are intentionally gated/waiting (e.g. a hero rewrite gated on funnel data, a spend decision) | Note as "parked, intentional" — never auto-retire, never nag |

**Hard rule:** auto-action ONLY the clear-cut. Pure age is NOT sufficient to retire a still-valid medium/high-impact task — that's a backlog item, flag it. When uncertain, flag, don't touch. Never auto-retire a `manual_<owner_id>` row (those are the user's; only the user retires them — surface, don't act).

### Step 4 — Report (only if there's something to say)
Compile what changed + what needs review. **If zero auto-actions AND zero flags → exit silent** (no email, no ping — a clean ledger is not news). Otherwise deliver per the long-form rule in `ops-agent/CLAUDE.md`, with its one command (HTML email to the user, labeled `personal`, starred, marked read, NOT `p1`; then the phone pointer and the push):

```bash
~/Dev/jori/bin/digest-deliver --subject "<subject>" --body-file "$TMPDIR/mkt-actions-audit.html" \
  --intent mkt-actions-audit --pointer "<≤1 line>" --push "<subject>"
```

Report shape: **AUTO-RESOLVED** (completed / retired, with one-line evidence each) · **NEEDS YOUR CALL** (flagged ambiguous + parked manual items) · **HEALTHY BACKLOG** (count of still-valid open actions the executor will work). Keep it tight.

### Step 5 — Run log
Append one line to `~/Dev/jori/data/logs/mkt-actions-audit.log`: `{ts, open_in, auto_completed, auto_retired, flagged, parked}`.

## State

- Reads + mutates `~/Dev/jori/data/mkt-actions-state.json` **only via `bin/mkt-actions`** (atomic tmp+rename, audit-noted). Never hand-edits.
- Honors `~/Dev/jori/data/mkt-actions-audit-pause.json` (kill switch).
- Appends `~/Dev/jori/data/logs/mkt-actions-audit.log`.

## Guardrails

- **Read-only on the live site** (GET/HEAD to verify); verify against **production (`site_url`), never a local clone**.
- **No deploys, no commits, no outbound third-party comms, no money.** The only mutations are action-status changes via the CLI; the only outbound is the hygiene report to the user.
- **Auto-action only the clear-cut.** Already-done → complete; dead-premise/duplicate → retire; everything else → flag. When uncertain, flag.
- **Never auto-touch `manual_<owner_id>` rows** — surface them; the user decides.
- **Age alone ≠ stale.** A valid medium/high-impact action pending behind the executor's budget is a backlog item, not stale.
- **Silent on a clean run** — no report when nothing was resolved and nothing needs review.
- **Idempotent** — re-running finds nothing new to do once the ledger is reconciled.

## Failure modes
- CLI/ledger unreadable → log `ok:false`, exit, no ping (the daily digest will show staleness).
- A single live-URL check errors (network/timeout) → skip that action (leave open), continue with the rest; never retire on an inconclusive check.
- All checks error → log `ok:false`, one system-channel ping, exit.

## Schedule
Cron: weekly (Sunday, before that morning's collectors).
Trigger: `~/Dev/jori/agent/scripts/trigger-mkt-actions-audit.sh`
Dispatch task name: `MKT ACTIONS AUDIT`
