// photo-companions.test.mjs — Jev may drop a face that is only PICTURED, never
// add one; the user is never a companion; names are canonical. Synthetic names
// in a temp local config. Also bin/photos-synthesize-stops (the stage that
// calls it) never nests a synthetic visit inside an open one.
// Run: node --test tests/photo-companions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "photo-companions-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "instance.json"), JSON.stringify({ owner_name: "Alex", owner_id: "alex" }));
fs.writeFileSync(path.join(LOCAL, "config", "companion-names.json"), JSON.stringify({
  self: ["Alex Example"], aliases: { "Sam Example": "Sam", "Rover": "Rover", "Kim Example": "Kim" },
}));
process.env.JORI_LOCAL_DIR = LOCAL;
const { presentCompanions, buildState, taggedPeople } = await import("../lib/photo-companions.mjs");

const cafe = [
  { taken_at: "2026-10-07T05:34:17Z", persons: ["Sam Example", "Rover"], labels: ["dog", "people", "restaurant"], self_captured: true },
  { taken_at: "2026-10-07T05:34:18Z", persons: ["Alex Example", "Sam Example"], labels: ["people", "cup"], self_captured: true },
  { taken_at: "2026-10-07T05:36:00Z", persons: ["Kim Example"], labels: ["computer monitor", "screen"], self_captured: true },
];
// Stand-in for the harness: run interpret on scripted answers, act on them.
const jevSays = (yes) => async (o) => {
  const answers = {};
  Object.keys(o.questions).forEach((k, i) => { answers[k] = { type: "noul", noul: yes[i] }; });
  const it = o.interpret(answers);
  return { value: it.value, used: "jev", jev: { confidence: it.confidence } };
};

test("the user is never a companion and face-tag names are canonical", () => {
  assert.deepEqual([...taggedPeople(cafe).keys()], ["Sam", "Rover", "Kim"]);
  const st = buildState({ photos: cafe, tz: "Asia/Jerusalem" });
  assert.deepEqual(st.photos[1].people_tagged, ["Sam"]);
  assert.equal(st.photos[0].at, "08:34");
  assert.equal(st.photos[0].taken_by_alex, true, "the took-it key is named with the owner id");
});

test("a face only on a screen is dropped; the people at the table stay", async () => {
  const r = await presentCompanions({ photos: cafe, decideImpl: jevSays([0.98, 0.97, 0.03]) });
  assert.deepEqual(r.present, ["Sam", "Rover"]);
  assert.deepEqual(r.dropped.map((d) => d.name), ["Kim"]);
});

test("on legacy (Jev unsure or down) every tag stands", async () => {
  const r = await presentCompanions({ photos: cafe, decideImpl: async (o) => ({ value: await o.legacy(), used: "legacy" }) });
  assert.deepEqual(r.present, ["Sam", "Rover", "Kim"]);
});

test("no tagged people: nothing asked", async () => {
  const r = await presentCompanions({ photos: [{ persons: ["Alex"] }], decideImpl: () => { throw new Error("asked"); } });
  assert.deepEqual(r, { present: [], dropped: [], used: "none" });
});

// ── photos-synthesize-stops, the stage that calls presentCompanions ──────────
// Failure class: an OPEN visit (departed_at null: the user is still there, the
// normal state during the intraday run) read as zero-length, so a photo taken
// inside the ongoing stay looked non-overlapping and a duplicate synthetic
// visit was inserted nested in the real one. The script runs in a child with
// fetch stubbed (GET only, fixture rows), dry-run, no calendar binary: nothing
// leaves the process.
const SYNTH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "photos-synthesize-stops");
const STUB = path.join(LOCAL, "fetch-stub.mjs");
fs.writeFileSync(STUB, `const fx = JSON.parse(process.env.PSS_FIXTURE);
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if ((opts.method || "GET") !== "GET") throw new Error("stub: refused " + opts.method + " " + u);
  const table = new URL(u).pathname.split("/").pop();
  if (!(table in fx)) throw new Error("stub: no fixture for " + u);
  return new Response(JSON.stringify(fx[table]), { status: 200, headers: { "content-type": "application/json" } });
};
`);

const stayPhotos = [
  { uuid: "p1", taken_at: "2026-10-07T12:15:00Z", latitude: 40.0, longitude: -75.0, persons: [], labels: [], self_captured: true },
  { uuid: "p2", taken_at: "2026-10-07T12:20:00Z", latitude: 40.0002, longitude: -75.0, persons: [], labels: [], self_captured: true },
];
function synthesizable(visits) {
  const env = {
    ...process.env,
    JORI_HOME: LOCAL, JORI_LOCAL_DIR: LOCAL, JORI_TZ: "UTC",
    SUPABASE_URL: "http://stub.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-key",
    GOG_BIN: path.join(LOCAL, "no-gog"),
    PSS_FIXTURE: JSON.stringify({ photos: stayPhotos, location_history: visits.map((v) => ({ segment_type: "visit", ...v })) }),
  };
  delete env.DROP;
  const out = execFileSync(process.execPath, ["--import", pathToFileURL(STUB).href, SYNTH, "2026-10-07"], { env, encoding: "utf8" });
  const line = out.split("\n").find((l) => l.includes(" synthesizable"));
  assert.ok(line, `no summary line in: ${out}`);
  return Number(line.split(" / ").pop().split(" ")[0]);
}

test("synthesize-stops: photos with no visit row become one stop", () => {
  assert.equal(synthesizable([]), 1);
});

test("synthesize-stops: an open visit already under way covers the photos — no nested twin", () => {
  assert.equal(synthesizable([{ arrived_at: "2026-10-07T12:13:36Z", departed_at: null, latitude: 40.0001, longitude: -75.0 }]), 0);
});

test("synthesize-stops: an open visit does not reach back before its arrival, nor past 300m", () => {
  assert.equal(synthesizable([{ arrived_at: "2026-10-07T12:30:00Z", departed_at: null, latitude: 40.0001, longitude: -75.0 }]), 1);
  assert.equal(synthesizable([{ arrived_at: "2026-10-07T12:00:00Z", departed_at: null, latitude: 40.02, longitude: -75.0 }]), 1);
});
