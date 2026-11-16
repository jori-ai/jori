# Strict email triage

Per-message Gmail triage reads mail from anyone. Until 2026-11-16 every such email became a turn in the ops-light session: Sonnet with Bash, files, the web, 66 Jori tools and a long-running session that also runs Hum and other jobs. An email that talked the model into something had all of that to work with.

The strict path triages the same email, under the same Email Triage Rules, in a one-off `claude -p` that has no shell, no files, no web, no browser and no mailbox search. It is in the code and dark until `agents.json` → `ops.gmailTriageTarget` is `"strict"`.

## Pieces

| Piece | What it does |
|---|---|
| `agent/supervisor/triage-route.mjs` | With `"strict"`, runs the one-shot for each per-message item (at most `STRICT_MAX` = 3 at once). When it does not finish, the item goes to ops-light as before, with a note of what the one-shot already did. |
| `bin/email-triage-run` | Starts the one-shot: built-in tools off (`--tools ""`), `--strict-mcp-config` to one server, Sonnet at medium effort, the locked-down agent environment (`lib/agent-env.cjs`, id `email-triage`). Exit 0 = triaged or escalated; exit 3 = fall back. Log `data/email-triage-oneshot-log.jsonl`; cost rows in `agent/logs/ephemeral-forks/job-costs.ndjson` under `gmail:<id>`. |
| `agent/tools-mcp/email-triage.mjs` + `lib/email-triage-tools.mjs` | The only tools. Each wraps the CLI the rules name, so the rules read the same. |
| `agent/ops-agent/jobs/email-triage-strict.md` | The one-shot's system prompt (the `oneshot` section): which tool stands for which command, and "no tool → escalate". |

## Bounds, enforced in code

- **The email is bound by the runner** (message id, sender, subject, Date). Gmail changes, the P1 task, the P1 downgrade and the spam block act on that email or sender only; no tool takes a message id or an address.
- **Labels** come from the triage label set plus `p1`/`p3` (and an installation's `email-triage.json` `extra_labels`).
- **`notify_owner`** reaches the owner only, with an intent from a fixed list; `--evidence-as-of` is the email's own Date and a P1 pointer carries `--p1-message`. The send still passes the precheck and the speak gate.
- **Calendar writes** take no attendees.
- **`escalate_to_ops`** sends ops the message id and a reason from a fixed list (plus a validated rule slug), never model-written text. Ops re-reads the email itself, so an escalated email is still read by a Bash-capable agent: this narrows the exposure, it does not remove it.
- **No tool** for following links, the browser, the Gmail connector, a reply or forward, a dispatch, or an installation's own commands: each is an escalation.

## What escalates

Measured over 933 ops-light triage turns (2026-10-18 to 11-16), 87.5% used only commands this toolbox covers. The rest are mostly Amazon delivery tracking (following the tracking link, four times opening an Amazon order page in the signed-in browser), the Gmail connector for the thread, and an installation's own commands (TripIt forward, the property-portfolio CLI, show and comedian logs). Those now escalate to ops.

## Rollout

1. **Replay (dry run).** `email-triage-run --payload <p> --dry-run` runs the read tools and records every change it would make. Replaying recent emails and comparing the labels, priority, pings and tasks with what the ops-light turn did is the evidence for the flip.
2. **Flip.** The owner sets `ops.gmailTriageTarget` to `"strict"` and restarts the ops supervisor. Rollback: `"ops-light"`.

`triage-decide` (decide-then-act in code, `email-triage-rules.md` § Decide-then-act) is a separate path that runs before dispatch; when it goes live, the strict one-shot covers what it still hands to an agent.
