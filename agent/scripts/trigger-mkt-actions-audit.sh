#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
source "$(dirname "$0")/lib/root.sh"   # JORI_INSTALL_TOOLS
# Weekly (Sunday) — reconcile every OPEN action in data/mkt-actions-state.json against
# reality: auto-complete already-done, auto-retire dead-premise/duplicate, flag the rest.
# Silent on a clean run. Playbook: jobs/mkt-actions-audit.md.

# Kill switch
if [ -f "$JORI_INSTALL_TOOLS/data/mkt-actions-audit-pause.json" ]; then
  exit 0
fi

dispatch_or_skip '{"job": "mkt-actions-audit"}' mkt-actions-audit
