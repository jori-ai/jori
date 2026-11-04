// location-confirm-resolve-grounded-promotion.test.mjs — the authority gate.
//
// The bug: any tier that returned {decision:"auto_confirm"} got written into
// confirmed-stops.json with full "user-confirmed" authority, including the
// model-judgment tail (Jev / Gemma extraction / the kill-switch fallback
// classifier) that GUESSES a venue from ambiguous evidence rather than
// matching something the user actually wrote. Once written, tier 1 of
// localResolve() trusts that entry at full strength for every future dwell
// near the same centroid — so one wrong guess became a permanent,
// self-reinforcing "confirmation" nobody ever actually confirmed. This is
// the "automated guess marking itself confirmed on its own authority" gap
// — see jobs/location-confirm-ask.md § Automated guesses cannot self-confirm.
//
// promoteSafely() now refuses to promote unless `source` is one of the
// deterministic, evidence-grounded tiers (GROUNDED_PROMOTION_SOURCES in
// bin/location-confirm-resolve.mjs). These tests drive it through the
// `--promote-safely-only` hatch against a TEMP fixture — never
// data/confirmed-stops.json, which is live user data.
//
// Run: node --test tests/location-confirm-resolve-grounded-promotion.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Synthetic coordinates: metres east/north of an obviously fake origin, so the
// fixtures keep the real traces' geometry without pinning a real place.
const ORIGIN = [12.3456, -65.4321];
const M_PER_DEG = 6371000 * Math.PI / 180;
const fakePt = (e, n) => { const lat = ORIGIN[0] + n / M_PER_DEG; return [lat, ORIGIN[1] + e / (M_PER_DEG * Math.cos(lat * Math.PI / 180))]; };
const fakeAt = (e, n) => { const [lat, lon] = fakePt(e, n); return { lat, lon }; };
const fakeRow = (e, n) => { const [latitude, longitude] = fakePt(e, n); return { latitude, longitude }; };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "bin/location-confirm-resolve.mjs");
const LIVE_STORE = path.join(ROOT, "data/confirmed-stops.json");

const ASK = {
  ask_id: "lc-20260925-1500-25.813--80.191",
  centroid: { ...fakeAt(0, 0) },
  first_sample_ts: "2026-09-25T18:24:11+00:00",
  last_sample_ts: "2026-09-25T19:05:32.118000+00:00",
  duration_min: 41.3,
};
const CANDIDATES = [{ name: "Some Candidate", address: "123 Main St", primary_type: "restaurant" }];

function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "location-confirm-grounded-"));
  const file = path.join(dir, "confirmed-stops.json");
  fs.writeFileSync(file, "[]\n");
  return file;
}

function promoteSafely(file, { ask = ASK, decision = "auto_confirm", venue = "Some Candidate", candidates = CANDIDATES, source } = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, "--promote-safely-only"], {
    input: JSON.stringify({ ask, decision, venue, candidates, source }),
    encoding: "utf8",
    env: { ...process.env, JORI_CONFIRMED_STOPS_FILE: file },
    timeout: 20000,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function readStore(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

for (const source of ["local:memory", "local:calendar", "local:calendar_title", "local:message"]) {
  test(`grounded source "${source}" promotes`, () => {
    const file = mkFixture();
    const out = promoteSafely(file, { source });
    assert.equal(out.promoted, true, JSON.stringify(out));
    assert.equal(readStore(file).length, 1);
  });
}

for (const source of ["jev:candidate", "jev:named_other", "local:message_explicit", "local_llm_fallback", "local", undefined, ""]) {
  test(`ungrounded source ${JSON.stringify(source)} does not promote`, () => {
    const file = mkFixture();
    const out = promoteSafely(file, { source });
    assert.equal(out.promoted, false, JSON.stringify(out));
    assert.equal(out.reason, `ungrounded_source:${source || "unknown"}`);
    assert.deepEqual(readStore(file), [], "store untouched");
  });
}

test("a non-auto_confirm decision never promotes, regardless of source", () => {
  const file = mkFixture();
  const out = promoteSafely(file, { decision: "ask", source: "local:memory" });
  assert.equal(out.promoted, false);
  assert.equal(out.reason, "not_auto_confirm");
  assert.deepEqual(readStore(file), []);
});

test("a model-guess tier still settles today's ask without corrupting tomorrow's", () => {
  // The intended shape of the fix: an ungrounded auto_confirm is still a valid
  // decision for the CALLER (the trigger script still skips asking about this
  // dwell today) — it just never becomes durable "confirmed" ground truth that
  // a future, unrelated dwell near the same centroid would inherit.
  const file = mkFixture();
  const out = promoteSafely(file, { source: "jev:candidate" });
  assert.equal(out.promoted, false);
  assert.deepEqual(readStore(file), [], "no durable trace of the guess is left behind");
});

test("the live confirmed-stops.json is never touched by this test file", () => {
  // The live store exists only on the mini (gitignored). Elsewhere, "never
  // touched" means it must still not exist after this file ran.
  if (!fs.existsSync(LIVE_STORE)) return;
  const live = JSON.parse(fs.readFileSync(LIVE_STORE, "utf8"));
  assert.ok(Array.isArray(live) && live.length > 0);
  assert.ok(!live.some((e) => e && e.name === "Some Candidate"), "test data must never reach the live store");
});
