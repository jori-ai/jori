// local-history-live.mjs — the pure parts of the live local-history lane
// (bin/local-history-live), plus the state file other code reads.
//
// The hum `nearby` lane waits for a hum-sense event, the 10-minute gate
// refractory and a full hum turn, and works from location_history, which the
// app batches; measured median ~6 min from the moment to the ping (2026-11-06),
// by which time the user had walked past. The live lane listens to the phone's
// own position (live_position, ~30 s while out) and sends within seconds, only
// for a subject within LIVE_RADIUS_M — within sight, not within 300 m.

import fs from "node:fs";
import path from "node:path";
import { installTools } from "./root.cjs";
import { haversineM } from "./local-history-ledger.mjs";

const DATA = installTools("data");
export const STATE_PATH = process.env.LOCAL_HISTORY_LIVE_STATE || path.join(DATA, "local-history-live-state.json");
export const LOG_PATH = process.env.LOCAL_HISTORY_LIVE_LOG || path.join(DATA, "local-history-live.jsonl");
export const OFF_SWITCH = path.join(DATA, ".local-history-live-off");

/** Within sight on a city street. The subject must be this close at the fix. */
export const LIVE_RADIUS_M = 80;
/** …and still this close at the newest fix just before sending. */
export const SEND_RADIUS_M = 120;
/** A fix coarser than this cannot say which building the user is next to. */
export const MAX_ACCURACY_M = 65;
/** A fix older than this is not "now". */
export const MAX_FIX_AGE_S = 120;
/** Re-evaluate only after this much movement… */
export const MIN_MOVE_M = 20;
/** …or this long standing in one place. */
export const IDLE_REEVAL_S = 300;
/** Local hours with no pings, start inclusive, end exclusive. */
export const QUIET_HOURS = { start: 0, end: 7 };

function num(v) {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
}

/** A live_position row → a position, or null. */
export function positionFromRow(row) {
  const lat = num(row?.latitude), lon = num(row?.longitude);
  const t = Date.parse(row?.ts || "");
  if (lat == null || lon == null || !Number.isFinite(t)) return null;
  return { lat, lon, accuracy_m: num(row?.accuracy_m), motion: row?.motion || null, at: new Date(t).toISOString(), device_id: row?.device_id || null };
}

/**
 * Is this position worth an evaluation? Pure.
 * @returns {{ok: boolean, reason: string}}
 */
export function shouldEvaluate(pos, last, { nowMs = Date.now(), hour = null } = {}) {
  if (!pos) return { ok: false, reason: "no position" };
  const ageS = (nowMs - Date.parse(pos.at)) / 1000;
  if (ageS > MAX_FIX_AGE_S) return { ok: false, reason: `fix is ${Math.round(ageS)}s old` };
  if (pos.accuracy_m != null && pos.accuracy_m > MAX_ACCURACY_M) return { ok: false, reason: `accuracy ${Math.round(pos.accuracy_m)}m` };
  if (hour != null && hour >= QUIET_HOURS.start && hour < QUIET_HOURS.end) return { ok: false, reason: `quiet hours (${hour}:00)` };
  if (last) {
    const moved = haversineM(pos.lat, pos.lon, last.lat, last.lon);
    const gapS = (Date.parse(pos.at) - Date.parse(last.at)) / 1000;
    if (Number.isFinite(gapS) && gapS <= 0) return { ok: false, reason: "not newer than the last evaluated fix" };
    if (moved < MIN_MOVE_M && gapS < IDLE_REEVAL_S) return { ok: false, reason: `moved ${Math.round(moved)}m in ${Math.round(gapS)}s` };
  }
  return { ok: true, reason: "fresh fix" };
}

/** The subjects close enough to point at, nearest first, with something to say. Pure. */
export function withinSight(items, radiusM = LIVE_RADIUS_M) {
  return (items || [])
    .filter((i) => Number.isFinite(i.distance_m) && i.distance_m <= radiusM)
    .filter((i) => i.summary || Object.keys(i.facts || {}).length);
}

export function readState(p = STATE_PATH) {
  try { const j = JSON.parse(fs.readFileSync(p, "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}

export function writeState(patch, p = STATE_PATH) {
  const next = { ...readState(p), ...patch };
  const tmp = `${p}.tmp.${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n"); fs.renameSync(tmp, p); } catch { /* state is advisory */ }
  return next;
}

export function appendLog(rec, p = LOG_PATH) {
  try { fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n"); } catch { /* log is advisory */ }
}

/**
 * Does the live lane own local history right now? True while its daemon is
 * alive AND the phone has fed it a position recently — then the hum `nearby`
 * lane stands down rather than repeat the work minutes later. Otherwise (old
 * app build, daemon down, switched off) the hum lane is the fallback.
 */
export function liveLaneActive({ nowMs = Date.now(), state = null, offSwitch = OFF_SWITCH } = {}) {
  if (fs.existsSync(offSwitch)) return { active: false, reason: "switched off" };
  const s = state || readState();
  const hb = Date.parse(s.heartbeat_at || "");
  if (!Number.isFinite(hb) || nowMs - hb > 3 * 60_000) return { active: false, reason: "daemon not running" };
  const lp = Date.parse(s.last_position_at || "");
  if (!Number.isFinite(lp) || nowMs - lp > 15 * 60_000) return { active: false, reason: "no live position from the phone in 15 min" };
  return { active: true, reason: `daemon up, phone position ${Math.round((nowMs - lp) / 1000)}s old` };
}
