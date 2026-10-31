#!/usr/bin/env bash
set -euo pipefail

# Monthly re-fit of the spa heating formula.
#
# The spa's ETA is quoted from a flat minutes-per-°F fallback, because nothing
# had measured the real rate. The real answer depends on the water/air
# temperature gap, so it can only come from accumulated sessions. This job
# re-fits that relationship as the dataset grows and reports where the
# estimate currently stands.
#
# LLM job: it interprets a small dataset and writes a short analysis. The
# collection is entirely deterministic (spa-heating-sync, daily).

source "$(dirname "$0")/lib/root.sh"

# Nothing to fit before there are sessions (and none at all without a spa
# configured: --count prints 0). Silent-on-empty rather than emailing "not
# enough data yet" every month for the first few months.
SESSIONS=$("${JORI_NODE:-node}" "$JORI_INSTALL_TOOLS/bin/spa-heating-model-data" --count 2>/dev/null || echo 0)
if [ "${SESSIONS:-0}" -lt 3 ]; then
  exit 0
fi

source "$(dirname "$0")/lib/webhook-auth.sh"
dispatch_or_skip '{"task": "SPA HEATING MODEL", "source": "cron-spa-heating-model"}' spa-heating-model || true
