#!/bin/bash
# trigger-watch-review.sh — weekly scorecard + coverage audit of the watch
# engine (system/watch.md, playbook jobs/watch-review.md).
#
# Every reminder or conditional request goes to the watch engine; this tracks
# how well it works so it can be improved.
#
# Code does the gathering so the agent turn only judges: the week's scorecard
# (`watch stats --json`, reactions + task status included) and every message
# the user sent in chat that week (the coverage audit reads them for reminder
# requests that never became a watch). Then dispatch to ops-light.

export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:$PATH"
source "$(dirname "$0")/lib/root.sh"       # JORI_ROOT
source "$(dirname "$0")/lib/instance.sh"   # JORI_TZ
ROOT="$JORI_ROOT"
OUT="$ROOT/data/watch-review"
DAY=$(TZ="$JORI_TZ" date +%F)
mkdir -p "$OUT"
[[ -f "$ROOT/data/watch-review-pause.json" ]] && exit 0

"$ROOT/bin/watch" stats --days 7 --json > "$OUT/$DAY-stats.json" 2>> "$OUT/trigger.log" || echo '{"error":"watch stats failed"}' > "$OUT/$DAY-stats.json"

node --input-type=module -e '
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(process.argv[1] + "/");
require(process.argv[1] + "/lib/load-env.js").loadEnv();
const { requestAll } = require(process.argv[1] + "/lib/supabase-rest.js");
const since = new Date(Date.now() - 7 * 86400e3).toISOString();
const rows = await requestAll(`/rest/v1/jori_messages?select=id,created_at,content&role=eq.user&created_at=gte.${since}&order=created_at.asc`);
fs.writeFileSync(process.argv[2], JSON.stringify(rows.map((r) => ({ id: r.id, at: r.created_at, text: String(r.content || "").slice(0, 2000) })), null, 1));
' "$ROOT" "$OUT/$DAY-chat.json" 2>> "$OUT/trigger.log" || echo '[]' > "$OUT/$DAY-chat.json"

source "$(dirname "$0")/lib/webhook-auth.sh"
dispatch_or_skip "{\"job\": \"watch-review\", \"source\": \"cron-watch-review\", \"day\": \"$DAY\"}" watch-review
