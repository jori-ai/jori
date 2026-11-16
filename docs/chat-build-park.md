# Chat build: ask and park

A chat build (`agent/ops-agent/jobs/chat-build.md`) that needs one answer only the user can give **stops, keeps its session, asks on a card, and resumes the same session with the answer**. This is the "deferred tool call" pattern for an always-on agent, built from pieces Jori already had: the build queue, decision-style cards, and the fork runner's `--resume`.

Before this, a build with a question built nothing and asked in its report. The user's reply then started a fresh build that re-read everything from scratch and could read the request differently.

## Flow

1. **Ask.** Inside the run, the build calls `bin/build-park ask --id "$JORI_CHAT_BUILD_REQUEST" --question … --option … [--recommended i] [--context …]` and ends its turn. This writes `data/build-queue/asks/<id>.json`.
   - The ask is checked exactly as the card will be built (2–4 distinct options), so a bad one fails inside the run.
   - A build may ask at most 3 times.
2. **Park.** `agent/scripts/trigger-chat-build.sh` gives every run `JORI_FORK_SESSION_OUT=asks/<id>.session`. After a clean run that left an ask, it calls `build-park park`:
   - The request moves from `running/` to `parked/<id>.json`, together with its session id and question.
   - A card goes to chat with `choices.kind = "build-park"` and `choices.ref = <id>`. It expires after 5 days.
   - A card held by question-hold still parks; the hold re-sends it with the same choices.
   - If the build can't be parked (no session id, or the card failed), the question goes out as the report, as before.
3. **Answer.**
   - A tap is filed in code: the `build-park` handler in `lib/choice-reply.mjs` runs `build-park answer --id <id> --option <label>`, an exact match on our own labels.
   - A typed reply reaches the chat agent with a `[Build question <id>]` hint (phone-channel `decisionReplyHint`). The agent files `build-park answer --id <id> --text "<their words>"` (`agent/chat-agent/CLAUDE.md`).
   - Either way the request goes back to `pending/<id>.json` with `resume: {session_id, question, answer, answer_kind, round}`, and launchd (`QueueDirectories`) starts the trigger.
4. **Resume.** The trigger runs `run-ephemeral-opus.sh` with `JORI_FORK_RESUME=<session_id>` and `JORI_FORK_TASK_ONLY=1`.
   - The new message is the answer plus an instruction to re-check what moved while it waited (`build-park resume-task`). The playbook is not re-sent, because the session already has it.
   - The request is back in `running/` with `source: "chat"`, and `JORI_CHAT_BUILD_REQUEST` is set, so a locked-file card still works.
   - The allowance governor decides again, as for any queued build.

## Limits and staleness

- **Older than 5 days:** a parked build answered after that restarts **fresh**, with the request plus the question and answer, since its session may be gone and the tree has moved.
- **Unanswered for 30 days:** swept to `failed/` at the next trigger run.
- **Same working directory:** a resumed session must run in the cwd it started in. Both runs use the runner's default, `agent/ops-agent`. Claude Code keeps transcripts for `cleanupPeriodDays` (default 30 days), which is well past the 5-day window.
- **Clean tree:** the build leaves the tree clean before parking (Critical rule 5), because other builds run while it waits.
- **Rule #0b:** nothing reads what the user meant. A tap is our own label; a typed answer is passed to the build as the user's words.

## Files

- `lib/build-park.mjs` (logic) and `bin/build-park` (CLI: `ask`, `park`, `answer`, `resume-task`, `sweep`, `list`)
- `agent/scripts/trigger-chat-build.sh` (park and resume)
- `agent/scripts/lib/run-ephemeral-opus.sh` (`JORI_FORK_TASK_ONLY`)
- `lib/choice-reply.mjs` (tap handler) and `agent/phone-channel/index.mjs` (typed-reply hint)
- Test: `tests/build-park.test.mjs`
