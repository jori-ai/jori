// hum-sensor-excursion-stale.test.mjs — the excursion sensor keeps THROWING on
// a stale location feed (blindness stays visible in status) and tags the throw
// with a stable repeat_key, since its message changes every minute ("26m",
// "27m" ...) and the log de-duplicates on the key (hum-sensors.test.mjs). A
// fresh fix at the base raises nothing.
//
// The sensor's one network call (curl to the location table) is a fake `curl`
// first on PATH; the project URL and key are placeholders. No network.
// Run: node --test tests/hum-sensor-excursion-stale.test.mjs

import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { at } from "./fixtures/fake-geo.mjs";

process.env.SUPABASE_URL = "https://project.example.com";
// An empty install root: the sensor reads no real data/ files.
process.env.JORI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "excursion-home-"));

async function excursionWith(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "excursion-test-"));
  const rowsFile = path.join(dir, "rows.json");
  fs.writeFileSync(rowsFile, JSON.stringify(rows));
  fs.writeFileSync(path.join(dir, "curl"), `#!/bin/sh\ncat "${rowsFile}"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key-not-real";
  try {
    const mod = await import(new URL("../agent/scripts/hum-sensors/excursion.mjs", import.meta.url).href);
    return await mod.default({ memo: {}, setMemo: () => {}, nowMs: Date.now() });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.KEY == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The sensor's exec helper puts /opt/homebrew/bin first on PATH; a curl
// installed there would shadow the fake one and reach the network.
const brewCurl = fs.existsSync("/opt/homebrew/bin/curl");
const BASE = at(0, 0);
const row = (minAgo, extra = {}) => ({
  id: minAgo, segment_type: "visit", place_name: "Base", address: null,
  latitude: BASE.lat, longitude: BASE.lon,
  arrived_at: new Date(Date.now() - minAgo * 60000).toISOString(), departed_at: null, ...extra,
});

test("excursion throws on a stale feed, tagged with a stable repeat_key", { skip: brewCurl && "brew curl shadows the stub" }, async () => {
  await assert.rejects(excursionWith([row(50)]), (err) => {
    assert.ok(err.message.startsWith("location feed stale — newest fix is 50m old"), err.message);
    assert.equal(err.repeat_key, "location_feed_stale");
    return true;
  });
});

test("excursion with a fresh fix at base does not throw", { skip: brewCurl && "brew curl shadows the stub" }, async () => {
  const events = await excursionWith([row(2), row(90, { departed_at: new Date(Date.now() - 2 * 60000).toISOString() })]);
  assert.deepEqual(events, []);
});
