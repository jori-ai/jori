// location-confirm-promote.test.mjs — the durable half of the location-confirm
// loop. Synthetic names, addresses and coordinates.
//
// The bug: bin/location-confirm-resolve.mjs only ever READ
// confirmed-stops.json. The single append path was the Python
// `bin/location-confirm save`, which refuses (exit 2) once an ask has been
// pruned out of pending/recent — so a resolved centroid → name mapping could be
// produced and then dropped on the floor. Nothing was appended in 14 days while
// the user answered at least five location questions in chat ("Mercado Example
// for lunch" among them), and asked why an answer given "wasn't registered".
//
// These tests drive the promotion through the script's `--promote-only` entry
// point against a TEMP fixture — never data/confirmed-stops.json, which is
// live user data. The subprocess shape is deliberate: it exercises the real
// binary rather than a re-implementation, and skips the calendar / Supabase /
// wiki / Ollama round-trips the normal pipeline makes.
//
// Run: node --test tests/location-confirm-promote.test.mjs

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

// Two real entries copied out of confirmed-stops.json, so the fixture has the
// exact shape the promotion has to match (a google_places one and a
// user_freeform one) plus a Paris centroid far from anything we add.
const SEED = [
  {
    ts: "2026-08-06T08:18:09.670589+00:00",
    ask_id: "lc-20260806-0920-48.86-2.355",
    centroid: { ...fakeAt(0, 0) },
    name: "Terres de Café",
    address: "14 Rue Rambuteau, 75003 Paris, France",
    place_id: "ChIJq4Z1rhxu5kcRrENk5n5RLNQ",
    primary_type: "cafe",
    source: "google_places",
    stop_window: {
      start: "2026-08-06T06:50:22+00:00",
      end: "2026-08-06T07:20:01.865000+00:00",
      duration_min: 29.7,
    },
    patched_location_history: false,
  },
  {
    ts: "2026-08-08T20:30:16.255843+00:00",
    ask_id: "lc-20260808-2010-48.847-2.347",
    centroid: { ...fakeAt(-549.9, -1494.57) },
    name: "Improvised PowerPoint Comedy Show in English",
    address: null,
    place_id: null,
    primary_type: null,
    source: "user_freeform",
    stop_window: {
      start: "2026-08-08T17:44:50+00:00",
      end: "2026-08-08T18:10:00.999000+00:00",
      duration_min: 25.2,
    },
    patched_location_history: true,
  },
];

// The lunch stop: a dwell whose only GPS candidate was a reverse-geocoded
// street address, with the user supplying the real venue in chat. Exactly the case that was being lost.
const MERCADO_ASK = {
  is_stop: true,
  inferred: true,
  duration_min: 41.3,
  centroid: { ...fakeAt(-8262896.19, -2562754.29) },
  cluster_radius_m: 0.0,
  sample_count: 3,
  first_sample_ts: "2026-08-22T18:24:11+00:00",
  last_sample_ts: "2026-08-22T19:05:32.118000+00:00",
  primary: {
    name: "3131 Example Avenue",
    address: "3131 Example Avenue, Sampleton, ZZ",
    source: "reverse_geocode",
    confidence: 0.65,
  },
  alternatives: [],
  photo_count: 0,
  needs_confirm: true,
  skip_reason: null,
  ask_id: "lc-20260822-1500-25.813--80.191",
  ask_key: "20260822-25.813--80.191",
};
const MERCADO_CANDIDATES = [MERCADO_ASK.primary];

function mkFixture(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "location-confirm-promote-"));
  const file = path.join(dir, "confirmed-stops.json");
  fs.writeFileSync(file, contents);
  return { dir, file };
}

// The ask stores `location-confirm save` looks in. They live beside
// confirmed-stops.json, so writing them into the fixture dir is what
// production looks like.
const PENDING = "location-confirm-pending.json";
const RECENT = "location-confirm-recent.json";
function writeAskStore(dir, basename, asks) {
  fs.writeFileSync(path.join(dir, basename), JSON.stringify(asks, null, 2) + "\n");
}

function promote(file, payload) {
  const res = spawnSync(process.execPath, [SCRIPT, "--promote-only"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, JORI_CONFIRMED_STOPS_FILE: file },
    timeout: 20000,
  });
  return {
    status: res.status,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

function readStore(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("a free-form chat answer is appended as one user_freeform entry", () => {
  const { file } = mkFixture(JSON.stringify(SEED, null, 2) + "\n");

  const r = promote(file, {
    ask: MERCADO_ASK,
    venue: "Mercado Example",
    candidates: MERCADO_CANDIDATES,
  });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).promoted, true);

  const after = readStore(file);
  assert.equal(after.length, SEED.length + 1, "exactly one entry appended");
  // Nothing existing was lost or rewritten.
  assert.deepEqual(after.slice(0, SEED.length), SEED);

  const e = after[after.length - 1];
  assert.equal(e.name, "Mercado Example");
  assert.equal(e.ask_id, MERCADO_ASK.ask_id);
  assert.equal(e.source, "user_freeform", "a venue outside the candidate list is free-form");
  assert.deepEqual(e.centroid, MERCADO_ASK.centroid);
  assert.equal(e.address, null);
  assert.equal(e.place_id, null);
  assert.equal(e.primary_type, null);
  assert.deepEqual(e.stop_window, {
    start: MERCADO_ASK.first_sample_ts,
    end: MERCADO_ASK.last_sample_ts,
    duration_min: MERCADO_ASK.duration_min,
  });
  assert.ok(!Number.isNaN(Date.parse(e.ts)), "ts is a parseable ISO timestamp");

  // This path has no location_history write-back, so the flag must be present
  // and false — jobs/location-confirm-ask.md forbids dropping it, because a
  // silent no-op is otherwise indistinguishable from success.
  assert.equal(e.patched_location_history, false);

  // Same keys, same order as the entries location-confirm itself writes
  // (`patched_location_history` is stamped last there too).
  assert.deepEqual(Object.keys(e), [
    "ts", "ask_id", "centroid", "name", "address", "place_id", "primary_type",
    "source", "stop_window", "patched_location_history",
  ]);

  // Written in location-confirm's on-disk shape: indent 2, trailing newline.
  const rawText = fs.readFileSync(file, "utf8");
  assert.equal(rawText, JSON.stringify(after, null, 2) + "\n");
  // The atomic-write temp file must not survive.
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")),
    [],
  );
});

test("re-resolving the same ask_id appends nothing", () => {
  const { file } = mkFixture(JSON.stringify(SEED, null, 2) + "\n");

  const first = promote(file, { ask: MERCADO_ASK, venue: "Mercado Example", candidates: MERCADO_CANDIDATES });
  assert.equal(JSON.parse(first.stdout).promoted, true);
  const afterFirst = readStore(file);

  const second = promote(file, { ask: MERCADO_ASK, venue: "Mercado Example", candidates: MERCADO_CANDIDATES });
  assert.equal(second.status, 0);
  const out = JSON.parse(second.stdout);
  assert.equal(out.promoted, false);
  assert.equal(out.reason, "duplicate_ask_id");
  assert.deepEqual(readStore(file), afterFirst, "store byte-identical after the replay");
});

// ─── the canonical-saver stand-down ────────────────────────────────────────
// Found in review, and the reason this gate exists: two rows at one centroid is
// NOT a cosmetic duplicate. localResolve tier 1 counts rows per name
// (`near[names[i]] = (near[names[i]] || 0) + 1`) and takes the max, so an extra
// row inflates one venue's score by exactly 1 and can flip a tie against a
// genuinely nearer neighbour — a resolver correctness bug on the very path this
// promotion is meant to strengthen. In the live trigger path the ask is written
// to recent.json immediately before resolve runs and the Python saver appends
// right after, so standing down there is the CORRECT outcome, not lost coverage.

test("stands down when `location-confirm save` will handle the ask itself", () => {
  for (const basename of [PENDING, RECENT]) {
    const { dir, file } = mkFixture(JSON.stringify(SEED, null, 2) + "\n");
    writeAskStore(dir, basename, [MERCADO_ASK]);
    const before = fs.readFileSync(file, "utf8");

    const r = promote(file, { ask: MERCADO_ASK, venue: "Mercado Example", candidates: MERCADO_CANDIDATES });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.promoted, false, `must stand down when the ask is in ${basename}`);
    assert.equal(out.reason, `canonical_saver_owns_it:${basename}`);
    assert.equal(fs.readFileSync(file, "utf8"), before, "store byte-identical");
  }
});

test("stands down for this stop even under a different ask_id", () => {
  // The saver is keyed on ask_id, but erring toward standing down costs at
  // most a delayed promotion while erring the other way corrupts tier 1.
  const { dir, file } = mkFixture(JSON.stringify(SEED, null, 2) + "\n");
  writeAskStore(dir, RECENT, [{ ...MERCADO_ASK, ask_id: "lc-some-other-id" }]);
  const before = fs.readFileSync(file, "utf8");

  const out = JSON.parse(promote(file, { ask: MERCADO_ASK, venue: "Mercado Example", candidates: MERCADO_CANDIDATES }).stdout);
  assert.equal(out.promoted, false);
  assert.equal(out.reason, `canonical_saver_owns_it:${RECENT}`);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("promotes when pending and recent hold no ask for this stop", () => {
  // The case the backstop exists for: both stores are present and healthy, the
  // ask has simply been pruned out of them, so `location-confirm save` would
  // refuse with exit 2 and the mapping would be lost.
  const { dir, file } = mkFixture(JSON.stringify(SEED, null, 2) + "\n");
  writeAskStore(dir, PENDING, []);
  writeAskStore(dir, RECENT, [{
    ask_id: "lc-20260806-0920-48.86-2.355",
    centroid: { ...fakeAt(0, 0) },
  }]);

  const out = JSON.parse(promote(file, { ask: MERCADO_ASK, venue: "Mercado Example", candidates: MERCADO_CANDIDATES }).stdout);
  assert.equal(out.promoted, true, "an unrelated ask must not block the backstop");
  const after = readStore(file);
  assert.equal(after.length, SEED.length + 1);
  assert.equal(after[after.length - 1].name, "Mercado Example");
});

test("the same place under a new ask_id dedups by centroid proximity", () => {
  const { file } = mkFixture(JSON.stringify(SEED, null, 2) + "\n");
  promote(file, { ask: MERCADO_ASK, venue: "Mercado Example", candidates: MERCADO_CANDIDATES });
  const afterFirst = readStore(file);

  // A later dwell at the same place: different ask_id, centroid a few metres
  // off. This is the path that keeps us from racing `location-confirm save`,
  // which appends with no dedup of its own.
  const laterAsk = {
    ...MERCADO_ASK,
    ask_id: "lc-20260901-1300-25.813--80.191",
    centroid: { ...fakeAt(-8262891.87, -2562751.39) },
  };
  const out = JSON.parse(promote(file, { ask: laterAsk, venue: "mercado example", candidates: MERCADO_CANDIDATES }).stdout);
  assert.equal(out.promoted, false);
  assert.equal(out.reason, "duplicate_centroid_name");
  assert.deepEqual(readStore(file), afterFirst);

  // ...but a different venue at that same centroid is a real, distinct stop.
  const other = JSON.parse(promote(file, {
    ask: { ...laterAsk, ask_id: "lc-20260901-1900-25.813--80.191" },
    venue: "Example Bistro",
    candidates: MERCADO_CANDIDATES,
  }).stdout);
  assert.equal(other.promoted, true);
  assert.equal(readStore(file).length, afterFirst.length + 1);
});

test("a malformed store fails loudly and is left byte-for-byte intact", () => {
  // Truncated mid-array — the shape a crashed non-atomic writer would leave.
  const broken = '[\n  {\n    "ts": "2026-08-06T08:18:09.670589+00:00",\n    "ask_id": "lc-2026';
  const { file } = mkFixture(broken);

  const r = promote(file, { ask: MERCADO_ASK, venue: "Mercado Example", candidates: MERCADO_CANDIDATES });
  assert.notEqual(r.status, 0, "must exit non-zero, not swallow the failure");
  assert.match(r.stderr, /confirmed-stops/, "must say what failed on stderr");
  assert.equal(JSON.parse(r.stdout).promoted, false);
  assert.equal(fs.readFileSync(file, "utf8"), broken, "no data loss: file untouched");
});

test("a store that is valid JSON but the wrong shape is refused, not overwritten", () => {
  const wrong = JSON.stringify({ oops: true }, null, 2) + "\n";
  const { file } = mkFixture(wrong);

  const r = promote(file, { ask: MERCADO_ASK, venue: "Mercado Example", candidates: MERCADO_CANDIDATES });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to overwrite/);
  assert.equal(fs.readFileSync(file, "utf8"), wrong);
});

test("a null-island centroid is refused (si-20260519-05)", () => {
  const { file } = mkFixture(JSON.stringify(SEED, null, 2) + "\n");
  const before = fs.readFileSync(file, "utf8");

  for (const centroid of [{ lat: 0, lon: 0 }, { lat: 25.81, lon: 0 }, {}, { lat: "25.81", lon: "-80.19" }]) {
    const out = JSON.parse(promote(file, {
      ask: { ...MERCADO_ASK, centroid },
      venue: "Mercado Example",
      candidates: MERCADO_CANDIDATES,
    }).stdout);
    assert.equal(out.promoted, false, `centroid ${JSON.stringify(centroid)} must not be persisted`);
    assert.equal(out.reason, "invalid_centroid");
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("a venue that IS a GPS candidate carries that candidate's metadata", () => {
  const { file } = mkFixture(JSON.stringify([], null, 2) + "\n");
  const ask = {
    ...MERCADO_ASK,
    ask_id: "lc-20260822-1230-25.92--80.122",
    centroid: { ...fakeAt(-8248508.72, -2550872.44) },
  };
  const cand = {
    name: "Example Beach Park",
    address: "10800 Oak Ave, Sampleton Beach, ZZ",
    place_id: "ChIJexample",
    primary_type: "park",
    source: "google_places",
  };
  const out = JSON.parse(promote(file, { ask, venue: "Example Beach Park", candidates: [cand] }).stdout);
  assert.equal(out.promoted, true);

  const e = readStore(file)[0];
  assert.equal(e.source, "google_places");
  assert.equal(e.address, cand.address);
  assert.equal(e.place_id, cand.place_id);
  assert.equal(e.primary_type, cand.primary_type);
});

test("a missing store is created rather than treated as an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "location-confirm-promote-"));
  const file = path.join(dir, "confirmed-stops.json");

  const out = JSON.parse(promote(file, { ask: MERCADO_ASK, venue: "Mercado Example", candidates: MERCADO_CANDIDATES }).stdout);
  assert.equal(out.promoted, true);
  assert.equal(readStore(file).length, 1);
});

test("the live confirmed-stops.json is never touched by this test file", () => {
  // Guard against a future edit dropping the env override: every promote()
  // above points at a temp fixture, so the live store must be untouched and
  // still be the array the rest of the system expects.
  // The live store exists only on the mini (gitignored). Elsewhere, "never
  // touched" means it must still not exist after this file ran.
  if (!fs.existsSync(LIVE_STORE)) return;
  const live = JSON.parse(fs.readFileSync(LIVE_STORE, "utf8"));
  assert.ok(Array.isArray(live) && live.length > 0);
  assert.ok(!live.some((e) => e && e.name === "Example Bistro"), "test data must never reach the live store");
});
