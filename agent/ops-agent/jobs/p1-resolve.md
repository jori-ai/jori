P1-RESOLVE — downgrade a P1 email to P3 when the user says it's handled. Dispatched by chat-agent (a phone-channel text like "the hosting renewal is resolved") or by `jori triage resolve "<topic>"`. Two more signals share this file, both pure code: the Unstar scan and the Reply sweep (below). Every downgrade, whatever the signal, also closes the Google Task the P1 created.

## Trigger

Task string `RESOLVE P1: <topic>`. Topic is free-form text describing which P1 to close (subject fragment, sender name, property, vendor, event).

Examples of what `<topic>` looks like:
- `hosting renewal`
- `social account password reset`
- `<tenant name> rent`
- `<property> guest complaint`

## Step 1 — Find candidates

Search Gmail for live P1s, widest net first:

```
label:p1 is:starred newer_than:60d
```

Use `mcp__claude_ai_Gmail__search_threads` or `gmail-action` equivalent. For each thread fetch metadata (`Subject`, `From`, `Date`, first body snippet). You should get at most ~30 threads; P1s are rare.

**Connector caveat:** the claude.ai Gmail connector's `label:` operator has been seen to return **zero** matches for the `p1` label — both `label:p1` and the raw label id — even when p1 emails demonstrably exist, while `label:` works for other labels. **An empty `label:p1 …` result from the connector is therefore NOT trustworthy on its own.** When it comes back empty, fall back to a label-independent **filter-in-results** read: run the query without the `label:` clause (e.g. `is:starred newer_than:60d`) and keep only threads whose returned `labelIds` contain the p1 label's id (`gmail-action` can list label ids). This is a **connector-only** bug: the **Gmail REST API** path (`bin/gmail-action`) resolves `label:p1` correctly, so a `gmail-action count "label:p1 …"` result IS trustworthy.

Score each candidate against `<topic>`:
- **+3** keyword from `<topic>` appears in Subject
- **+2** keyword appears in From (sender name or domain)
- **+1** keyword appears in body snippet
- **+1** if the topic maps to a known entity and the sender/subject mentions that entity's canonical name (use the installation's property and vendor aliases where it has them — e.g. a nickname for a property → its canonical name, a product name → its vendor's sender).

Normalize both sides: lowercase, strip punctuation, split on whitespace. A keyword is any word in `<topic>` ≥3 chars that isn't a stopword ({is, was, the, and, for, with, resolved, handled, done, fixed, closed, taken, care, of}).

Drop candidates with score 0.

## Step 2 — Decide

**Exactly 1 candidate (score ≥3) OR a clear leader (top score ≥3 AND ≥2 above second-best):**
→ **Act without confirmation.** Call:
```
bin/p1-downgrade <messageId> --source text-resolve --reason "<the original topic text>"
```
Reply to the user via `jori-send-curl`:
> ✓ downgraded P1: "<subject>" (from <sender>). Source: text-resolve.

**Multiple viable candidates (≥2 with score ≥3, no clear leader):**
→ **Ask which one.** Reply:
> Two P1s match "<topic>":
> 1. "<subject 1>" — <sender 1> (<age>)
> 2. "<subject 2>" — <sender 2> (<age>)
> Which to close? Reply "1" / "2" / "both" / "neither".

Persist state to `data/p1-resolve-pending.json`:
```json
{
  "topic": "<original topic>",
  "candidates": [{"messageId": "…", "subject": "…", "from": "…"}],
  "created_at": "<ISO>",
  "expires_at": "<ISO +2h>"
}
```
Chat-agent reads this file on the user's next phone message (see `chat-agent/CLAUDE.md § Resolution Intent`).

**Zero candidates:**
→ Reply:
> No live P1 matching "<topic>". Search tried `label:p1 is:starred newer_than:60d` — all current P1s are unrelated. Want me to search wider (e.g. already-archived) or paste the subject line?

Do NOT fall back to downgrading something weakly related — false positives silently lose signal.

## Step 3 — Edge cases

- **Topic is just "resolved" with no antecedent.** Chat-agent should have rejected this upstream, but if it still arrives, reply: `"Resolved what? Need a topic — a sender, a subject word, a vendor."` and stop.
- **Topic matches a thread that has `p1-resolved` label already.** Idempotent — `p1-downgrade` is safe to re-run, but reply `"Already downgraded (resolved <date>) — no change"` instead of a fresh confirmation.
- **Topic matches a P1 the user replied to in the same thread recently (within 24h).** Proceed — the reply is additional confirmation that the thread was handled.

## Unstar scan (Signal A — the user unstarred; no agent turn)

Rebuilt 2026-10-04 as **pure code**. `bin/p1-unstar-sweep` runs from `agent/scripts/trigger-p1-resolution-scan.sh` every 30 min, right after the reply sweep. There is no `UNSTAR SCAN P1` dispatch any more, and no ops-haiku turn.

**The rule.** A P1 is downgraded when all three hold:
1. **Gmail history shows its STARRED label removed** since the last tick (`users.history.list`, `historyTypes=labelRemoved`, watermark in `data/p1-unstar-sweep.json`).
2. **The agent did not remove it.** `gmail-action unstar` appends every unstar it makes to `data/gmail-self-unstars.jsonl`; a removal within 2h of a ledger row for that message is the agent's own and is skipped.
3. **It is still `p1` and still unstarred** when the sweep looks (`messages.get`). A message that has been re-starred, relabelled or deleted is left alone.

The decision core is `lib/p1-unstar.js` (tests: `tests/p1-unstar.test.mjs`). The survivors go to `bin/unstar-scan-run` in one call. It downgrades each through `p1-downgrade --source unstar-scan`, which closes the linked Google Task. It also reports through `p1-alert-gate` (`--none` on an empty tick, so a failure streak still clears).

**Why history.** The old scan queried `label:p1 -is:starred`. That also returns messages that were **never starred**, such as a fresh inbound reply that inherited the thread's `p1` label. Telling the two apart was the one judgment the agent turn existed to make, and ambiguous mail was left untouched for the full 14-day window. A STARRED-removed event is structural proof of an unstar, so the judgment is gone: a never-starred message has no event and is never a candidate.

**State and edge cases.**
- **First run, or history expired.** Gmail keeps history for about a week. If there is no watermark, or Gmail answers 404 for a stale one, the sweep seeds from `users.getProfile` and acts from the next tick. Unstars in that gap are not replayed. They remain visible as `label:p1 -is:starred` if anyone asks.
- **Failed downgrade.** The watermark still advances, but the id goes on `retry` in the state file. It is retried on each of the next 6 ticks, then logged as given up. The failure itself is in `data/p1-resolutions.jsonl` (`success:false`) and paged only through `p1-alert-gate`.
- **Bulk cleanup.** More than 5 unstars in one tick is logged as a bulk cleanup. There is no ping: an unstar is the user's own action, so it is silent by design.
- **Kill switch:** `data/.p1-unstar-sweep-off`. Log: `agent/logs/p1-resolution-scan.log`.

**Retired with the dispatch:** `bin/p1-scan-gate` (`p1-scan-seen.json`) and the Jev `p1-resolution` site (`bin/jev-p1-gate`, its shadow force list). Both existed only to decide whether to wake the turn, and there is no turn to wake. The binaries stay in the tree for history, but nothing calls them.

You (the agent) never run this sweep. If asked whether a P1 was closed by an unstar, read `data/p1-resolutions.jsonl` for rows with `source: "unstar-scan"`.

### Reliability notes that still apply

- **Gmail REST calls in this pipeline use `fetchWithRetry` from `lib/google-auth.js`, never a bare `fetch()`**. A bare `fetch()` turned every transient DNS/TLS blip into a paged failure.
- **Errors are logged through `describeError()`**, which walks Node's `err.cause` chain. `fetch()` always throws the generic `fetch failed`, and the real reason (`ENOTFOUND`, TLS, timeout) lives only in `.cause`.
- **`p1-downgrade`'s audit rows record real outcome** (`success`, plus `errors` per step), and the process exits non-zero when any message did not fully downgrade. `unstar-scan-run` builds its alert text only from those rows.
- **There are no `*unstar-scan*.log` files under `data/logs/`.** Earlier ones were hand-written narration, not telemetry. The real records are `data/p1-resolutions.jsonl` and `agent/logs/p1-resolution-scan.log`.

## Reply sweep (Signal D — the user replied; no agent turn)

A user requirement: replying to a P1 email closes it and its task. `bin/p1-reply-sweep` runs as **code** at the top of `trigger-p1-resolution-scan.sh`, every 30 min, before the unstar sweep. It lists live P1 threads (`label:p1 is:starred newer_than:30d`, REST `threads.list`), fetches only the threads whose `historyId` moved since the last tick (state: `data/p1-reply-sweep-seen.json`), and applies one structural rule from `lib/p1-reply.js`: **if the newest non-draft message in the thread carries Gmail's `SENT` label, every starred `p1` message older than it is resolved.** Each is handed to `p1-downgrade <id> --source reply`, which unlabels/unstars as usual and closes the linked Google Task.

What that rule means in practice:
- The user's reply from Gmail, or a `gmail-action send --from <owner address>` on their behalf, resolves the P1. A saved draft does not.
- An inbound that lands *after* the reply keeps the thread live (newest message is not SENT) — and intake's `reply-to-me` has already re-stamped that inbound `p1` + star, so the task the new answer needs is created by normal triage.
- The agent's own `email-send` replies go out over its own relay, never `SENT`, so they never count as the user replying.
- The sweep is silent: no phone ping. A failed downgrade leaves that thread's watermark unadvanced, so it is retried next tick. Kill switch: `data/.p1-reply-sweep-off`.

You (the agent) never run this sweep and never reimplement it in a turn. If you are asked whether a P1 was closed by the user's reply, read `data/p1-resolutions.jsonl` for rows with `source: "reply"`.

## Contract with `p1-downgrade`

The binary at `bin/p1-downgrade` is the only thing that should mutate P1 → P3 state. Never hand-apply `gmail-action unlabel p1` without going through the binary — the JSONL audit log at `data/p1-resolutions.jsonl` is what lets us review false resolutions later.

**It also closes the P1's Google Task:** after the label steps it calls `lib/p1-task.js` `closeTasksFor`, which marks completed the open task whose notes carry `[jori-p1 thread:<threadId> msg:<messageId>]` (stamped by `p1-task add` at triage time) — or, for tasks without a marker, the single clear subject match; ambiguous or absent matches close nothing and are reported. The outcome lands in the audit row's `task` field and never affects `success` (which is Gmail state only). `--keep-task` skips the task step. Never `gog tasks done` a P1 task by hand in this job — go through the downgrade so the audit row records it.

- **The alert on this job was the remaining defect, not the network path.** Several retry-shaped fixes each fixed a real adjacent bug and none stopped the alerts — the signature of a mis-framed problem rather than a stubborn one. Failed batches were all-or-nothing (a per-request blip produces mixed batches), and the sweep was self-correcting: the unstarred-P1 backlog drained *while* the alerts fired. So each alert reported something real, transient, already recovering and not actionable by the user — `severity: noise`. Fixed by routing every failure through `bin/p1-alert-gate` (regression guard: `tests/p1-alert-gate.test.mjs`), which pages only when the sweep has been blocked across several runs and 45+ minutes, once per streak. This sits *on top of* `bin/system-alert-dedup`, which collapses intra-day repeats but only sees message text; the streak file is what tells "failed once, recovered next cycle" from "genuinely stuck".
