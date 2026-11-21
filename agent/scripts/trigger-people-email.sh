#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger people-email via webhook → ops-light.
#
# Nightly. Gmail is network, so this un-sandboxed cron does every fetch:
# `email-people sync` (new mail since the last run → ledger), Sundays a
# Google Contacts refresh, then writes tonight's batch of stale people to
# data/people-email-pending.json. The agent turn only reads the local
# ledger and writes wiki pages. See jobs/people-email.md.
#
# 2026-10-23: new (a user requirement: people context built from email,
# kept up to date automatically).
# 2026-10-27: also the texts half — `chat-people sync` (iMessage + WhatsApp
# counts for people who already have a page) and a second pending file; the
# job dispatches when either half has someone due. A sync that cannot read
# Messages/Contacts (Full Disk Access) is logged and non-fatal: the agent turn
# runs the same sync itself.
# 2026-11-14: also the meetings half — `calendar-people sync` (the recent
# window of the primary calendar through gog: network, so here) and
# `backfill` (resumes reading history until it reaches the configured start;
# a no-op once done), then three batches for Part C: titles to read, guests
# with no page, in-person meetings to check against the day record, and pages
# due a ## Meetings summary.

export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:$PATH"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS

resolve_tier_ports people-email   # job-routing.json → ops-light
ROOT="$JORI_INSTALL_TOOLS"
DATA="$ROOT/data"
LOGFILE="$ROOT/agent/logs/watchdog.log"
JOBLOG="$ROOT/agent/logs/people-email.log"
PAYLOAD='{"job": "people-email"}'
BATCH_LIMIT=30
CHAT_BATCH_LIMIT=20
MEET_BATCH_LIMIT=20
TITLE_BATCH_LIMIT=300
GUEST_BATCH_LIMIT=25
VERIFY_BATCH_LIMIT=40

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [people-email] $1" | tee -a "$JOBLOG" >> "$LOGFILE"; }

SYNC=$("$ROOT/bin/email-people" sync 2>>"$JOBLOG") || log "sync failed (dispatching the stale backlog anyway)"
[ -n "$SYNC" ] && log "sync: $SYNC"

if [ "$(date +%u)" = "7" ]; then
  CONTACTS=$("$ROOT/bin/email-people" contacts-refresh 2>>"$JOBLOG") || log "contacts-refresh failed"
  [ -n "$CONTACTS" ] && log "contacts: $CONTACTS"
fi

"$ROOT/bin/email-people" candidates --stale --limit "$BATCH_LIMIT" --json \
  > "$DATA/people-email-pending.json" 2>>"$JOBLOG" || { log "candidates failed"; exit 1; }

PENDING=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)}catch{console.log(0)}' "$DATA/people-email-pending.json")

# Texts half: people who already have a page and a message history.
CHAT_SYNC=$("$ROOT/bin/chat-people" sync 2>>"$JOBLOG") || log "chat-people sync failed (the agent turn retries it)"
[ -n "$CHAT_SYNC" ] && log "chat-people: $CHAT_SYNC"
"$ROOT/bin/chat-people" candidates --stale --limit "$CHAT_BATCH_LIMIT" --json \
  > "$DATA/people-chats-pending.json" 2>>"$JOBLOG" || echo '[]' > "$DATA/people-chats-pending.json"
CHAT_PENDING=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)}catch{console.log(0)}' "$DATA/people-chats-pending.json")

# Meetings half: the calendar ledger, then Part C's three batches in one file.
CAL_SYNC=$("$ROOT/bin/calendar-people" sync 2>>"$JOBLOG") || log "calendar-people sync failed (gog auth?)"
[ -n "$CAL_SYNC" ] && log "calendar-people: $CAL_SYNC"
CAL_BACK=$("$ROOT/bin/calendar-people" backfill 2>>"$JOBLOG") || log "calendar-people backfill failed (resumes tomorrow)"
[ -n "$CAL_BACK" ] && log "calendar-people backfill: $CAL_BACK"
MEET_PENDING=$(node -e '
const cal = require(process.argv[1]);
try {
  const out = {
    titles: cal.titlesPending({ limit: Number(process.argv[3]) }),
    unmatched: cal.unmatched({ limit: Number(process.argv[4]) }),
    verify: (() => {
      const ws = require(require("path").join(require("path").dirname(process.argv[1]), "wiki-store.js"));
      try { return cal.verifyPending({ limit: Number(process.argv[6]), dayExists: (d) => !!ws.getPage("day_" + d) }); } finally { ws.closeDb(); }
    })(),
    pages: cal.candidates({ staleOnly: true, limit: Number(process.argv[5]) }),
  };
  require("fs").writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
  console.log(out.titles.length + out.unmatched.length + out.verify.length + out.pages.length);
} catch (e) { process.stderr.write(String(e.message) + "\n"); console.log(0); } finally { cal.closeDb(); }
' "$ROOT/lib/calendar-people.js" "$DATA/people-meetings-pending.json" "$TITLE_BATCH_LIMIT" "$GUEST_BATCH_LIMIT" "$MEET_BATCH_LIMIT" "$VERIFY_BATCH_LIMIT" 2>>"$JOBLOG")

if [ "${PENDING:-0}" -eq 0 ] && [ "${CHAT_PENDING:-0}" -eq 0 ] && [ "${MEET_PENDING:-0}" -eq 0 ]; then
  log "skip: no stale correspondents, text partners or meetings"
  exit 0
fi

is_healthy() {
  local health
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null) || return 1
  echo "$health" | grep -q '"childAlive":true'
}

dispatch() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$PAYLOAD" 2>/dev/null)
  [ "${code:0:1}" = "2" ]
}

if is_healthy && dispatch; then
  log "Dispatched people-email ($PENDING by email, $CHAT_PENDING by texts, $MEET_PENDING calendar items)"
  exit 0
fi

sleep 60
if is_healthy && dispatch; then
  log "Dispatched people-email (retry, $PENDING by email, $CHAT_PENDING by texts, $MEET_PENDING calendar items)"
  exit 0
fi

log "people-email failed: supervisor unhealthy after retry"
exit 1
