# Think before you speak (the speak gate)

**Status (2026-11-11): LIVE.** Every message to the user in the app is judged by `bin/speak-gate.mjs` BEFORE it is written or pushed, and the verdict is acted on (§ Live). The shadow pass stays on as the safety net for any route that still writes without it.

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

## Shadow week

The user's call (2026-11-10): "shadow for a week and show me your judgement on each. I'll provide feedback on whether it's correct or not."

- `plugins/speak-gate` (enable with `jori plugin enable speak-gate`): launchd `ai.claude.speak-gate-shadow`, every 5 min, runs `bin/speak-gate-shadow-trigger` (Max-auth guard) → `bin/speak-gate-shadow.mjs`. Each pass takes up to 12 assistant messages sent since its cursor (`data/speak-gate-shadow.json`; the first run starts the cursor at that moment and sets `ends_at` a week later), works out proactive or reply (a `reply_to`, or a user message in the same conversation within 15 minutes before), and runs the gate as of one second before the message was sent. Log: `agent/logs/speak-gate-shadow.log`.
- Verdicts go to `public.jori_gate_reviews` (migration 0181): message id, conversation, verdict, reason, suggestion (the rewrite, or what it found), checks, sources, time.
- The app shows a line under each judged message ("Gate: would hold for the daily summary"); tapping it shows the reason and suggestion, with **Right call** / **Wrong call** and a note, written back to the same row (`grade`, `note`, `graded_at`).
- Covers every route into the app (jobs, role replies, location, chat answers). Emails to the user are not in the shadow.
- At the end: the grades decide the prompt and rule changes, then wiring.

## Live (2026-11-11)

The user, after the shadow week's first day: "it should be reviewed before i see it — not after"; "review and act — below tell me what was the original and still ask if made the right decision"; "show the reviewed result as primary and the original as hidden until exposed by the user".

`lib/speak-gate-live.mjs` (`gateOutbound`, `recordReview`; CLI `bin/speak-gate-live gate|record|enabled` for shell and Python) runs the gate in front of delivery:

| Verdict | What happens | In the app |
|---|---|---|
| `send` | delivered as written | folded line "Checked, sent as written" |
| `rewrite` | the gate's text is delivered | "Rewritten before sending"; opening it shows the original |
| `drop` / `digest` / `resolve` (proactive only) | **held**: never written to `jori_messages`, never pushed | a folded "Held: …" line in the conversation (after the last message before it), with the message it held and, for resolve, what it found |
| gate error / timeout | delivered as written | "Check failed, sent as written" |

Every line has **Right call / Wrong call** and a note. A reply to something the user wrote is only ever sent or rewritten.

- **Routes:** `bin/jori-send-curl` (after every other gate, before the insert; regardless of `--skip-precheck`; `--agent chat` = reply; a held message prints `{"suppressed":true,"by":"speak-gate"}` to a `--capture-id` file and releases a P1 fold claim), `bin/choice` (the card's options are passed as fixed choices; a location card gets 90 s), `bin/role-session reply` (reply), `bin/jori-send.mjs`, and the phone-channel `reply` tool (reply; `message_file` replies, composed by a tool from the source of record, are not judged). With the gate live, phone-channel does not stream replies, since streamed text would be seen before review, and the older send-then-correct freshness pass runs only when the gate failed.
- **Scope:** channels `chat` and `questions`, and email to the user alone; never `system`/`improvements`, never a test run.
- **Budgets (live):** reply 60 s, proactive 240 s (`SPEAK_GATE_LIVE_TIMEOUT_S`).
- **Storage:** `jori_gate_reviews` (migration 0184): own `id` key; `message_id` optional and unique; `original`, `live`, `held`. The app reloads on realtime changes to the table. A review that cannot be written is parked in `data/speak-gate-live-unrecorded.jsonl`.
- **Off switch, no deploy:** `data/.speak-gate-off`, or `"live": false` in `agent/local/config/speak-gate.json`. Everything fails open.
- **After a hold** (migration 0185):
  - `digest` → the nightly daily summary email prints it verbatim under **"Held for this summary"**, after Decisions (`bin/daily-summary-build` `attachHeldDigests` at prep: every held digest not yet printed and held before that day ended, plus any already printed in that day's summary; `publish` sets `digested_on`). Email only, never the wiki day page; the review's money check skips the list (`class="held-digest"`). The app line then reads "In the daily summary for <day>".
  - `resolve` → the answer goes back to the role that asked: `bin/role-session prepare` gives that role's next session an "ANSWERS FOUND FOR YOU" block (record it, act on it, never ask again), and phone-channel gives the coordinator's next chat turn the same for chief-of-staff and unsigned senders; `handed_back_at` is set. The gate itself is shown every answer it found in the last 14 days, so a job that asks the same thing again is resolved with the same answer.
- **Email to the user** (`bin/email-send`, every one of its callers): mail whose ONLY recipient is the user is judged before it is sent. Plain text = proactive (sent, rewritten with the body replaced, or held: not sent, "Held: …" printed, exit 0). HTML = a report the user set up (`kind: "report"`: truth and phrasing only, never held; a suggested fix goes to the app, never spliced into the built HTML). `--in-reply-to` = a reply (never held). Mail that also goes to someone else is not judged. The review has no message row; the app shows it as a folded "Email …" line in the sender's conversation, with the email folded under it. `SPEAK_GATE_EMAIL=0` skips one send (jori-send-curl's push-failure email fallback, already judged).

## Before wiring (open, as of the shadow week)

- What happens to `resolve` (the role's next session gets the answer to record) and `digest` (the daily summary takes held items) in the live path.
- The fixed allowlist of pure system alerts that replaces `--skip-precheck`.
- The three direct-write paths and emails to the user routed through it.
- Cost at ~100 proactive messages a day, and whether time-critical lanes need a shorter budget.
