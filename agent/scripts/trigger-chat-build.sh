#!/bin/bash
# trigger-chat-build.sh — run ONE queued chat build request on ephemeral Opus.
#
# Launched by launchd (ai.claude.chat-build), whose QueueDirectories key is
# data/build-queue/pending: launchd starts this whenever that directory is
# non-empty, and keeps restarting it until it is empty. So each run takes the
# OLDEST pending request, moves it OUT of pending before doing anything slow (a
# request left in pending would relaunch forever), runs it, and files it under
# done/ or failed/. launchd never runs two instances of one label, so builds are
# serial by construction.
#
# The request is written by bin/build-request (the chat agent calls it).
# The agent runs jobs/chat-build.md and writes a short report to
# build-queue/results/<id>.md; this script posts that report to the chat channel,
# or a plain "it ended without a report" if there is none. The agent itself never
# messages anyone.
#
# Not cron: a cron-launched `claude -p` cannot unlock the Max keychain (see
# lib/run-ephemeral-opus.sh).

export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:$PATH"

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPTS/lib/root.sh"       # JORI_INSTALL, JORI_INSTALL_TOOLS
source "$SCRIPTS/lib/instance.sh"   # JORI_HOST_LABEL
HOST="${JORI_HOST_LABEL:-the host}"
Q="$JORI_INSTALL/data/build-queue"
JOB_MD="$JORI_INSTALL_TOOLS/agent/ops-agent/jobs/chat-build.md"
LOG="$JORI_INSTALL_TOOLS/agent/logs/chat-build.log"
SEND="$JORI_INSTALL_TOOLS/bin/jori-send-curl"
# Every message below answers a build the user asked for in chat. The intent tells
# outbound-precheck so (a report on a change the user asked for is the answer they are
# waiting for, not Jori narrating its own plumbing), and the report is written
# by the run itself about work it just did, so its claims are live, not stale.
REPORT=(--agent ops --channel chat --intent chat-build-result --evidence-as-of live)
# A build's question is never held by the speak gate (lib/speak-gate-live.mjs NEVER_HELD_INTENTS).
QUESTION=(--agent ops --channel chat --intent chat-build-question --evidence-as-of live)
TIMEOUT_MIN=120

mkdir -p "$Q/pending" "$Q/held" "$Q/running" "$Q/done" "$Q/failed" "$Q/results" "$Q/asks" "$Q/parked" "$(dirname "$LOG")"
PARK="$JORI_INSTALL_TOOLS/bin/build-park"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [chat-build] $1" >> "$LOG"; }
# A few words of the request, so a message names the build the way the user asked for it.
label() { node -e 'try{const s=String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).spec).replace(/\s+/g," ").trim();process.stdout.write(s.length>70?s.slice(0,70)+"…":s)}catch{process.stdout.write("a request")}' "$1" 2>/dev/null; }

# A request still in running/ when a new run starts was orphaned by a reboot or a
# kill (launchd runs one instance at a time, so nothing else can own it).
for f in "$Q/running"/*.json; do
  [ -e "$f" ] || continue
  id="$(basename "$f" .json)"
  mv "$f" "$Q/failed/$id.json"
  log "$id: orphaned in running/ — moved to failed/"
  "$SEND" "${REPORT[@]}" "🛠️ The build you asked for ($(label "$Q/failed/$id.json")) got cut off before it finished — $HOST restarted or the run was killed. Nothing from it landed unless you see it in Improvements. Just say the word and I'll start it again." >> "$LOG" 2>&1 || true
done

# Parked builds nobody answered for a month go to failed/ (lib/build-park.mjs).
node "$PARK" sweep >> "$LOG" 2>&1 || true

# A request the allowance governor held (held/) goes first: it is older than
# anything in pending/, and its release (the user's answer, or the weekly reset)
# kickstarts this agent without touching pending/.
REQ="$(ls -1 "$Q/held"/*.json 2>/dev/null | sort | head -n1)"
[ -n "$REQ" ] || REQ="$(ls -1 "$Q/pending"/*.json 2>/dev/null | sort | head -n1)"
[ -n "$REQ" ] || exit 0
ID="$(basename "$REQ" .json)"

# The allowance governor (bin/allowance-brake via lib/allowance-gate.sh),
# decided HERE, before the claim: a build is important, so while the week is on
# pace to run out the user is asked on a decision card (run now, run cheaper,
# wait for the reset) and the request waits in held/. Every pending request
# moves there too: launchd relaunches this agent while pending/ is non-empty,
# and each relaunch would only hold again.
source "$SCRIPTS/lib/allowance-gate.sh"
allowance_gate chat-build "$ID"
if [ "$BRAKE_RC" -eq 3 ]; then
  for f in "$Q/pending"/*.json; do [ -e "$f" ] && mv "$f" "$Q/held/"; done
  log "$ID: held by the allowance governor: $BRAKE_REASON"
  exit 0
fi
# Size, the chat agent's judgment when it queued the request (bin/build-request
# --size): a small, contained change builds on Sonnet at high effort, anything
# else on Opus at xhigh (the runner's default). A request with no size is large.
SIZE="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).size||"large"))}catch{process.stdout.write("large")}' "$REQ" 2>/dev/null)"
RUN_ARGS=()
THINK="ultrathink."
if [ "$SIZE" = "small" ]; then
  [ -f "$JORI_INSTALL_TOOLS/agent/config/models.env" ] && source "$JORI_INSTALL_TOOLS/agent/config/models.env"
  [ -n "${JORI_MODEL_SONNET:-}" ] && RUN_ARGS=(--model "$JORI_MODEL_SONNET" --effort high)
  THINK=""
fi
if [ "$BRAKE_RC" -eq 4 ]; then
  RUN_ARGS=(--model "$BRAKE_MODEL" ${BRAKE_EFFORT:+--effort "$BRAKE_EFFORT"})
  log "$ID: cheaper model for this build ($BRAKE_MODEL${BRAKE_EFFORT:+, $BRAKE_EFFORT}): $BRAKE_REASON"
fi
export JORI_BRAKE_DECIDED=1

mv "$REQ" "$Q/running/$ID.json" || { log "$ID: could not claim request"; exit 1; }

SPEC="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).spec||""))' "$Q/running/$ID.json" 2>/dev/null)"
if [ -z "$SPEC" ]; then
  mv "$Q/running/$ID.json" "$Q/failed/$ID.json"
  log "$ID: unreadable request — moved to failed/"
  exit 0
fi

# A build in another of the user's repositories (build-request --repo): the run
# starts inside that checkout, so its own CLAUDE.md is loaded, and the playbook's
# § Another repository applies. build-request checked the path when it queued it;
# a checkout that has since gone fails the build here, before any model runs.
REPO="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).repo||""))}catch{}' "$Q/running/$ID.json" 2>/dev/null)"
RECORD="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).record||""))}catch{}' "$Q/running/$ID.json" 2>/dev/null)"
TARGET=""
if [ -n "$REPO" ]; then
  if [ ! -d "$REPO/.git" ] && ! git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    mv "$Q/running/$ID.json" "$Q/failed/$ID.json"
    log "$ID: repository $REPO is gone — moved to failed/"
    "$SEND" "${REPORT[@]}" "🛠️ I couldn't start the change you asked for ($(label "$Q/failed/$ID.json")): its repository ($REPO) isn't on $HOST anymore." >> "$LOG" 2>&1 || true
    exit 0
  fi
  RUN_ARGS+=(--cwd "$REPO")
  TARGET="
Target: another of the user's repositories, $REPO (playbook § Another repository).${RECORD:+ The earlier work is work record $RECORD: read it first (\`work-record show $RECORD\`).}"
fi

RESULT="$Q/results/$ID.md"
rm -f "$RESULT" "$Q/asks/$ID.json"
# The run's session id, so a build that stops to ask (build-park ask) can be
# resumed in the same session when the user answers (lib/build-park.mjs).
SESSION_FILE="$Q/asks/$ID.session"
rm -f "$SESSION_FILE"
export JORI_FORK_SESSION_OUT="$SESSION_FILE"
RESUME_SID="$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).resume;process.stdout.write(r&&r.session_id?String(r.session_id):"")}catch{}' "$Q/running/$ID.json" 2>/dev/null)"

if [ -n "$RESUME_SID" ]; then
  # The user answered a parked build's question: the same session carries on,
  # with only the answer as its new message (the playbook is already in it).
  TASK="$(node "$PARK" resume-task --id "$ID" --result "$RESULT" 2>/dev/null)"
  export JORI_FORK_RESUME="$RESUME_SID" JORI_FORK_TASK_ONLY=1
  log "$ID: resume parked session (size $SIZE${RUN_ARGS[1]:+, ${RUN_ARGS[1]}})"
else
  unset JORI_FORK_RESUME JORI_FORK_TASK_ONLY
  log "$ID: start (size $SIZE${RUN_ARGS[1]:+, ${RUN_ARGS[1]}})"
  TASK="Run the CHAT BUILD job for request $ID. The user asked for this in chat; the request, verbatim, is between the markers.
Write your report to $RESULT (Step 6). Build size: $SIZE. $THINK$TARGET

----- REQUEST $ID -----
$SPEC
----- END REQUEST -----"
fi

# Which request this run is building, for self-improve-request: a change to a
# locked file (rubric schema v6) may be filed as a card only from the chat build
# the user asked for, and the CLI checks this id against running/<id>.json and
# its `source`. Set here and nowhere else: a pipeline job (improvement-plan, the
# executor, system-issue-review, skill-repair, the cost review) never has it.
export JORI_CHAT_BUILD_REQUEST="$ID"
"$SCRIPTS/lib/run-ephemeral-opus.sh" chat-build "$JOB_MD" --task "$TASK" --timeout-min "$TIMEOUT_MIN" ${RUN_ARGS[@]+"${RUN_ARGS[@]}"}
RC=$?
unset JORI_CHAT_BUILD_REQUEST JORI_FORK_RESUME JORI_FORK_TASK_ONLY JORI_FORK_SESSION_OUT
log "$ID: runner exit $RC"

# The build stopped to ask the user (build-park ask): park it with its session
# and send the card. If it cannot be parked (no session id, the card failed),
# the question goes out as the report, as before.
PARK_FALLBACK=""
# Parks on a clean exit, and also when the runner's empty-output guard
# returned 1 after an ask (a parked turn can end on very little text): the
# session id is written before that guard runs. Never after a Max refusal (78).
if [ -f "$Q/asks/$ID.json" ] && { [ "$RC" -eq 0 ] || { [ "$RC" -eq 1 ] && [ -s "$SESSION_FILE" ]; }; }; then
  if PARK_OUT="$(node "$PARK" park --id "$ID" --session-file "$SESSION_FILE" 2>> "$LOG")"; then
    log "$ID: parked on a question ($PARK_OUT)"
    rm -f "$SESSION_FILE"
    for f in "$Q/held"/*.json; do [ -e "$f" ] && mv "$f" "$Q/pending/"; done
    exit 0
  fi
  log "$ID: could not park ($PARK_OUT) — sending the question as the report"
  PARK_FALLBACK="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).question||""))}catch{}' "$Q/asks/$ID.json" 2>/dev/null)"
fi
rm -f "$SESSION_FILE" "$Q/asks/$ID.json"

if [ "$RC" -eq 78 ]; then
  # The runner's Max-only guard refused to start (lib/max-auth-guard.sh), so no
  # model call was made. Filed as failed, not re-queued: the refusal repeats
  # until someone signs in, and QueueDirectories would relaunch it forever.
  mv "$Q/running/$ID.json" "$Q/failed/$ID.json"
  "$SEND" "${REPORT[@]}" "🛠️ I didn't start the build you asked for ($(label "$Q/failed/$ID.json")). Claude Code on $HOST wasn't signed in to your Max plan, and builds only run on that — so nothing ran and nothing was charged. Once it's signed back in, ask me again and I'll pick it up." >> "$LOG" 2>&1 || true
elif [ -n "$PARK_FALLBACK" ] && [ ! -s "$RESULT" ]; then
  mv "$Q/running/$ID.json" "$Q/done/$ID.json"
  "$SEND" "${QUESTION[@]}" "🛠️ The build you asked for ($(label "$Q/done/$ID.json")) needs an answer from you before it can go on: $PARK_FALLBACK — tell me and I'll start it again with your answer." >> "$LOG" 2>&1 || true
elif [ -s "$RESULT" ]; then
  mv "$Q/running/$ID.json" "$Q/done/$ID.json"
  "$SEND" "${REPORT[@]}" "🛠️ $(head -c 1500 "$RESULT")" >> "$LOG" 2>&1 || true
else
  mv "$Q/running/$ID.json" "$Q/failed/$ID.json"
  "$SEND" "${REPORT[@]}" "🛠️ The build you asked for ($(label "$Q/failed/$ID.json")) stopped without telling me how it went, so I can't vouch that anything landed — anything that did will be in Improvements. I've kept the details in chat-build.log if you want me to dig in." >> "$LOG" 2>&1 || true
fi
# Anything still held waited behind this one: hand it back to pending/ so
# launchd starts the next run, which asks the governor again for it.
for f in "$Q/held"/*.json; do [ -e "$f" ] && mv "$f" "$Q/pending/"; done
exit 0
