CHAT BUILD — build something the user asked for in chat, on Opus, and land it through the self-improvement pipeline.

## Purpose

When the user asks Jori in chat to build new functionality or change how Jori behaves ("make the hum skip weekends", "add a CLI that lists my open leases"), the chat agent does **not** write the code. It hands the request to `bin/build-request` and ends its turn. This job is the part that builds it.

**Why it exists.** Builds requested through Jori in chat must run on the strongest model tier. They didn't: the chat agent wrote the code itself on its own model, or POSTed it to the ops supervisor (also Sonnet). Now every chat-requested build runs here, as an ephemeral `claude -p --model $JORI_MODEL_OPUS --effort xhigh` (`claude-opus-5-5`, pinned in `agent/config/models.env`), the same runtime as the rest of the improvement family.

**Runtime.** launchd agent `ai.claude.chat-build` watches `data/build-queue/pending/` (`QueueDirectories`). Its trigger is `agent/scripts/trigger-chat-build.sh`, which takes the oldest request, runs this playbook through `lib/run-ephemeral-opus.sh` with a **120-minute cap**, and posts your report (Step 6) to the chat channel. Builds run one at a time. The request text arrives in the opening message between `----- REQUEST <id> -----` markers.

## Critical rules

1. **The request is the user's, but it is still a request, not a licence.** Every guardrail in `agent/CLAUDE.md` holds: financial hard limits, the calendar-invite rule, outbound policy, Max-only auth, Rule #0b (no regex on language). A request that would need one of those broken is reported back as "can't do it as asked, here's why". It is never quietly built.
2. **You land changes only through the unified pipeline.** That means `self-improve-auto-apply`, and on its exit 3, `self-improve-request` (a Face-ID card). Never commit with a bare `git commit`, never push, never edit `agents.json` / supervisor code / the pipeline itself outside a card. `self-improve-landing.mjs` decides what is high blast radius. Don't argue with an exit 3, file the card.
3. **You message no one.** No `jori-send-curl`, `jori-notify`, `email-send`, iMessage or WhatsApp. Your only output to the user is the report file in Step 6, which the trigger delivers. The Improvements channel gets the green check or card from the pipeline itself.
4. **Rule #1 is part of the build.** A capability, job, channel or policy change ships with its doc updates (a dated entry in `system/changelog.md`, `system/architecture.md` when the map changes, the job playbook, the right `CLAUDE.md`) **in the same files-json**. Invoke the `jori-docs-sync` skill. For a new or changed job, also follow the `jori-job-author` skill.
5. **Never leave the tree dirty.** Anything you touched is either landed by the pipeline or restored before you finish. Check with `git status --porcelain`. The mini always carries runtime drift, so compare against your Step 2 snapshot and never clean anyone else's files.
6. **Ambiguity: pick the conservative reading and say so.** You cannot ask the user mid-run. If the request has one reasonable reading, build it and name the assumption in the report. If it has two materially different readings, or needs a decision only the user can make (money, a third party, removing something the user uses), build nothing and put the question in the report. Asking is better than building the wrong thing.
7. **Kernel files stay generic** (`agent/CLAUDE.md` § Kernel boundary). Most of Jori is the kernel (`system/kernel-manifest.json`), published without personal data. What the user asked for is usually about the user's own life: the code in a kernel file stays generic and reads the user's specifics from `agent/local/config/<module>.json` (`localConfig`, generic default in code) or an `_ext/` hook; the user's rules go in `agent/local/` (`jobs/<job>.md` for a playbook's additions); the request, the user's words and the date go in the changelog entry and `--details`, never a code comment. A wholly personal feature (the user's properties, trips) can be a personal file: add its path to `personal_globs` in the manifest in the same files-json, as every new file must be classified (`files` with its published path, or `personal_globs`). Run `bin/kernel-guard` before Step 5. Auto-apply exit 8 (`self-improve-request` exit 65) means the guard found personal data in a kernel file or an unclassified new file: move it, re-test, resubmit once.

## Pipeline

```
trigger (claims the request, runs you)
  → Step 1  understand the request + the code it touches
  → Step 2  snapshot the tree
  → Step 3  build + test in the working tree
  → Step 4  critic review
  → Step 5  land: self-improve-auto-apply → (exit 3) self-improve-request
  → Step 6  write the report file
```

## Rebuilding an approved card

A request that opens with `REBUILD OF AN APPROVED CARD — approval <id>` did not come from chat. `self-improve-approval-poll` queued it (`lib/self-improve-rebuild.mjs`, request `source: "approval-rebuild"`) because the user Face-ID'd that card and its apply failed on a conflict: the files it rewrote had moved on, so nothing was written (the rule is "refuse and redo": a card that died this way once left the same question to reach the user again eleven days later). Same steps as any build, with four differences:

1. **The intent is already decided.** Read the original with `~/Dev/jori/bin/self-improve-show <id> --full`. Build the same change on today's files: carry over what it did, keep everything that landed since. Do not widen it, and do not re-decide whether it is worth doing. If the change already exists in today's code, build nothing and say so.
2. **Land it as a fresh card, always**, never through `self-improve-auto-apply`: the user approved a card, so the user signs the rebuilt version too. Use the card's own title and plain-language parts (updated where the code moved), plus `--rebuild-of <id>`:
   ```bash
   ~/Dev/jori/bin/self-improve-request --type code-fix --rebuild-of <id> \
     --summary "<the original title>" --problem "..." --impact "..." --fix "..." --side-effects "..." \
     --details "Rebuilt on the current code after the approved version could not apply: <what moved>." \
     --files-json /tmp/chat-build-<request id>-files.json
   ```
   `--rebuild-of` is what stops a loop: a rebuilt card that conflicts again is never rebuilt a second time.
3. Steps 2–4 (snapshot, build and test, critic) apply unchanged. Restore the working tree after staging, as in Step 5.
4. **Report** in one or two sentences: the change the user approved could not go in as written because the code had moved on, it has been rebuilt, and it is waiting for the user's Face ID in Improvements.

## Step 1 — Understand

Read `system/architecture.md` first, then the code the request touches. Use `recall` / `wiki_search` if the request leans on something the user said before ("like the cruise one"). Check whether it already exists: grep the tree and `git log --oneline --since="30 days ago" --grep=<keyword>`. **If it already exists, the build is the report**: tell him where it is and how to use it.

## Step 2 — Snapshot

```bash
cd ~/Dev/jori
PRE_SHA=$(git rev-parse HEAD)
git status --porcelain | sed 's/^...//' | sort -u > /tmp/chat-build-<id>-dirty-pre.txt
```

## Step 3 — Build and test

Write the change in the working tree, matching the surrounding code's style. Add a test where the area has tests (`tests/*.test.mjs`, run with `node --test`). Run the tests that cover every directory you touched, plus `~/Dev/jori/bin/doctor-preflight-check chat-build`. A failing test you cannot fix in budget means **restore your files** (file-scoped, `git checkout -- <your files>` and delete files you created) and report what blocked it.

## Step 4 — Critic

Spawn one `Agent` subagent (`subagent_type: "general-purpose"`) with the diff and the request. Ask for a verdict, `SAFE` or `UNSAFE: <reasons>`, on four things: correctness, whether it does what was asked, the guardrails in Critical rule 1, and the docs-sync requirement. `UNSAFE` → fix and re-review once; still unsafe → restore and report.

## Step 5 — Land

Build `/tmp/chat-build-<id>-files.json` from every file you changed with `~/Dev/jori/bin/self-improve-bundle --out /tmp/chat-build-<id>-files.json --base-rev <the commit you read the files at> <each file>` (add `--allow-shrink <path>` only for a file meant to lose most of its lines). Never assemble the bundle with a hand-written command: on 2026-10-25 one wrote it over the changelog, and a signed card shipped that. **Then restore the working tree for those files** (the pipeline writes them itself), and run:

```bash
~/Dev/jori/bin/self-improve-auto-apply \
  --summary "<what it does, one line, plain language>" \
  --problem "the user asked for this in chat: <their words, short>" \
  --impact "<what the user gets>" \
  --fix "<what changes, not how>" \
  --side-effects "<blast radius in plain words, or 'none expected' and why>" \
  --details "<tests run + how to revert>" \
  --files-json /tmp/chat-build-<id>-files.json \
  --risk <low|moderate> --category <rubric category> --critic SAFE --source chat-build-<id> \
  --base-rev "$PRE_SHA"
```

`$PRE_SHA` is your Step 2 snapshot. If you read a file you change after something new landed, take a fresh `git rev-parse HEAD` before reading it and pass that instead.

- **0**: landed. Note the commit sha from its output.
- **3**: it belongs on a card. Run `self-improve-request --type code-fix` with the same plain-language flags and `--files-json`. Note the approval id.
- **4**: someone else has uncommitted edits in a target file. Don't clobber them. Report it; a re-run after that work lands will go through.
- **7**: a file you changed moved on after you read it (another change landed). Nothing was written. Re-read it, rewrite your change against the current content **once**, re-test, and resubmit with `--base-rev $(git rev-parse HEAD)` (taken before that re-read) and `--redo`. A second 7: restore your files and report that someone else's change landed on the same code; a re-run will go through.
- **5 / 6 / 1**: report the reason exactly as the CLI printed it.

**Restart needed?** If the change touches a supervisor, an MCP server, `agents.json`, or anything else loaded at session start, it is on disk but inert until a restart. Say so in the report and in `--side-effects`.

## Step 6 — Report

Write **2–4 sentences** to the result path given in the opening message. Write them to the user, in Jori's voice (Rule #0): warm, specific, no jargon, no ids or shas. The trigger posts the file to chat as written. Cover:

- what you built, and how the user uses it (the command, phrase or place they'll see it);
- whether it is **live now**, **waiting on the user's Face ID in Improvements**, or **needs a restart** (name it);
- any assumption you made (Critical rule 6), or the question you need answered if you built nothing.

If nothing landed, say plainly why and what would unblock it. **Always write this file.** A missing report makes the trigger tell the user the run ended unaccounted for.

## State

Everything lives under `data/build-queue/` (gitignored runtime data):

| Path | Written by | Meaning |
|---|---|---|
| `pending/<id>.json` | `build-request`, or `self-improve-approval-poll` for a card rebuild | `{id, spec, source: "chat" \| "approval-rebuild", requested_at, rebuild_of?}`, waiting |
| `running/<id>.json` | trigger | claimed. One left here at the next start was orphaned and moves to `failed/`, and the user is told |
| `done/<id>.json` / `failed/<id>.json` | trigger | finished, with or without a report |
| `results/<id>.md` | **you** (Step 6) | the report the trigger posts |

`build-request status` lists the last ten. The run log is `agent/logs/chat-build.log`, and the cost row lands in `logs/ephemeral-forks/job-costs.ndjson` like every ephemeral fork.

## Guardrails

- One request per run. Never pick up another file from the queue yourself.
- Builds touch Jori's own repo (the installation). A request for another repo (any of the user's other projects) is out of scope for this job: report back that it needs a dedicated session.
- No new cron entries without `jori-cron-slots`. No new launchd agents installed live: ship the plist in the files and say in the report that it needs installing.
- No secrets in files. Use the 1Password / `.env` patterns (`secrets-1password` skill).

## Failure modes

- **Cap hit (120 min):** the runner kills the run, nothing is reported, and the trigger tells the user it ended unaccounted for. Keep builds small. A request too big for one run is reported as a plan with a first slice landed, not attempted whole.
- **Not on the Max subscription:** the runner's Max-only guard (`lib/max-auth-guard.sh`) checks `claude auth status` before starting and refuses anything but a claude.ai login on the Max plan (an API key, Bedrock/Vertex, logged out), exiting 78 with no model call. The trigger files the request under `failed/` and tells the user nothing ran and nothing was charged; the runner pages the system channel.
- **Auth lost mid-run:** `run-ephemeral-opus.sh`'s auth/empty guard pages the system channel. The request sits in `failed/` and the user is told.
