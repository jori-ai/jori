#!/bin/bash
# trigger-wiki-link-audit.sh — cron wrapper for concept-link auto-apply.
#
# Runs the wiki concept-link auditor in --apply mode (deterministic, safe:
# first-occurrence-only, skips code/existing-links/self-links). Silent when
# clean; emails the owner (instance owner_email) a "what I linked" report only
# when something changed AND data/wiki-link-audit-config.json doesn't have
# "silent": true (no owner_email configured → no email either). Auto-apply
# replaced a manual-review digest once the links proved safe; an installation
# that wants no email at all sets "silent": true — see
# system/wiki-architecture.md § Concept-link audit.
#
# All output goes to agent/logs/wiki-link-audit.log; cron sees only
# the exit code.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JORI_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=lib/instance.sh
source "$SCRIPT_DIR/lib/instance.sh"
LOG_DIR="$JORI_ROOT/agent/logs"
LOG_FILE="$LOG_DIR/wiki-link-audit.log"
TMP_JSON="$JORI_ROOT/data/.wiki-link-audit-latest.json"
TMP_BODY="$JORI_ROOT/data/.wiki-link-audit-email.txt"
CONFIG_FILE="$JORI_ROOT/data/wiki-link-audit-config.json"

mkdir -p "$LOG_DIR" "$JORI_ROOT/data"

# PATH for cron context (Homebrew node, etc.)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

TS="$(date '+%Y-%m-%d %H:%M:%S')"
{
  echo "=== $TS ==="
  "$JORI_ROOT/bin/wiki-link-audit" --apply --json >"$TMP_JSON" 2>&1

  node_rc=0
  node - "$TMP_JSON" "$TMP_BODY" <<'NODE' || node_rc=$?
const fs = require("node:fs");
const [jsonPath, bodyPath] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const changed = report.changed || [];
if (!changed.length) {
  process.exit(3); // sentinel: nothing changed, caller stays quiet
}
const totalLinks = changed.reduce((n, c) => n + c.added.length, 0);
const lines = [];
lines.push(`Wiki link audit: ${new Date().toISOString().slice(0, 10)}`);
lines.push("");
lines.push(`Auto-applied ${totalLinks} link(s) across ${changed.length} page(s).`);
lines.push("");
for (const c of changed) {
  lines.push(c.id);
  for (const a of c.added) lines.push(`  - ${a.alias} -> [[${a.target}|${a.alias}]]`);
  lines.push("");
}
lines.push("Review history with: bin/wiki history <page_id>");
fs.writeFileSync(bodyPath, lines.join("\n"));
NODE

  if [ "$node_rc" -eq 3 ]; then
    echo "wiki-link-audit: clean, nothing to apply"
    exit 0
  elif [ "$node_rc" -ne 0 ]; then
    echo "wiki-link-audit: report builder failed with exit $node_rc"
    exit "$node_rc"
  fi

  cat "$TMP_BODY"

  SILENT="false"
  if [ -f "$CONFIG_FILE" ]; then
    SILENT="$(jq -r '.silent // false' "$CONFIG_FILE" 2>/dev/null || echo false)"
  fi

  if [ "$SILENT" = "true" ]; then
    echo "wiki-link-audit: applied, email suppressed (silent mode per $CONFIG_FILE)"
  elif [ -z "${JORI_OWNER_EMAIL:-}" ]; then
    echo "wiki-link-audit: applied, no owner_email configured (no report sent)"
  else
    "$JORI_ROOT/bin/email-send" \
      --to "$JORI_OWNER_EMAIL" \
      --subject "Wiki link audit: auto-applied ($(date '+%Y-%m-%d'))" \
      --body-file "$TMP_BODY" || {
        rc=$?
        echo "email-send failed with exit $rc"
        exit "$rc"
      }
  fi
} >>"$LOG_FILE" 2>&1
