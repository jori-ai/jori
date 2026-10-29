#!/bin/bash
# mkt-metrics-collect — PURE-CRON collector (NO agent dispatch).
#
# A silent, deterministic Search Console + App Store Connect metrics producer:
# it writes data/mkt-metrics-state.json and sends NO outbound comms, so there
# is nothing for an LLM agent to decide — cron runs the collector directly.
# The collector does its own credential checks, records last_run_ok, and exits
# 0 without config (agent/local/config/marketing.json). Staleness is surfaced
# by the marketing digest, never a ping.
# Playbook: agent/ops-agent/jobs/mkt-metrics-collect.md.
source "$(dirname "$0")/lib/script-job-env.sh"   # PATH (signed node), JORI_REPO
run_script_job mkt-metrics-collect "$JORI_REPO/bin/mkt-metrics-collect" "$@"
