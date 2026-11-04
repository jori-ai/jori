#!/usr/bin/env bash
# places-budget — hourly Places API spend meter.
#
# Runs the check DIRECTLY rather than dispatching a task to the supervisor.
# The usual cron → webhook → agent → playbook path exists so a job can reason;
# this one cannot. It runs a fixed BigQuery query, compares two numbers to two
# constants, and notifies. Routing that through an agent would re-bill the
# whole context 24 times a day — the exact spend pattern the job exists to
# watch — and would go silent whenever the supervisor is wedged, which is
# precisely when a runaway is most likely to be underway.
set -euo pipefail

source "$(dirname "$0")/lib/root.sh"   # JORI_INSTALL_TOOLS
ROOT="$JORI_INSTALL_TOOLS"
LOCK="$ROOT/data/places-budget.lock"
LOG="$ROOT/data/logs/places-budget.log"

# cron gets a minimal PATH; bq, gcloud and node all live in Homebrew or the
# Cloud SDK. Without this every run dies on "bq: command not found".
export PATH="/opt/homebrew/bin:$HOME/google-cloud-sdk/bin:/usr/bin:/bin:$PATH"

mkdir -p "$(dirname "$LOG")"

# A bq query plus a gcloud call can outlast an hour if the network is bad, and
# two concurrent runs could both act on the same threshold crossing. Stale
# locks are cleared by checking the recorded pid rather than by age, so a long
# legitimate run is never interrupted.
if [[ -f "$LOCK" ]]; then
  if kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
    exit 0
  fi
  rm -f "$LOCK"
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

exec "$ROOT/bin/places-budget" check
