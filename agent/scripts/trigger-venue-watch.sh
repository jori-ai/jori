#!/bin/bash
# trigger-venue-watch.sh <lane> — run one venue-watch lane from a cron line.
#
# `bin/venue-watch <lane>` makes one tool-less model call on the Max
# subscription, which only the GUI session can authenticate, so cron hands the
# run to the lane's on-demand launchd agent `ai.claude.venue-watch-<lane>`
# (lib/launchd-kick.sh). The lanes, and so their agents, are this
# installation's (agent/local/config/venue-watch.json); a lane that is not
# configured runs nothing. A task schedules a lane with
# trigger_script agent/scripts/trigger-venue-watch.sh and trigger_args <lane>.
#
# A lane that only reads dates the travel timeline puts the user in its metro
# runs while the user is away too: venue-watch gates every pick per date.
lane="${1:-}"
if [ -z "$lane" ] || [[ "$lane" == -* ]]; then
  echo "usage: trigger-venue-watch.sh <lane>" >&2
  exit 2
fi
source "$(dirname "$0")/lib/launchd-kick.sh"
launchd_kick "ai.claude.venue-watch-$lane" "$lane"
