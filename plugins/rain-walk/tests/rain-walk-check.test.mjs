// rain-walk-check.test.mjs — configured walk windows against a stub forecast;
// off (exit 0, no ping) on a fresh install.
//
// Run: node --test tests/rain-walk-check.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "bin/rain-walk-check");

function todayIn(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// A fake install: bin/apple-weather prints a forecast with rain at 15:00–16:00
// local; bin/jori-send-curl records what it was asked to send.
function fakeInstall() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainwalk-home-"));
  fs.mkdirSync(path.join(home, "bin"));
  const tz = "UTC";
  const day = todayIn(tz);
  const hours = [];
  for (let h = 0; h < 24; h++) {
    hours.push({
      forecastStart: `${day}T${String(h).padStart(2, "0")}:00:00Z`,
      precipitationChance: h === 15 ? 0.7 : 0.05,
      precipitationType: h === 15 ? "rain" : "clear",
    });
  }
  const forecast = { forecastHourly: { metadata: { timezone: tz }, hours } };
  fs.writeFileSync(path.join(home, "forecast.json"), JSON.stringify(forecast));
  fs.writeFileSync(path.join(home, "bin/apple-weather"), `#!/bin/sh\ncat "${path.join(home, "forecast.json")}"\n`, { mode: 0o755 });
  const sent = path.join(home, "sent.txt");
  fs.writeFileSync(path.join(home, "bin/jori-send-curl"), `#!/bin/sh\nprintf '%s' "$1" > "${sent}"\n`, { mode: 0o755 });
  return { home, sent };
}

function localWith(windows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rainwalk-local-"));
  if (windows) {
    fs.mkdirSync(path.join(dir, "config"));
    fs.mkdirSync(path.join(dir, "rain-walk"));
    fs.writeFileSync(path.join(dir, "config/rain-walk.json"), JSON.stringify({ windows_file: "rain-walk/windows.json" }));
    fs.writeFileSync(path.join(dir, "rain-walk/windows.json"), JSON.stringify(windows));
  }
  return dir;
}

function run(args, home, local) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, JORI_HOME: home, JORI_LOCAL_DIR: local }, encoding: "utf8",
  });
}

const WINDOWS = {
  heading: "Rain vs walks today:",
  order: ["morning", "afternoon"],
  windows: {
    morning: { label: "morning walk", start_h: 8, end_h: 9 },
    afternoon: { label: "afternoon walk", start_h: 15, end_h: 16 },
  },
};

test("a fresh install checks nothing and sends nothing", () => {
  const { home, sent } = fakeInstall();
  const r = run(["--summary"], home, localWith(null));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no walk windows configured/);
  assert.equal(fs.existsSync(sent), false);
});

test("the summary names only the window the rain overlaps", () => {
  const { home, sent } = fakeInstall();
  const r = run(["--summary"], home, localWith(WINDOWS));
  assert.equal(r.status, 0, r.stderr);
  const msg = fs.readFileSync(sent, "utf8");
  assert.match(msg, /^Rain vs walks today:/);  // lang-regex-ok: checks the code-composed alert text
  assert.match(msg, /afternoon walk \(3pm–4pm\): rain likely, starts ~3pm \(peak 70%\)/);  // lang-regex-ok: checks the code-composed alert text
  assert.doesNotMatch(msg, /morning walk/);
});

test("a dry window stays silent; a wet one pings with the prewalk wording", () => {
  const dry = fakeInstall();
  assert.equal(run(["--window", "morning", "--prewalk"], dry.home, localWith(WINDOWS)).status, 0);
  assert.equal(fs.existsSync(dry.sent), false);
  const wet = fakeInstall();
  assert.equal(run(["--window", "afternoon", "--prewalk"], wet.home, localWith(WINDOWS)).status, 0);
  assert.match(fs.readFileSync(wet.sent, "utf8"), /^Heads up — rain expected during afternoon walk/);
});

test("an unknown window is a usage error naming the configured keys", () => {
  const { home } = fakeInstall();
  const r = run(["--window", "noon"], home, localWith(WINDOWS));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /<morning\|afternoon>/);
});
