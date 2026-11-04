#!/usr/bin/env bash
set -euo pipefail

# Cron (4×/day) → the GUI session: bin/message-digest summarizes the
# day's iMessage / WhatsApp / Slack conversations with a tool-less claude -p
# on Max, which cron cannot reach (it replaces realtime message pings).
source "$(dirname "$0")/lib/launchd-kick.sh"
launchd_kick ai.claude.message-digest message-digest
