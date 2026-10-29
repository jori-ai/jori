#!/bin/bash
# Hourly: ask the user about an urgent message left unanswered for 24 hours
# (bin/message-followup, code only, no agent dispatch; 2026-10-28).
source "$(dirname "$0")/lib/script-job-env.sh"
run_script_job message-followup "$JORI_REPO/bin/message-followup"
exit 0
