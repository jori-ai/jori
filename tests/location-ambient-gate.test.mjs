// location-ambient-gate.test.mjs — the location-ambient trigger's stop gate
// (agent/scripts/trigger-location-ambient.sh, its inline `node -e` program)
// reads the LIVE shared ping counter (hum-state.json via bin/ping-budget), not
// the retired pulse-state.json: the lane skips when today's count is at the
// cap and dispatches a fresh stop under it.
//
// Synthetic installation (tests/synthetic-instance.mjs, UTC) and a sandboxed
// HOME, so the run sees no real ledger. No network, no model.
// Run: node --test tests/location-ambient-gate.test.mjs

import "./synthetic-instance.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT as REPO } from "../lib/root.cjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "location-ambient-gate-"));
const DATA = path.join(tmp, "data");
fs.mkdirSync(DATA, { recursive: true });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const AMBIENT = path.join(REPO, "agent/scripts/trigger-location-ambient.sh");

/** The trigger's inline `node -e` gate program, sliced out of the script verbatim. */
function ambientGateProgram() {
  const src = fs.readFileSync(AMBIENT, "utf8");
  const start = src.indexOf("node -e '", src.indexOf("GATE=$(ACTIVITY_JSON"));
  const end = src.indexOf("' 2>/dev/null)", start);
  assert.ok(start > 0 && end > start, "found the gate program");
  return src.slice(start + "node -e '".length, end);
}

function runAmbientGate(humState) {
  fs.writeFileSync(path.join(DATA, "hum-state.json"), JSON.stringify(humState));
  fs.writeFileSync(path.join(DATA, "hum-feedback.jsonl"), "");
  // A dead pulse-state.json that says 0 — the gate must not be fooled by it.
  fs.writeFileSync(path.join(DATA, "pulse-state.json"), JSON.stringify({ today: { pings: 0, last_at: null } }));
  const now = new Date();
  const activity = { segment_type: "visit", departed_at: null, arrived_at: new Date(now.getTime() - 5 * 60_000).toISOString(), place_name: "Praça Central" };
  const r = spawnSync(process.execPath, ["-e", ambientGateProgram()], {
    encoding: "utf8",
    // Only what the trigger passes; every ping-budget override cleared so the
    // lane sees the code defaults (6/day, 45 min apart).
    env: {
      PATH: process.env.PATH, HOME: tmp, JORI_LOCAL_DIR: process.env.JORI_LOCAL_DIR,
      HUM_STATE_PATH: path.join(DATA, "hum-state.json"), HUM_FEEDBACK_PATH: path.join(DATA, "hum-feedback.jsonl"),
      ACTIVITY_JSON: JSON.stringify(activity), JORI_LA_DATA: `${DATA}/`, JORI_LA_BIN: `${path.join(REPO, "bin")}/`,
    },
  });
  return r.stdout;
}

test("location-ambient skips when today's count (hum-state.json) is at the cap, dispatches under it", () => {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
  const old = new Date(Date.now() - 3 * 3600_000).toISOString(); // clear of the 45-min floor
  assert.match(runAmbientGate({ today: { date: today, pings: 6 }, last_ping_at: old }), /^skip:ping-budget \(daily_cap/);
  assert.match(runAmbientGate({ today: { date: today, pings: 2 }, last_ping_at: old }), /^dispatch:fresh-stop/);
});

test("pulse-state.json is retired from the ambient trigger", () => {
  const src = fs.readFileSync(AMBIENT, "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("#")).join("\n");
  assert.ok(!code.includes("pulse-state.json"), "trigger-location-ambient.sh still reads pulse-state.json");
});
