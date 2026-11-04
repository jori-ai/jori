#!/bin/bash
# Spa heating telemetry: pull new ticks + session summaries from SpaServer
# into Supabase. Direct local script — no webhook, no agent, no Anthropic API
# (deterministic; cheap; safe on a daily cron). The monthly formula re-fit is
# the SEPARATE LLM-driven spa-heating-model job.
#
# READ-ONLY on the spa: spa-heating-sync only calls GET /heating-telemetry. It
# has no code path that starts, stops or otherwise touches the hardware.
# Without a spa configured (agent/local/config/spa.json server_url) the CLI
# logs "off" and exits 0.
#
# Wrapped in a trigger script rather than called straight from crontab so that
# jori-cron-slots audit can see it — the audit matches on `trigger-<name>.sh`
# and is blind to direct-CLI cron lines.
#
# Secrets: SPA_SERVER_API_KEY + SUPABASE_SERVICE_ROLE_KEY from .env
# (loaded by the CLI). Kill switch: data/.spa-heating-sync-off.
source "$(dirname "$0")/lib/root.sh"
LOGFILE="$JORI_INSTALL_TOOLS/data/logs/spa-heating-sync.log"
mkdir -p "$(dirname "$LOGFILE")"

if [ -f "$JORI_INSTALL_TOOLS/data/.spa-heating-sync-off" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [spa-heating-sync] kill switch present, skipping" >> "$LOGFILE"
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') [spa-heating-sync] start" >> "$LOGFILE"
"${JORI_NODE:-node}" "$JORI_INSTALL_TOOLS/bin/spa-heating-sync" >> "$LOGFILE" 2>&1
echo "$(date '+%Y-%m-%d %H:%M:%S') [spa-heating-sync] exit $?" >> "$LOGFILE"
