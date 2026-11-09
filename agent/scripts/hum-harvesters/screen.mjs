#!/usr/bin/env node
// screen — Movies & TV daily discovery FEEDER (not a pinger).
//
// Once a day it starts `watch-discover --window-days 21 --max 4 --source screen` in the
// background and returns at once. That script owns the whole pipeline (a TMDB sweep of
// new series on the configured services + the model's web search; code enforces TMDB
// match, id dedup incl. rejected, IMDb rating and votes from IMDb's dataset — a show too
// new for a settled rating is judged on its other reviews instead (the review check) —,
// season 1 fully dropped, genre excludes, taste fit, the Jev fit gate). Titles go straight onto
// the list — no approval gate — and the user sees them in the weekly veto digest
// emitted by the `watchlist` lane, where any "not interested" becomes a rejected row
// + feedback. So this lane always emits null.
//
// Why in the background (2026-11-09): the run does a model web search, a few hundred
// TMDB calls and the fit gate, which together outlast this lane's harvest timeout
// (hum-harvest-all gives model lanes 150 s). The run writes its summary straight to
// this lane's cache file (--result-file), so a later tick reports it, and a run that
// ended in an error is not retried for ERROR_TTL_MIN (one failing search must not
// become a search every tick). Output goes to agent/logs/watch-discover.log.
//
// Theatrical-only films are no longer added (v2, 2026-10-04): the list is
// "what to watch at home"; a film joins once it streams.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readStdinJson, readCache, writeCache, emitNull, stampRun } from "./_common.mjs";
const { installTools } = createRequire(import.meta.url)("../../../lib/root.cjs");

const TTL_MIN = 24 * 60;
const ERROR_TTL_MIN = 3 * 60;
const RUN_LOCK_MIN = 30;   // a started run that hasn't written its result yet
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "../../../bin/watch-discover");
const CACHE_FILE = installTools("data/hum-cache/screen.json"); // the file readCache("screen") reads
const LOG = installTools("agent/logs/watch-discover.log");

await readStdinJson();

const fresh = readCache("screen");
if (fresh && fresh.error && fresh._age_min < ERROR_TTL_MIN) {
  stampRun("screen", false);
  emitNull(`last discovery run failed ${fresh._age_min}m ago, retrying after ${ERROR_TTL_MIN}m: ${String(fresh.error).slice(0, 160)}`);
  process.exit(0);
}
if (fresh && !fresh.error && fresh._age_min < TTL_MIN) {
  stampRun("screen", false);
  const held = fresh.held?.length ? `, holding ${fresh.held.length} too new to judge yet` : "";
  emitNull(`cached — searched ${fresh._age_min}m ago (added ${fresh.added?.length ?? 0}${fresh.added?.length ? `: ${fresh.added.map((a) => a.name).join(", ")}` : ""}${held})`);
  process.exit(0);
}

const run = readCache("screen-run");
if (run && run._age_min < RUN_LOCK_MIN) {
  stampRun("screen", false);
  emitNull(`discovery run in progress (started ${run._age_min}m ago)`);
  process.exit(0);
}

try {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const out = fs.openSync(LOG, "a");
  fs.writeSync(out, `\n${new Date().toISOString()} [screen] starting watch-discover\n`);
  const child = spawn(BIN, ["--window-days", "21", "--max", "4", "--source", "screen", "--result-file", CACHE_FILE], {
    detached: true, stdio: ["ignore", out, out],
  });
  // A spawn failure arrives as an event after this lane has answered: record it as the
  // lane's result so the error back-off applies, instead of crashing the harvester.
  child.on("error", (e) => writeCache("screen", { error: `watch-discover failed to start: ${e.message.slice(0, 200)}`, added: [], held: [], skipped: [] }));
  child.unref();
  writeCache("screen-run", { pid: child.pid });
  stampRun("screen", false);
  emitNull(`started discovery run (pid ${child.pid}); results land in the cache for the next tick`);
} catch (e) {
  stampRun("screen", false);
  emitNull(`watch-discover failed to start: ${e.message.slice(0, 200)}`);
}
