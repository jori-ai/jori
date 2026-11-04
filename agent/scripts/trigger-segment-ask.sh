#!/usr/bin/env bash
set -euo pipefail
# Cron (*/30) → launchd. segment-ask's evidence step (stop-passage →
# stop-evidence) falls back to `claude -p` on Max and looks at the user's photos with
# it; from cron that prints "Not logged in", so the job runs in the GUI session.
# The job itself, with its kill switch and quiet window: run-segment-ask.sh.
source "$(dirname "$0")/lib/launchd-kick.sh"
launchd_kick ai.claude.segment-ask segment-ask
