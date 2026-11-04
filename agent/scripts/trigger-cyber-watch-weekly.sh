#!/bin/bash
# cyber-watch (weekly lane) — scripted job: bin/cyber-watch-run --lane weekly
# via launchd (GUI session, Max auth for its one model call).
# Playbook: ops-agent/jobs/cyber-watch.md
source "$(dirname "$0")/lib/launchd-kick.sh"
launchd_kick ai.claude.cyber-watch-weekly cyber-watch-weekly
