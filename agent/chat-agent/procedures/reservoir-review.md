# Reservoir Review

On-demand procedure for the chat agent, moved verbatim out of `agent/chat-agent/CLAUDE.md` (which keeps the trigger and hard rules inline). When this file and CLAUDE.md seem to disagree, CLAUDE.md's inline rule wins.

## Reservoir Review (consume stale ideas on feedback)

When the user signals that something is already handled — **or** reacts negatively to a hum ping — immediately scan the hum idea reservoir and consume any related unconsumed ideas. This prevents the same ask from resurfacing on the next ideation cycle.

**Trigger 1 — the user says it's handled, or someone else has it.** You judge this from what they said ("already submitted the listing", "Sam is handling the TV setup", "waiting for the payment provider's approval") — not from whether the message contains a particular word. Name the topic in a short phrase and call:

```bash
~/Dev/jori/bin/hum-reservoir-review --topic "<short phrase naming the topic>" \
  --reason "already done: <what the user confirmed>"
```

Examples: "already submitted the listing" → `--topic "property listing submission"`; "Sam is handling the TV setup" → `--topic "TV setup at the beach house"`.

The CLI retires the unconsumed ideas whose subjects are **about** that topic by embedding similarity (`lib/hum-topic-match.mjs`) — no word matching. It refuses a topic so broad it would sweep more than 6 ideas (exit 3, nothing consumed — name the topic more specifically and retry once), and consumes nothing when the local embedder is down.

Then append one line to `data/hum-resolved-topics.jsonl` (create if absent) so the next ideation run refuses new ideas on this topic for 48h (`hum-ideas-append` Rule 10 compares against `topic` by embedding):

```json
{"ts":"<ISO>","source_ping_id":null,"task_id":null,"topic":"<the same topic phrase>","resolution":"<the user's message, first 100 chars>","suppress_until":"<ISO: now + 48h>"}
```

Ack: `"got it — cleared <N> related idea(s) from the reservoir"` if N > 0. Silent (no mention) if N = 0.

**Trigger 2 — skip/down reaction to a hum ping.** After recording the reaction via `jori hum feedback last <token>` (Step 2 of Hum Inbound Handling), run the same review with the last ping's subject as the topic. Read it from the last `sent:true` row in `~/Dev/jori/data/hum-runs.jsonl` (field `sonnet.subject`) or from `hum-feedback.jsonl`'s last row:

```bash
~/Dev/jori/bin/hum-reservoir-review --topic "<the ping's subject>" \
  --reason "skipped: <original subject>"
```

Also append to `hum-resolved-topics.jsonl` (same format as Trigger 1, `source_ping_id` = the skipped ping's id, 48h suppress window).

Ack: same — mention only if N > 0.

**Why this matters.** The hum ideation agent generates ideas from a point-in-time snapshot. When the user confirms something is done (submitted Saturday, ordered yesterday) or reacts negatively to an idea, already-generated reservoir entries don't self-update. Without this step the ranker eventually lets stale ideas through — surfacing the same ask twice. Two incidents 2026-05-05: one ask surfaced a 3rd time, another a 2nd time the same day. The `hum-resolved-topics.jsonl` write closes the loop for the ideation agent on its NEXT run — the reservoir sweep alone doesn't prevent new ideas from being generated in the same topic area.

**Scope.** Only fire on explicit done-signals, delegation confirmations, or negative reactions. Do NOT fire on positive reactions (👍, helpful, more) — those should resurface more often, not less.

