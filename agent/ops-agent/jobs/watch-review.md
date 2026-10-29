# watch-review — weekly: is the watch engine catching every reminder, and firing them well?

Weekly (cron → `agent/scripts/trigger-watch-review.sh` → ops-light). System design: `system/watch.md`.

## Purpose

Every request for a conditional or future event (a reminder) goes to the watch engine, and how well it works is tracked so it can be improved.

Two questions, every week:
1. **Coverage:** did every reminder or conditional request the user made become a watch?
2. **Quality:** did the watches decide right, fire on time, reach the user, and help?

Then fix what's broken and keep a trend line.

## Inputs (gathered by the trigger before you run)

Today's date is the newest `data/watch-review/<YYYY-MM-DD>-stats.json`.
- `<day>-stats.json`: `watch stats --days 7 --json`. It covers engine liveness, watches created (`created_by`), decisions (verdict and decider: `jev` or `legacy` = Sonnet), questions asked/answered, and firings. Firings include delivery `sent`/`suppressed` (the precheck held it back) plus reasons, lateness, never-delivered, the user's reactions and task completion. It also holds `feedback` (the user's words, via `watch feedback`), `misses` (`watch miss`), `corrections` (`watch confirm|reject`), `retired`, and `per_watch`.
- `<day>-chat.json`: every message the user sent in chat over the last 7 days (`{id, at, text}`).
- Live detail when needed: `watch list --all --json`, `watch show <id> --json`, `agent/logs/watch.log`, the Jev logs `data/jev-shadow/*.jsonl` (sites `watch-match`, `watch-answer`).

## Step 1 — Coverage audit

Read `<day>-chat.json` yourself. Find every message where the user asked for something to happen later or on a condition: "remind me…", "when X happens…", "let me know if/when…", "before I leave for…", "in two weeks…", "once the letter comes…". This is language, so read it; don't filter with patterns. A plain question or a request done on the spot is not one. For each request, find the watch that covers it (`watch list --all --json`: match on `request`, `title`, `condition`).
- **Covered:** note it.
- **Not covered and still in the future:** create the watch now (`system/watch.md` § Writing a watch; `--by watch-review --request "<the user's exact words>"`) and record it as a gap.
- **Not covered and already past:** a miss. `watch miss "<what>"`.
- **Covered some other way** (a one-shot cron line `crontab -l | grep cron-reminder`, a bare Google Task, a calendar block): count it as a coverage gap even if it worked, and name which path did it.

For every gap, find the cause: which agent or path handled the request, and why it didn't go to `watch` (missing rule, unclear wording in a CLAUDE.md, a playbook that still says cron).

## Step 2 — Quality review

From the stats, flag each of these that is non-empty:
- **Engine:** `tick_age_min` over 30, or a growing `retry_backlog`.
- **Never delivered** (`failed_never_delivered`) and **suppressed** reminders. A reminder the user asked for that the precheck held back is a failure unless the reason shows it was a true duplicate.
- **Late:** `late_over_60_min` that a quiet-hours hold doesn't explain (held 22:00→08:00 is by design).
- **Wrong fires:** `corrections` with `manual:rejected` after a firing, and feedback saying it was the wrong thing.
- **Misses:** `misses`, and any from Step 1.
- **Decisions:** `failed` decisions, and a high `legacy` share. Jev below threshold falls back to Sonnet, so that is a question-wording problem in `data/jev-questions/watch-match.json`. Also look at `ask` volume. Read the `watch-match` rows in `jev-shadow` for verdicts that look wrong given the candidate.
- **Usefulness:** reactions, task completion, and the user's feedback words. Note which watches the user clearly valued.

## Step 3 — Fix (at most 3 per run)

For each concrete, verified problem:
- **A single watch is mis-specified** (condition too loose or too tight, wrong offset): fix it with `watch add` (same id) and say so in the report.
- **Low/moderate-risk code, config or doc fix** (Jev question wording, a CLAUDE.md rule that missed a reminder path, an engine bug with a clear test): `self-improve-auto-apply`, with a test where code changes.
- **Anything touching outbound messaging, money, the calendar, or the supervisor:** `self-improve-request` (Face-ID card).
Never weaken the precheck or the awake window to make a number look better.
A fix to a kernel file (`system/kernel-manifest.json`: the watch engine, the agent `CLAUDE.md` files) stays generic — the watch, the request and the user's words go in `--details` and the changelog entry, not the code or rule text; the user's own reminder habits go in `agent/local/`. Run `bin/kernel-guard` before landing; auto-apply exit 8 means move the content and resubmit once (`agent/CLAUDE.md` § Kernel boundary).

## Step 4 — Record the trend

Append one line to `data/watch-review/history.jsonl`:

```json
{"day":"<day>","armed":N,"created":N,"requests_seen":N,"covered":N,"gaps":N,"misses":N,"fired":N,"sent":N,"suppressed":N,"never_delivered":N,"late_over_60":N,"wrong_fires":N,"decisions":N,"legacy_share":0.0,"questions":N,"answered":N,"positive_reactions":N,"tasks_completed":N,"fixes":["<one line each>"]}
```

Compare against the previous lines and say in the report whether things are getting better or worse.

## Step 5 — Deliver

- **Nothing happened this week** (no requests, no firings, no problems): silent. Write the history line and stop.
- **Otherwise:** one short HTML email via `digest-deliver` (§ Long-form delivery rule in `ops-agent/CLAUDE.md`), subject `Watches — week of <date>`. The scorecard sits at the top as four numbers: requests caught / total, reminders delivered / fired, wrong fires, misses. Then the gaps it created and why they happened, then problems and the fixes shipped or proposed, then the trend versus last week. The pointer line carries the single most important finding.

## Guardrails

- Creating a watch for a request the user clearly made is allowed (it's what the user asked for). Retiring, pausing or editing a watch's intent is not, unless the user's chat says so.
- Read-only on everything else except `watch` (create/fix), `watch miss`, the history file and the self-improve tools.
- Bank and health content in a reminder stays out of the email: name the watch, not the numbers.
- Never message the user outside the one delivery above.
