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
TIMEOUT_MIN=120

mkdir -p "$Q/pending" "$Q/running" "$Q/done" "$Q/failed" "$Q/results" "$(dirname "$LOG")"
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

REQ="$(ls -1 "$Q/pending"/*.json 2>/dev/null | sort | head -n1)"
[ -n "$REQ" ] || exit 0
ID="$(basename "$REQ" .json)"
mv "$REQ" "$Q/running/$ID.json" || { log "$ID: could not claim request"; exit 1; }

SPEC="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).spec||""))' "$Q/running/$ID.json" 2>/dev/null)"
if [ -z "$SPEC" ]; then
  mv "$Q/running/$ID.json" "$Q/failed/$ID.json"
  log "$ID: unreadable request — moved to failed/"
  exit 0
fi

RESULT="$Q/results/$ID.md"
rm -f "$RESULT"
log "$ID: start"

TASK="Run the CHAT BUILD job for request $ID. The user asked for this in chat; the request, verbatim, is between the markers.
Write your report to $RESULT (Step 6). ultrathink.

----- REQUEST $ID -----
$SPEC
----- END REQUEST -----"

"$SCRIPTS/lib/run-ephemeral-opus.sh" chat-build "$JOB_MD" --task "$TASK" --timeout-min "$TIMEOUT_MIN"
RC=$?
log "$ID: runner exit $RC"

if [ "$RC" -eq 78 ]; then
  # The runner's Max-only guard refused to start (lib/max-auth-guard.sh), so no
  # model call was made. Filed as failed, not re-queued: the refusal repeats
  # until someone signs in, and QueueDirectories would relaunch it forever.
  mv "$Q/running/$ID.json" "$Q/failed/$ID.json"
  "$SEND" "${REPORT[@]}" "🛠️ I didn't start the build you asked for ($(label "$Q/failed/$ID.json")). Claude Code on $HOST wasn't signed in to your Max plan, and builds only run on that — so nothing ran and nothing was charged. Once it's signed back in, ask me again and I'll pick it up." >> "$LOG" 2>&1 || true
elif [ -s "$RESULT" ]; then
  mv "$Q/running/$ID.json" "$Q/done/$ID.json"
  "$SEND" "${REPORT[@]}" "🛠️ $(head -c 1500 "$RESULT")" >> "$LOG" 2>&1 || true
else
  mv "$Q/running/$ID.json" "$Q/failed/$ID.json"
  "$SEND" "${REPORT[@]}" "🛠️ The build you asked for ($(label "$Q/failed/$ID.json")) stopped without telling me how it went, so I can't vouch that anything landed — anything that did will be in Improvements. I've kept the details in chat-build.log if you want me to dig in." >> "$LOG" 2>&1 || true
fi
exit 0
