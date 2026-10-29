#!/bin/bash
# trigger-runner-update.sh — weekly cron entry for bin/runner-update
# (in-place update of the self-hosted Actions runners; no agent dispatch).
source "$(dirname "$0")/lib/root.sh"
exec "$JORI_INSTALL_TOOLS/bin/runner-update" >> "$JORI_INSTALL_TOOLS/agent/logs/runner-update.log" 2>&1
