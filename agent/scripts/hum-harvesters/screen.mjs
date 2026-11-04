#!/usr/bin/env node
// screen — Movies & TV daily discovery FEEDER (not a pinger).
//
// Runs `watch-discover --window-days 21 --max 4 --source screen` once a day.
// That script owns the whole pipeline (model proposes from the taste profile +
// the user's verdicts; code enforces TMDB match, id dedup incl. rejected, IMDb
// ≥ 7.5, season 1 fully dropped, genre excludes, taste fit). Titles go straight
// onto the list — no approval gate — and the user sees them in the weekly veto
// digest emitted by the `watchlist` lane, where any "not interested" becomes a
// rejected row + feedback. So this lane always emits null.
//
// Theatrical-only films are no longer added (v2, 2026-10-04): the list is
// "what to watch at home"; a film joins once it streams.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinJson, readCache, writeCache, emitNull, stampRun } from "./_common.mjs";

const TTL_MIN = 24 * 60;
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/watch-discover");

await readStdinJson();

const fresh = readCache("screen");
if (fresh && fresh._age_min < TTL_MIN) {
  stampRun("screen", false);
  emitNull(`cached — already searched ${fresh._age_min}m ago (added ${fresh.added?.length ?? 0})`);
  process.exit(0);
}

let res;
try {
  const out = execFileSync(BIN, ["--window-days", "21", "--max", "4", "--source", "screen"], {
    encoding: "utf8", timeout: 300000, maxBuffer: 2 * 1024 * 1024,
  });
  res = JSON.parse(out);
} catch (e) {
  // Don't cache a failure — the next tick retries.
  stampRun("screen", false);
  emitNull(`watch-discover failed: ${e.message.slice(0, 200)}`);
  process.exit(0);
}

if (res.error) {
  stampRun("screen", false);
  emitNull(`watch-discover: ${res.error}`);
  process.exit(0);
}

writeCache("screen", { added: res.added, skipped: res.skipped, proposed: res.proposed });
stampRun("screen", res.added.length > 0);
emitNull(res.added.length
  ? `added ${res.added.length}: ${res.added.map((a) => a.name).join(", ")} (skipped ${res.skipped.length})`
  : `nothing new (proposed ${res.proposed}, skipped ${res.skipped.length})`);
