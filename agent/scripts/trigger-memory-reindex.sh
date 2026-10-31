#!/bin/bash
# trigger-memory-reindex.sh — nightly reindex of the auto-memory semantic layer.
# Scans the auto-memory dir (lib/instance.cjs --memory-dir)/*.md, chunks each
# file at h2/h3 boundaries, and embeds new/changed chunks via local Ollama
# (nomic-embed-text). Updates data/memory-index.db.
#
# No webhook dispatch — this is pure filesystem + local embedding work, so it
# runs directly under cron. Safe to run manually; idempotent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JORI_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$JORI_ROOT/agent/logs"
LOG_FILE="$LOG_DIR/memory-reindex.log"

mkdir -p "$LOG_DIR"

# PATH for cron context (Homebrew node, osxphotos, etc.)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

TS="$(date '+%Y-%m-%d %H:%M:%S')"
{
  echo "=== $TS ==="
  "$JORI_ROOT/bin/memory" reindex 2>&1 || {
    rc=$?
    echo "memory reindex FAILED with exit $rc"
    exit "$rc"
  }
} >>"$LOG_FILE" 2>&1
