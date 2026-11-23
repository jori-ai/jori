# Coherence check — does every stated reason in a message actually follow?

`bin/coherence-check` · `lib/coherence-check.mjs` · tests `tests/coherence-check.test.mjs`

## Why

A hum ping reminded the user of an airport pickup and, in the same breath, of an item due to be delivered that day: "a quick look at the mailbox before you leave would save a trip back". It saved nothing. Something delivered at home waits there while you are at the airport, and the ping was not even about the trip it was routed to.

Every gate in front of the send passed it, and each was right about what it checks: the resolve-first gate found nothing to answer, the speak gate confirmed the flight, the pickup and the open task were all real, the router read the flight and placed it with the travel member. None of them asked whether the message's **own stated reason follows from its facts**. The fusing happened at compose time: the `situation` harvester emitted one candidate that already carried both items, joined by an invented benefit, and the ranker kept it whole.

The fix is general, not about deliveries, errands or airports: no keyword list, no rule about any kind of item.

## The judgment

A model reads the message **on its own**: no records, because whether the facts are true is the other gates' job. It looks for a second, separate subject attached to the message's subject, by a claimed reason or benefit ("so", "before you go", "while you're there", "on the way", "saves a trip", "good moment to") or by a bare connective ("also", "too"), and asks of each link: given only what the message says, would the person act differently because of it?

- **The link follows** when the stated facts make it true: the second errand is on the route, one thing's timing really frees or blocks the other, both belong to the same trip, booking, place or decision, or doing them together really saves what is claimed.
- **The link fails** when the benefit is invented or the second subject has no bearing on the first. A bare "also" that staples an unrelated subject on fails too.
- **Never a failure:** a single subject however many facts it gives, a roundup built as separate items side by side (a digest, a list the person asked for), a loose link that still holds.

The model lists every link it considered (words, follows, why), names the subjects, and decides. Code owns the action table:

| decision | when | what is sent |
|---|---|---|
| `keep` | no link fails | the message exactly as written |
| `trim` | a link fails; the attached part is not worth a message of its own (it adds nothing the person needs now, or it is plainly already theirs, like an item from their own list that is merely due) | the message without it |
| `split` | a link fails; the attached part IS worth telling on its own (a fact they may not have, or something to act on) | the message without it; the part is queued as its own hum candidate |

A message is never held whole: the most the check does is take a part off. The kept and detached texts use only the message's own facts and, as far as possible, its own words. A question is always kept (it is the message's main subject), and when the message offers tappable answers, the part they answer is the part kept.

**Validation (code, structural).** A `trim` or `split` must mark at least one link as failing, and its kept text must be non-empty and shorter than the original; a `split` needs its detached text (≤ 600 characters); a `keep` must mark no link as failing. Anything else goes to the next rung.

**Model ladder.** Sonnet at low effort, then Opus, climbing only when a rung errors or its answer fails validation (Max session, tool-less, structured output through `lib/max-judge.js`; the instructions ride in the appended system prompt, so repeated calls read them from cache). A fatal error (not logged in, a usage limit) stops the ladder at once. No Haiku rung, on evidence: on 2026-11-21, of the two wordings of the triggering ping, Haiku kept one ("the mailbox is at the start of the trip, a natural same-place step"); Sonnet caught both and kept every legitimate link in the test set (a freed hour, a shop next door, a late arrival on the same trip, a three-item roundup). A whole decision takes 2–7 s; the rung timeouts (30 s, 40 s) and a 60 s deadline bound the worst case.

**Fail-open, never fail-true.** No model, a timeout, a fatal error or no valid answer on any rung → the message goes out exactly as written, and the log row says why (`decision: "error"`). The check only ever removes; what it keeps is still read by the gates after it (the speak gate checks the kept text against the records).

## Where it runs

1. **`bin/hum-ping`, before `ping-route`.** Every hum info ping is judged before the router picks the team member, so the route is chosen on the one subject that goes out (the triggering ping's route was chosen partly on the half that should not have been there). hum-ping then passes `--coherence-checked`, so `jori-send-curl` does not judge it again. A trim or split replaces the text and drops a custom `--push-body` (it described the original). The feedback row carries `coherence: {decision_id, action, split_id?}` when a part was taken off. Not for a local explanation (`nearby`): one subject by construction, and worth something only while the user is still standing there (hum-ping passes `--coherence-checked` for it too, so `jori-send-curl` skips it).
2. **`bin/jori-send-curl`, after every other text-changing gate and before the role signature and the speak gate**, for every other message that is:
   - chat-bound (the `chat` or `questions` channel),
   - proactive: not the chat agent's own replies (`--agent chat`), and not an answer to something the user asked for (the solicited intents the precheck and the speak gate never drop: `mention-reply`, `chat-build-question`, `chat-build-result`, plus `improvement-card`; or any `--conversation` reply),
   - one that reaches the resolve-first or precheck gate (a `hum:` intent, or no `--skip-precheck`), and
   - not a bank, brokerage or health intent, nor a finance or stocks hum lane (`send-intents.json`).
   That covers hum questions (`hum-ask`, `hum-deliver-qual`) and every content-driven job ping. It reads the words before the role's "Name:" signature is added, so a trim never cuts the signature and a split-off part never carries one. TERM is ignored from that point (as for the speak gate), so a caller's short timeout cannot drop the message while it is judged. A message the sender marked as a question (`--question`, a question intent, tappable answers, or question routing's verdict) is judged with that said, and its question is always kept. Not in a test run unless `JORI_COHERENCE_CHECK_BIN` names a stand-in.

## Split-off parts

A `split` part is appended to `data/hum-split-queue.jsonl` (`add` event: id, text, where it came from, `expires_at` = the end of the local day it was split off). `hum-harvest-all` offers the newest waiting part as **one more candidate per turn** (newest first, so a part the ranker keeps declining never blocks a fresher one): `topic: "split"`, `dedup_key: "split:<id>"`, urgency 0.55, dated by when it was split off (never `live`, so the freshness gate re-checks it), with no link to anything. It goes through claim-check, the pre-rank vetoes and the ranker like any other candidate, and it wins only on its own merits. When it does, it is sent with `--lane split`; `ping-route` places it with its own team member, and every send gate (this one included) reads it.

- **One chance.** Once `hum-ping` has put it through a send, whether it went out or a later gate held it, it is marked `consumed`.
- **Today only.** A part that never wins lapses at the end of its day; its source, if it still matters, reaches the user through its own lane.
- **Never wakes a turn.** It is not offered in a preview harvest: the idle gate (`lib/jev-hum-gate.mjs`) wakes a hum turn whenever a preview finds anything eligible, and a part the ranker keeps declining would otherwise wake one on every idle check until midnight. So it rides along only on turns that run anyway.

## Compose side

The check is the backstop; the composers are told not to need it. The `situation` harvester's prompt says a candidate has ONE anchor and never attaches a second, separate item with a claimed reason or a bare "too/also" unless the facts make the link true (if two things are timely, emit the more timely one). The hum ranker's HARD RULES (`agent/ops-agent/jobs/hum.md` § Decision logic, ONE PING, ONE SUBJECT) say the same for the ping it writes.

## Privacy

`jori-send-curl` never calls it for the bank, brokerage and health intents or the finance and stocks hum lanes, and the library itself refuses every private hum lane (finance, stocks, health, exercise), whether `--lane` or the intent names it, logging `skip: private` with no text. Their text reaches neither the log nor the split queue.

## Measuring it

- `data/coherence-check-log.jsonl` — one row per decision: `{ts, decision_id, source, intent, lane, ping_id, decision, reason, links, original, kept, detached, split_id, model, attempts, ms}` (`decision` is `keep`, `trim`, `split`, `skip` or `error`).
- `data/hum-split-queue.jsonl` — `add` / `consumed` events.
- `coherence-check stats [--since 7d] [--json]` — counts by decision and by source, what became of split-off parts (put through a send, waiting, lapsed), median latency. `coherence-check tail [-n 10]` — the latest decisions with what was kept and taken off. `coherence-check queue [--all]` — waiting parts.
- The hum feedback row's `coherence` field ties a trimmed or split ping to the user's reaction.
- The weekly `hum-review` reads the stats and the tail (Step 2 #14, § 6d One subject per ping): trim and split rates, samples of what was taken off, and any badly received ping the check missed.

## Operating it

- Off switch: `touch data/.coherence-check-off` (both call sites then send as written; the decision is logged as `skip: off`).
- Try a message by hand: `echo '{"message":"…"}' | bin/coherence-check --dry-run` (judges, writes nothing).
- A part split off wrongly is harmless to leave: it lapses at the end of the day.
