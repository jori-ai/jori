# Think before you speak (the speak gate)

**Status (2026-11-10): built, replayed, NOT wired.** `bin/speak-gate.mjs` exists and was replayed over a week of past messages (`bin/speak-gate-replay.mjs`); no live message goes through it yet. The live path is still `bin/outbound-precheck.mjs`, called from `jori-send-curl`.

## Why

The user, 2026-11-10: proactive messages reached them without a real review. The outbound precheck asks one narrow question on a tool-less, low-effort read: does this contradict or repeat the last 8 hours of chat? It never asks whether the message is true, whether the assistant could have found the answer instead of asking, whether the question is the right one, or whether it is worth the user's attention. About half the messages in a week (340 of ~670) skipped even that: 59 `--skip-precheck` callers, and three paths that write to the app directly (`findme`, `bin/role-session`, `jori-notify` from playbooks). Emails to the user had no check at all.

## The gate

ONE gate every message to the user passes, whatever its route (app, push, email to the user). Four questions, judged by Sonnet:

1. **True & current**: every claim holds against the sources right now; still relevant.
2. **Self-resolve**: could the assistant answer it itself (wiki, message log, calendar, travel, recorded finance facts) or close the item without asking? Or is a better question available?
3. **Phrasing**: one point; a question is one decision with choices and a recommendation; short, plain, no internal jargon, no hedging.
4. **Value**: new to the user, actionable or genuinely interesting, timely.

Verdicts: `send`, `rewrite` (the better text), `resolve` (back to the role with a research plan), `digest` (wait for the daily summary), `drop`.

**Depth (the user's call):** a proactive message gets all four at medium effort; a reply to something the user wrote gets the light check (1 and 3, low effort) and is never dropped, only sent or corrected.

**Research without tools.** The judge is tool-less (`lib/jev-claude.mjs`). It may answer `{"lookups":[…]}` once; the gate runs those from a fixed read-only menu (`wiki_search`, `wiki_read`, `calendar`, `travel_where`, `messages_search`, `finance_facts`) and asks again with the results. Nothing the model writes is executed.

**Evidence:** the outbound precheck in evidence mode (`OUTBOUND_PRECHECK_EVIDENCE=1`): the chat transcript, the calendar, the user's dated words, wiki hits, acknowledged topics, today's pings and travel facts. Its deterministic suppressions (authority contradiction, settled subject, stale premise) still decide first. Added on top: the sending role's own conversation for 14 days, with each question's state, and the questions still open.

**Claude only, never Jev**, so money and health messages go through it too.

## Replay

`bin/speak-gate-replay.mjs --n 100` samples a week across questions, proactive chat, replies, system and improvements, and judges each **as of one second before it was sent** (`OUTBOUND_PRECHECK_AS_OF`). In that mode the transcript, the user's dated words and message lookups stop at that instant, and question states (which are today's) are hidden, so a later answer to the very message cannot count as "already answered". The wiki cannot be rewound; the judge is told to ignore anything dated after the instant. It must run under launchd (Max login), not over ssh or cron.

## Before wiring (open)

- The user grades a sample of verdicts.
- A fast path for time-critical lanes (nearby, P1 email, lottery deadlines): measured latency is ~10 s per message, so possibly none is needed.
- What happens to `resolve` and `digest` in the live path (the role's next session gets the research plan; the daily summary takes held items).
- The fixed allowlist of pure system alerts that replaces `--skip-precheck`.
- The three direct-write paths and emails to the user routed through it.
