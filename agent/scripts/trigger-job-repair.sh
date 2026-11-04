#!/bin/bash
# trigger-job-repair.sh — dispatch the job-repair playbook when the queue has work.
#
# Kicked (detached) by bin/job-failure-watch the moment it queues a repair for
# a job that failed its last few runs, and by cron as a safety net. Dumb on
# purpose: the admission rules (streak, one open item per job, daily cap) were
# applied when the item was queued (lib/job-failures.mjs).

source "$(dirname "$0")/lib/webhook-auth.sh"
STATE_DIR="$JORI_INSTALL_TOOLS/data"
QUEUE="$STATE_DIR/job-repair-queue.json"
LOCK="$STATE_DIR/job-repair.lock"

[[ -f "$STATE_DIR/job-repair-pause.json" ]] && exit 0
[[ -f "$QUEUE" ]] || exit 0
PENDING=$("$JORI_NODE" -e 'const q=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((q.pending||[]).filter(p=>p.status==="pending").length)' "$QUEUE" 2>/dev/null || echo 0)
[[ "$PENDING" -gt 0 ]] || exit 0

# One dispatch at a time; the job drains the queue itself. A lock older than
# 2h belongs to a dead dispatch (job-failure-watch next re-releases its claim).
if [[ -f "$LOCK" ]] && [[ $(( $(date +%s) - $(stat -f %m "$LOCK") )) -lt 7200 ]]; then
  exit 0
fi
touch "$LOCK"

dispatch_or_skip '{"job": "job-repair"}' job-repair
