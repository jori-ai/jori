MKT ASO OPPORTUNITY SCAN — Weekly ASO orchestrator for the installation's app (`agent/local/config/marketing.json`; off without it — the helper exits 0 with `skipped`, and you exit silent). Reads `mkt-aso-baseline-state.json` + `mkt-aso-ranks-state.json`, synthesizes scored opportunities, drafts the weekly ASO digest. Sends email + phone pointer + push.

> **This instance's additions** to this playbook (its product's copy rules and decisions) are in `agent/local/jobs/mkt-aso-opportunity-scan.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (a by-hand run), `Read` that file before you start.

## Purpose

This is the **brain** of the ASO jobs. Baseline tells us what we ship; rank-pulse tells us where we stand; this job turns those signals into ranked, actionable proposals.

Output: one weekly email to the user with the top 3-5 opportunities + the full ranked list as an appendix. Each opportunity has evidence and a proposed action.

## Pipeline

### Step 0 — Pre-flight

The helper handles its own state I/O. The playbook just orchestrates.

### Step 1 — Invoke the helper

```bash
SUMMARY=$(~/Dev/jori/bin/aso-opportunity-scan)
echo "$SUMMARY"
```

Exit codes: `0` ok (or `skipped`: not configured — exit silent), `1` no state to scan (baseline + ranks both missing) — exit silent.

The helper writes `data/mkt-aso-opportunities.json`. Output JSON includes `new_this_run`, `total_open`, and `top_5` summaries.

### Step 2 — Read the full opportunities list

```bash
OPPS=$(cat ~/Dev/jori/data/mkt-aso-opportunities.json)
```

Use `jq` / `python3` to extract the top 8-10 opportunities by score where `status == "open"`. Skip `won`, `lost`, `ignored`, `in_test`.

### Step 3 — Draft the weekly ASO digest

Compose an HTML email. Subject:

```
ASO weekly: <N_high> high-impact, <N_total> total open
```

Body structure:

1. **One-paragraph intro** — what changed this week vs last (rank changes count, new opportunities, anything the user closed since last digest).
2. **Top 3 opportunities** — for each, surface:
   - Title (`type`, `store`/`locale`, `keyword` if applicable)
   - Score (`confidence × impact`)
   - Evidence (the structured evidence dict, formatted as a short bullet list)
   - Proposed action (the helper's draft — refine if it reads stilted)
3. **Quick wins** — section listing all `empty_listing_field` opportunities (these are 30-second fixes the user can do now).
4. **Appendix** — table of all open opportunities sorted by score.

Do **NOT**:
- Invent rank numbers not present in the evidence
- Suggest changing fields when no problem signal exists
- Use em-dashes (enforced by `email-send`, but easier to read if you avoid them entirely)
- Break the product's own copy rules (in this instance's additions, when it has any)

### Step 4 — Deliver

Per the long-form delivery rule (ops-agent CLAUDE.md), with the one command that implements it:

```bash
~/Dev/jori/bin/digest-deliver \
  --subject "ASO weekly: $N_HIGH high-impact, $N_TOTAL total open" \
  --body-file "$TMPDIR/aso-digest.html" \
  --intent mkt-aso-weekly \
  --pointer "ASO weekly: $N_HIGH high-impact opps. Top: $TOP_TITLE. See email." \
  --push "ASO weekly: $N_HIGH high-impact, $N_TOTAL total"
```

It sends the HTML email to the user, labels it, and sends the phone pointer and the push. Do not hand-run `email-send`, `jori-send-curl` or `jori-notify`.

### Step 5 — Exit silent

The digest IS the comms. No additional pings.

## State file schema

`data/mkt-aso-opportunities.json`:

```json
{
  "version": 1,
  "updated_at": "2026-05-18T15:00:00Z",
  "opportunities": [
    {
      "id": "opp-2026-05-18-no-visibility-ios-en-US",
      "type": "market_no_visibility",
      "store": "ios",
      "locale": "en-US",
      "first_seen": "2026-05-18",
      "status": "open",
      "evidence": {...},
      "proposed_action": "...",
      "confidence": 1.0,
      "impact": 5,
      "score": 5.0
    }
  ],
  "runs": [
    {"date": "2026-05-18", "new_count": 55, "by_type": {...}}
  ]
}
```

Status lifecycle: `open` → `in_test` (the user started an experiment) → `won`/`lost` (experiment result) OR → `ignored` (manually dismissed). The helper preserves user-set statuses across runs.

## Opportunity types currently detected

| Type | Trigger | Confidence | Impact |
|---|---|---|---|
| `empty_listing_field` | Required listing field empty (iOS promo_text, Android summary) | 1.0 | 4 / 3 |
| `subtitle_not_localized` | iOS subtitle carries one of marketing.json `subtitle_english_markers` in a non-English locale (minus `localized_subtitle_ok`) | 0.9 | 4 |
| `listing_field_underused` | Android description ≤30% of max length | 0.7 | 2 |
| `market_no_visibility` | A (store, locale) ranks ZERO of its Tier 1 keywords | 1.0 | 5 |
| `rank_drop` | Keyword dropped ≥5 positions OR off top 50 in last 7 days | 1.0 | 2-4 |
| `rank_climb` | Keyword climbed ≥5 positions OR entered top 10 in last 7 days | 1.0 | 2 |
| `rank_dominance` | the app ranks 1-3 for ≥2 keywords in a (store, locale) | 0.7 | 3 |
| `competitor_change` | Competitor changed metadata in last 7 days (diff source: baseline) | 1.0 | 3 |

Extending: add a `detect_*` function to `bin/aso-opportunity-scan` and reference it in `main()`.

## Guardrails

- **Read-only on state files** — helper writes ONLY `mkt-aso-opportunities.json` (atomic). Baseline + ranks are inputs only.
- **No outbound comms from helper** — only the playbook sends. Helper is silent.
- **Preserves user statuses** — `won`/`lost`/`ignored`/`in_test` across runs. Helper updates evidence but leaves status alone.
- **Atomic state writes** — tmp + rename.
- **No invented data in digest** — only surface what's in the evidence dict. If unsure, omit.

## Failure modes

- **Both state files missing**: helper exits 1 with `{"error": "no state files"}`. Playbook exits silent.
- **One state file missing**: helper proceeds with what it has (e.g. baseline-only opportunities). Logs which is missing in helper output.
- **Email send fails**: log the run, do NOT retry from this playbook (cron will fire again next week). Surface as `auth_broken_email` style state if it becomes a pattern.

## Schedule

- **Cadence:** weekly. Wednesday gives 3 days of rank-pulse data after Sunday baseline.
- **Slot:** allocated via `jori-cron-slots request --duration 5 --cadence weekly --day wed`. Do not pick a round-number minute.
- **Trigger:** `~/Dev/jori/agent/scripts/trigger-mkt-aso-opportunity-scan.sh`
- **Dispatch task name:** `MKT ASO OPPORTUNITY SCAN`

## Future enhancements

- **Per-tier weighting** — Tier 1 keyword rank changes should score higher than Tier 3.
- **Trend analysis** — "keyword X has been climbing for 3 weeks" pattern detection vs single-week diff.
- **Cross-job evidence** — surface a `review_themes` opportunity alongside a `rank_drop` for the same keyword (the orchestrator's real superpower once `mkt-aso-review-themes` exists).
- **Search-term emergence** — pair `mkt-aso-search-terms` data with rank-pulse data to find "high-impression-low-rank" terms.
