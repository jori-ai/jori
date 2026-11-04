// stocks harvester: market-hours gate in the exchange's zone, the prior-close
// cache guard, the move threshold — and OFF when no brokerage is connected.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../agent/scripts/hum-harvesters/stocks.mjs");

function run({ broker = true, positions = null, ageH = 1, now = "2026-01-14T15:00:00Z", cfg = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hum-stocks-"));
  const local = path.join(home, "local");
  fs.mkdirSync(path.join(local, "config"), { recursive: true });
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  const cache = path.join(home, "data", "pos.json");
  if (broker) fs.writeFileSync(path.join(local, "config", "investments.json"),
    JSON.stringify({ broker: { api_url: "https://bridge.example", files: { positions_cache: cache } } }));
  fs.writeFileSync(path.join(local, "config", "hum-stocks.json"), JSON.stringify({ market_tz: "Etc/GMT+5", ...cfg }));
  if (positions) {
    fs.writeFileSync(cache, JSON.stringify(positions));
    const t = (Date.parse(now) - ageH * 3.6e6) / 1000;
    fs.utimesSync(cache, t, t);
  }
  const r = spawnSync(process.execPath, [BIN], { input: "{}", encoding: "utf8",
    env: { ...process.env, HOME: home, JORI_HOME: home, JORI_LOCAL_DIR: local, JORI_DATA_DIR: path.join(home, "data"), HUM_STOCKS_NOW: now } });
  fs.rmSync(home, { recursive: true, force: true });
  const line = r.stdout.trim().split("\n").at(-1);
  return { out: line === "null" || !line ? null : JSON.parse(line), err: r.stderr };
}

const POS = [{ symbol: "AAA", day_change_pct: 1.2 }, { symbol: "BBB", day_change_pct: -3.4 }];

test("a 2%+ move inside market hours from a fresh cache is a candidate", () => {
  const { out } = run({ positions: POS });              // 10:00 at UTC-5, a Wednesday
  assert.equal(out.topic, "stocks");
  assert.match(out.signal, /BBB down 3\.4% today/);
});

test("outside market hours, a weekend, a stale cache, or a small move: nothing", () => {
  assert.equal(run({ positions: POS, now: "2026-01-14T22:00:00Z" }).out, null);
  assert.equal(run({ positions: POS, now: "2026-01-17T15:00:00Z" }).out, null);
  assert.equal(run({ positions: POS, ageH: 20 }).out, null);
  assert.equal(run({ positions: POS, cfg: { min_move_pct: 5 } }).out, null);
});

test("no brokerage connected is OFF, not broken", () => {
  const r = run({ broker: false, positions: POS });
  assert.equal(r.out, null);
  assert.match(r.err, /no brokerage connected/);
});
