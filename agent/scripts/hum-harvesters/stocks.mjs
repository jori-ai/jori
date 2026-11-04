#!/usr/bin/env node
// stocks — hum harvester for a meaningful single-name move in the user's own
// brokerage positions. Emits only during market hours, and only from a
// positions cache fresh enough that its day-change is today's.
//
// Reads the positions cache the kernel's read-only brokerage snapshot writes
// (bin/broker-snapshot → `broker.files.positions_cache` in
// agent/local/config/investments.json). No broker connected (no `broker.api_url`)
// = OFF: a null candidate, never an error.
//
// Config: agent/local/config/hum-stocks.json
//   market_tz       the exchange's zone ("" = the installation's tz)
//   open / close    session hours in market_tz, "HH:MM"
//   min_move_pct    smallest absolute day move worth a candidate
//   max_cache_age_h older than this, the cache is the prior close — stay quiet
import fs from "node:fs";
import { createRequire } from "node:module";
import { readStdinJson, emit, emitNull, stampRun, writeTopicState, localConfig } from "./_common.mjs";

const require = createRequire(import.meta.url);
const { brokerConfig, brokerFile } = require("../../../lib/broker-config.cjs");
const { instance } = require("../../../lib/instance.cjs");

const { situation: sit, context } = await readStdinJson(); void sit; void context;

const cfg = localConfig("hum-stocks", { market_tz: "", open: "09:30", close: "16:00", min_move_pct: 2, max_cache_age_h: 8 });
const broker = brokerConfig();
if (!broker.api_url) {
  stampRun("stocks", false);
  emitNull("no brokerage connected");
  process.exit(0);
}

// Market-hours gate, in the exchange's zone. HUM_STOCKS_NOW pins the clock (tests).
const now = process.env.HUM_STOCKS_NOW ? new Date(process.env.HUM_STOCKS_NOW) : new Date();
const tz = cfg.market_tz || instance().tz;
const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };
const nowMin = local.getHours() * 60 + local.getMinutes();
const day = local.getDay(); // 0=Sun 6=Sat
if (day === 0 || day === 6 || nowMin < hm(cfg.open) || nowMin >= hm(cfg.close)) {
  // Stamp the run even when we no-op outside market hours so hum-review can
  // distinguish "harvester never ran" from "harvester ran and silenced itself."
  stampRun("stocks", false);
  emitNull("outside market hours");
  process.exit(0);
}

const cachePath = brokerFile("positions_cache", broker);
let positions = null;
let positionsAgeMs = null;
try {
  positions = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  positionsAgeMs = now.getTime() - fs.statSync(cachePath).mtimeMs;
} catch {}

if (!positions) {
  // Record the data-pipeline gap so hum-review notices "silent all week"
  // means "the cache file never lands", not "no interesting moves".
  stampRun("stocks", false);
  writeTopicState("stocks", { last_data_at: null, last_data_gap_reason: "no cached positions file" });
  emitNull("no cached positions");
  process.exit(0);
}

writeTopicState("stocks", { last_data_at: new Date(now.getTime() - positionsAgeMs).toISOString() });

// The snapshot is daily AFTER close, so during market hours the cache holds the
// PRIOR close — its day_change_pct is yesterday's. Emitting it would claim a
// stale move is today's, so require a cache younger than max_cache_age_h.
if (positionsAgeMs > cfg.max_cache_age_h * 3.6e6) {
  stampRun("stocks", false);
  emitNull(`positions cache is ${(positionsAgeMs / 3.6e6).toFixed(1)}h old (prior close — no intraday feed)`);
  process.exit(0);
}

// Normalize: an array of {symbol, day_change_pct, current_value} or similar.
const list = Array.isArray(positions) ? positions : (positions.positions || []);
let top = null;
for (const p of list) {
  const pct = Number(p.day_change_pct ?? p.dayChangePct ?? p.day_pct ?? 0);
  if (!Number.isFinite(pct)) continue;
  if (!top || Math.abs(pct) > Math.abs(top.pct)) top = { symbol: p.symbol || p.ticker, pct, value: p.current_value || p.market_value };
}

if (!top || Math.abs(top.pct) < cfg.min_move_pct) {
  stampRun("stocks", false);
  emitNull(`top move ${top ? top.pct.toFixed(2) + "%" : "nil"}, below ${cfg.min_move_pct}% threshold`);
  process.exit(0);
}

const dir = top.pct >= 0 ? "up" : "down";
stampRun("stocks", true);
emit({
  topic: "stocks",
  signal: `${top.symbol} ${dir} ${Math.abs(top.pct).toFixed(1)}% today`,
  urgency: Math.min(0.9, Math.abs(top.pct) / 10),
  freshness_min: 0,
  dedup_key: `stocks:${top.symbol}:${now.toISOString().slice(0, 10)}`,
  supporting_data: { top, positions_count: list.length },
});
