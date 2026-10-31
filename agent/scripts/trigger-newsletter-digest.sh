#!/bin/bash
# newsletter-digest — scripted since 2026-10-04: bin/newsletter-digest-run
# via launchd (GUI session, Max auth for its one summary call).
# Playbook: ops-agent/jobs/newsletter-digest.md
source "$(dirname "$0")/lib/launchd-kick.sh"
launchd_kick ai.claude.newsletter-digest newsletter-digest
