#!/bin/bash
# festival-watch — bin/festival-watch-run via launchd (GUI session: its one
# capped web-search call runs on the Max subscription). Off unless
# agent/local/config/festival-watch.json enables it (the run checks).
source "$(dirname "$0")/lib/launchd-kick.sh"
launchd_kick ai.claude.festival-watch festival-watch
