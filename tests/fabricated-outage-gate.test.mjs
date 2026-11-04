// The fabricated-outage gate in bin/jori-send-curl (2026-07-22).
//
// Four times a job-scoped agent turn composed a total-outage page and sent it
// to the user while the machine was healthy (2026-07-10/11/12 and 07-22). The
// gate blocks that claim shape from unauthorized callers. It is deliberately
// NARROW: agent turns are explicitly instructed by ops-agent/CLAUDE.md to post
// several other system-channel alerts, and those must keep working — a gate
// that silences a real signal is worse than the false page it prevents.
//
// This test extracts the live regex out of the script so it cannot drift from
// the implementation, then asserts it against real messages from
// jori_messages (channel='system').

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "bin/jori-send-curl");

function livePattern() {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const m = src.match(/^INFRA_CLAIM_RE='(.+)'$/m);
  assert.ok(m, "INFRA_CLAIM_RE not found in jori-send-curl — did the gate get renamed or removed?");
  return new RegExp(m[1], "i");
}

// Verbatim fabricated pages that reached the user's phone while the host was fine.
const MUST_BLOCK = [
  "🔴 CRITICAL: No scheduled jobs running — crontab empty, launchd agents not loaded. 50+ jobs offline including hum, digests, flights-scan. Needs manual restart/investigation.",
  "🔴 CRITICAL: All supervisors have been unreachable for over an hour. Manual restart of launchd services required immediately.",
];

// Verbatim real system-channel messages that are legitimate and must still
// send. Several are agent-turn-authored by explicit CLAUDE.md instruction.
const MUST_ALLOW = [
  // Agent-authored data-quality alerts (ops-agent/CLAUDE.md mandates these)
  "⚠️ 3 emails this week arrived pre-labeled Personal before triage (all no-reply@easypark.net) — check for a stray Gmail filter or intake-side auto-label",
  "⚠️ Vendor intake-skip still not intercepting — 3 more notifications@vendor.example emails hit inbox unlabeled today despite confirmed BLOCKED status in spam-filter.",
  "⚠️ reclassify loop: Rina/SMH thread — phantom-skipped after 4 dispatches in 30min",
  // Agent/cron-authored operational failures that name a specific component
  "⚠️ unstar-scan failed: Gmail API unreachable (ENOTFOUND gmail.googleapis.com) — will retry next cycle",
  "🔴 Gmail API persistently unreachable (2h+, 3 p1-downgrade attempts failed) — DNS/network issue requires manual intervention",
  "⚠️ weekly-memo did NOT run — auth/empty output. Weekly Opus memo was NOT generated.",
  "⚠️ Brokerage snapshot got 0 accounts — brokerage.example.com connection is down (brokerage OAuth token expired).",
  "🔴 Episode-archive missing for 2026-07-19 — the 02:00 cron didn't produce a day page.",
  "⚠️ gh CLI auth is broken. Run: gh auth logout -h github.com -u example-user && gh auth login",
  // Recovery pings
  "✅ Recovered: Max auth is back to normal — auto-healed, stable for 3 checks.",
  "✅ Jori ops-haiku recovered: the fresh session is processing turns again after the crash-loop.",
];

test("gate blocks the fabricated machine-wide-outage claims that actually shipped", () => {
  const re = livePattern();
  for (const msg of MUST_BLOCK) {
    assert.ok(re.test(msg), `should be gated but is not:\n  ${msg}`); // lang-regex-ok: asserts the gate's OWN regex against a fixture alert string
  }
});

test("gate does NOT touch legitimate system-channel alerts", () => {
  const re = livePattern();
  for (const msg of MUST_ALLOW) {
    assert.ok(!re.test(msg), `legitimate alert would be silenced:\n  ${msg}`); // lang-regex-ok: same fixture check, negative case
  }
});

test("the gate is scoped to --channel system and to unauthorized callers", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  // Both conditions must be present: wrong channel or an authorized prober
  // must bypass it entirely.
  assert.match(src, /\[ "\$CHANNEL" = "system" \]/, "gate must only apply to the system channel");
  assert.match(src, /JORI_INFRA_PROBE:-\}" != "1"/, "authorized probers must bypass the gate");
});

test("every authorized infra prober actually sets JORI_INFRA_PROBE", () => {
  // If one of these loses the env var, its real outage page goes silent —
  // the exact failure this gate must never cause.
  const probers = [
    ["agent/scripts/watchdog.sh", /JORI_INFRA_PROBE=1 "\$SEND"/],
    ["agent/scripts/chrome-cdp-watch.sh", /JORI_INFRA_PROBE=1 "\$HOME\/Dev\/jori\/bin\/jori-send-curl"/],
    ["agent/supervisor/index.mjs", /JORI_INFRA_PROBE: "1"/],
    ["agent/supervisor/chat-supervisor.mjs", /JORI_INFRA_PROBE: "1"/],
  ];
  for (const [rel, re] of probers) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(src, re, `${rel} no longer authorizes itself — its outage alerts would be blocked`);
  }
});
