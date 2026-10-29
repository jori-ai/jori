#!/bin/bash
# Run local-embedding backfill on the chat messages table. Cron-friendly:
#   */15 * * * * <install>/agent/scripts/trigger-embed-messages.sh
#
# Embeds any new rows (embedding IS NULL) using the local Ollama
# nomic-embed-text model. No Anthropic API calls. Silent exit when Ollama
# is unreachable — the watchdog already alerts on Ollama down; this script
# will catch up on the next tick after recovery.

source "$(dirname "$0")/lib/root.sh"
[ -n "$JORI_NODE" ] && export PATH="$(dirname "$JORI_NODE"):$PATH"
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/embed-messages.log"

if ! curl -sf --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [embed-messages] ollama down, skipping" >> "$LOGFILE"
  exit 0
fi

"${JORI_NODE:-node}" "$JORI_INSTALL_TOOLS/bin/embed-messages" --batch 200 >> "$LOGFILE" 2>&1
