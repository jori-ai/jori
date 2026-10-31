#!/bin/bash
# check-meetings.sh — the morning check of every recurring meeting (lib/meetings.mjs):
# runs bin/meeting-calendar-check directly, no agent dispatch. It finds today's
# call of each meeting on the calendar and refreshes its state file and reminder
# lines (bin/meeting-update). No meeting configured: it says so and exits 0.
# Output: data/logs/meeting-calendar.log.
source "$(dirname "$0")/lib/script-job-env.sh"
run_script_job meeting-calendar "$JORI_INSTALL_TOOLS/bin/meeting-calendar-check" "$@"
exit 0
