# Strict email triage

Per-message Gmail triage reads mail from anyone. Until 2026-11-16 every such email became a turn in the ops-light session: Sonnet with Bash, files, the web, 66 Jori tools and a long-running session that also runs Hum and other jobs. An email that talked the model into something had all of that to work with.

The strict path triages the same email, under the same Email Triage Rules, in a one-off `claude -p` that has no shell, no files, no web, no browser and no mailbox search. It is in the code and dark until `agents.json` → `ops.gmailTriageTarget` is `"strict"`.

## Pieces

| Piece | What it does |
|---|---|
| `agent/supervisor/triage-route.mjs` | With `"strict"`, runs the one-shot for each per-message item (at most `STRICT_MAX` = 3 at once). When it does not finish, the item goes to ops-light as before, with a note of what the one-shot already did. Each run leaves a marker in `data/triage-strict-pending/` until it ends; a marker older than 11 minutes (the supervisor restarted mid-run) is dispatched to ops-light once. With `"strict-shadow"`, triage stays on ops-light and a dry one-shot runs alongside each item. |
| `bin/email-triage-report` | Scores the shadow runs against the decision record (`triage_decisions`). |
| `bin/email-triage-run` | Starts the one-shot: built-in tools off (`--tools ""`), `--strict-mcp-config` to one server, Sonnet at medium effort, the locked-down agent environment (`lib/agent-env.cjs`, id `email-triage`). Exit 0 = triaged or escalated; exit 3 = fall back. Log `data/email-triage-oneshot-log.jsonl`; cost rows in `agent/logs/ephemeral-forks/job-costs.ndjson` under `gmail:<id>`. |
| `agent/tools-mcp/email-triage.mjs` + `lib/email-triage-tools.mjs` | The only tools. Each wraps the CLI the rules name, so the rules read the same. |
| `agent/ops-agent/jobs/email-triage-strict.md` | The one-shot's system prompt (the `oneshot` section): which tool stands for which command, and "no tool → escalate". |

## Bounds, enforced in code

- **The email is bound by the runner** (message id, sender, subject, Date). Gmail changes, the P1 task, the P1 downgrade and the spam block act on that email or sender only; no tool takes a message id or an address.
- **Labels** come from the triage label set plus `p1`/`p3` (and an installation's `email-triage.json` `extra_labels`).
- **`notify_owner`** reaches the owner only, with an intent from a fixed list; `--evidence-as-of` is the email's own Date and a P1 pointer carries `--p1-message`. The send still passes the precheck and the speak gate.
- **Calendar writes** take no attendees.
- **`escalate_to_ops`** sends ops-light (never the ops tier, which carries Chrome) the message id, a reason from a fixed list, a validated rule slug and, in code's own words, what the run already changed; never model-written text. Ops-light re-reads the email itself, so an escalated email is still read by a Bash-capable agent: this narrows the exposure, it does not remove it.
- **A change counts only once it succeeded.** Each changing tool runs, then records its outcome; a failed call is recorded as failed. The runner falls back (exit 3) when nothing succeeded or the escalation failed.
- **No tool** for following links, the browser, the Gmail connector, a reply or forward, a dispatch, or an installation's own commands: each is an escalation.

## What escalates

Measured over 933 ops-light triage turns (2026-10-18 to 11-16), 87.5% used only commands this toolbox covers. The rest are mostly Amazon delivery tracking (following the tracking link, four times opening an Amazon order page in the signed-in browser), the Gmail connector for the thread, and an installation's own commands (TripIt forward, the property-portfolio CLI, show and comedian logs). Those now escalate to ops.

## Rollout

1. **Replay (dry run, by hand).** `email-triage-run --payload <p> --dry-run` runs the read tools and records every change it would make. Replaying recent emails and comparing the labels, priority, pings and tasks with what the ops-light turn did is the evidence for the flip.
   **First replay, 2026-11-16** (30 random ops-light triage emails from Nov 9–16, the decision record as ground truth after the resolution repair): 29 of 30 finished (the 30th triaged correctly with a task and a ping but no label change, which the runner then counted as a failure; fixed). Against the recorded decision, the label matched 26/29 and the priority 25/29. The priority differences: two lease-date notices and one application notice the one-shot filed P3/P2 by the email memory where the agent had left intake's P1, and one Zoho Sign bounce it judged a duplicate using memory written after the email (a replay artefact). P1 pings and P1 tasks matched the agent's on 28/29. 6 escalated (4 Amazon "Delivered" mails, which need the order page; a car-rental confirmation, which needs the TripIt forward and flights-scan; one thread question). **These numbers came from runs that saw only part of the rules core** (the 53 KB result was moved to a file the one-shot cannot open; fixed the same day by paging), so they are not evidence. With the whole core read, a run costs about $0.17 and 13 s, close to an ops-light triage turn (about $0.16).
   A replay is weak evidence: the tools read today's Gmail labels and email memory, which the agent wrote when it triaged that same email (11 of the 30 runs read the memory, and the Apple Support run skipped a calendar event because the agent's own event was already there).
2. **Shadow.** `ops.gmailTriageTarget: "strict-shadow"` (restart the ops supervisor): live triage is unchanged, and a dry one-shot runs on each email as it arrives, before the agent has written anything about it (the two run side by side, so a slow one-shot can still see the agent's labels). `bin/email-triage-report` scores the runs at least 20 minutes old. The bar is the one the triage rules set for replacing triage: ≥ 150 scored emails over ≥ 7 days, label and priority agreement ≥ 95%, zero missed P1s. Escalated runs are counted, not scored.
3. **Switch.** When the report meets the bar, the owner sets `"strict"` and restarts the ops supervisor. Rollback: `"ops-light"`.

`triage-decide` (decide-then-act in code, `email-triage-rules.md` § Decide-then-act) is a separate path that runs before dispatch; when it goes live, the strict one-shot covers what it still hands to an agent.
