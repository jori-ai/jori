# Think before you speak (the speak gate)

**Status (2026-11-10): built and replayed, NOT wired.** `bin/speak-gate.mjs` judges a message; nothing live goes through it yet. The live path is still `bin/outbound-precheck.mjs`, called from `jori-send-curl`.

## Why

The user, 2026-11-10: proactive messages reached them without a real review. The outbound precheck asks one narrow question on a tool-less, low-effort read: does this contradict or repeat the last 8 hours of chat? It never asks whether the message is true, whether the assistant could have found the answer instead of asking, whether the question is the right one, or whether it is worth the user's attention. About half the messages in a week (340 of ~670) skipped even that: 59 `--skip-precheck` callers, and three paths that write to the app directly (`findme`, `bin/role-session`, `jori-notify` from playbooks). Emails to the user had no check at all.

## The gate

ONE gate every message to the user passes, whatever its route (app, push, email to the user). Four questions:

1. **True & current**: every claim holds against the sources right now, and the message is still relevant. A claim that something MATCHES (a listing fits a watch, a charge is a known payee) needs the match itself checked.
2. **Self-resolve**: could the assistant answer it itself, or close the item without asking? If so, `resolve` with the answer found. If asking is right but the question is the wrong one, `rewrite`.
3. **Phrasing**: one point; a question is one decision with choices and a recommendation; short, plain, no internal jargon, no hedging.
4. **Value**: new to the user, actionable or genuinely interesting, timely. The user's standing rules override the gate's sense of value.

Verdicts: `send`, `rewrite` (the better text), `resolve` (back to the role, with the answer found), `digest` (wait for the daily summary), `drop`.

**Depth (the user's call):** a proactive message gets all four checks at medium effort with a 300 s budget; a reply to something the user wrote gets 1 and 3 at low effort with 120 s, and is never dropped, only sent or corrected.

## Research, not a glance

The user, grading the first replay: "go beyond a cursory verification — check all available sources, including all our databases and applications, and the web." The judge is a Claude session (Sonnet, on Max) with **read-only** tools and as many steps as it needs:

- `bin/db-read`: every Supabase table, GET only by construction (`db-read tables` lists them).
- `bin/recall` (chat + wiki + inbox + replies), `bin/jori-messages-search`, `bin/wiki`.
- `bin/rentals`: the rental portfolio's books, read-only by design.
- `bin/location-day` (where, legs, with steps), `bin/findme history`, `bin/travel`, `bin/finance-facts`.
- `gog calendar list`, `gog gmail search`, `gog tasks list`.
- Read / Grep / Glob over the installation (logs, data stores), with `.env`, oauth, key and secret files denied.
- WebSearch / WebFetch, except for money and health messages. A message from a role in `no_web_roles` (default CFO, Health Coach) or with a private intent is researched without the web, and every run is told never to put personal data in a web query (agent/CLAUDE.md § Financial Operations rule 5, § Health).

It is locked down: `--permission-mode dontAsk` (anything not allowed is refused without a prompt), only those Bash prefixes plus read-only filters (`head`, `tail`, `jq`, `grep`, …), no MCP servers, no settings files, no session kept. It cannot write, send or change anything.

**Evidence up front**, so research starts from what is known: the outbound precheck in evidence mode (`OUTBOUND_PRECHECK_EVIDENCE=1`): the transcript, the calendar, the user's dated words, wiki hits, acknowledged topics, today's pings, travel facts, and any place/date pairing the travel check flagged. The freshness stage is skipped in this mode, because the gate verifies truth itself and bank or health text must not reach the freshness models. Added on top: the sending role's own conversation for 14 days with each question's state, the questions still open, and the user's **standing rules** (`agent/local/config/speak-gate.json` `standing_rules`, their own words; `SPEAK_GATE_CONFIG` points a staged replay at another file).

**The travel check no longer drops by itself (live too).** `lib/claim-facts.mjs` pairs any place with any date in a message. A "hard" contradiction used to suppress the message deterministically, and did so 19 times by 2026-11-10, a P1 email and a nightly review among them. The user, grading two of those: "This has nothing to do with where I am"; "when a large charge comes in it doesn't matter where I am." Whether a message actually claims where the user is is a question about meaning, so the flag is now evidence for the model, in the live precheck and in this gate.

## Replay

`bin/speak-gate-replay.mjs [--n 100 | --ids <file>]` judges past messages **as of one second before each was sent** (`OUTBOUND_PRECHECK_AS_OF`). In that mode the transcript, the user's dated words, message lookups and the role thread stop at that instant; question states (today's) are hidden; and the judge is told to ignore anything dated later, since live tools and the wiki cannot be rewound. It must run under launchd (Max login), not over ssh or cron.

- **Replay 1** (2026-11-10, 100 messages, tool-less judge): 21 sent as written. The user graded 29 of its calls: 23 right, 1 partly, 5 wrong. Two of the wrong ones were the travel-check drop, one was a package notice held for the digest (the user wants every delivery right away), one was a false watch match the gate kept, and one was a question the gate should have answered from location and steps data.
- **Replay 2** (same 30, research gate, standing rules): the package notice is sent, the false match is caught, and the appraiser message is held for the right reason (already answered). p50 15 s, max 77 s per message. The large-charge alert was still held, so its standing rule was made absolute.

## Before wiring (open)

- What happens to `resolve` (the role's next session gets the answer to record) and `digest` (the daily summary takes held items) in the live path.
- The fixed allowlist of pure system alerts that replaces `--skip-precheck`.
- The three direct-write paths and emails to the user routed through it.
- Cost at ~100 proactive messages a day, and whether time-critical lanes need a shorter budget.
