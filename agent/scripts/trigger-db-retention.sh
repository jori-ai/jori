#!/bin/bash
# Daily light retention: prune location_history + health_samples to the last 30
# days. Direct local script — no webhook, no agent, no Anthropic API. See
# bin/db-retention. Kill switch: data/.db-retention-off.
source "$(dirname "$0")/lib/root.sh"
[ -n "$JORI_NODE" ] && export PATH="$(dirname "$JORI_NODE"):$PATH"
exec "$JORI_INSTALL_TOOLS/bin/db-retention" --days 30
