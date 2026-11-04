// filing-watch: a hit counts only when the watched company is the FILER — by
// exact CIK when one is known, else by name with a boundary — and an
// unconfigured install does nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const BIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../bin/filing-watch");
const { isFiler, SIGNAL_FORMS } = require(BIN);

test("a mention in someone else's filing is not a signal", () => {
  const hit = { filers: ["Other Bio Inc (CIK 0000000001)"], ciks: ["0000000001"] };
  assert.equal(isFiler(hit, { name: "Example Robotics" }), false);
});

test("the company as filer, by name with a boundary", () => {
  assert.equal(isFiler({ filers: ["Example Robotics, Inc."] }, { name: "Example Robotics" }), true);
  assert.equal(isFiler({ filers: ["Example Roboticsworks Ltd"] }, { name: "Example Robotics" }), false);
  assert.equal(isFiler({ filers: ["ExRo Holdings"] }, { name: "Example Robotics", aka: ["ExRo"] }), true);
});

test("a known CIK is the only test — a similarly named SPAC does not match", () => {
  const company = { name: "Target Co", edgar_ciks: ["0001234567"] };
  assert.equal(isFiler({ filers: ["Vehicle Capital Corp XI"], ciks: ["1234567"] }, company), true);
  assert.equal(isFiler({ filers: ["Vehicle Capital Corp XIII"], ciks: ["7654321"] }, company), false);
  assert.equal(isFiler({ filers: ["Target Co"], ciks: ["7654321"] }, company), false);
});

test("exhibits are not going-public forms", () => {
  assert.ok(SIGNAL_FORMS.has("S-1/A"));
  assert.ok(!SIGNAL_FORMS.has("EX-99.1"));
});

test("unconfigured install is OFF, not broken (no network)", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "filing-watch-"));
  const r = spawnSync(process.execPath, [BIN, "--dry-run"], { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: local } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not configured/);
});

test("--list reads a configured watchlist without the network", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "filing-watch-"));
  fs.mkdirSync(path.join(local, "config"));
  const wl = path.join(local, "wl.json");
  fs.writeFileSync(wl, JSON.stringify({ buckets: { near: "Close to listing" },
    companies: [{ id: "x", name: "Example Robotics", bucket: "near", ticker_proxy: "EXR", valuation: { confirmed: 2.5e9 } }] }));
  fs.writeFileSync(path.join(local, "config", "filing-watch.json"), JSON.stringify({ watchlist_file: wl, label: "test list" }));
  const r = spawnSync(process.execPath, [BIN, "--list"], { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: local } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /test list/);
  assert.match(r.stdout, /Example Robotics\s+EXR\s+\$2\.5B/);
});
