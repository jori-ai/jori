// photo-probe — ask the PHONE for the photos it took during a stop, instead of
// waiting for iCloud to carry them to the host.
//
// The app checks the phone's photo roll for the time period a question covers,
// and does not wait for those photos to sync to the host: a lunch's photos
// (GPS metres from the restaurant) once reached the host's library 16 minutes
// after a question asked which of four nearby shops the user had been at.
//
// Flow:
//   1. requestProbe inserts a `photo_probes` row for the window and sends a
//      silent push {"aps":{"content-available":1},"kind":"photo_probe","probe_id"}.
//   2. The app looks in the photo roll for the window, upserts each photo into
//      `photos` (same uuid as the mini's osxphotos sync, plus ocr_lines and
//      device_venue), uploads daily-photos/thumbs/<uuid>.jpg, and marks the
//      probe done with photo_count and uuids.
//   3. Callers read `photos` as they already do.
//
// iOS may delay or drop a background push, and the app also checks for pending
// probes whenever it runs. A probe nobody answers is not an error: callers get
// status 'pending' and decide whether to hold or go on. 'unavailable' (no iOS
// token, every send failed, or a REST error) means don't wait at all.
// Schema: data/migrations/20261008_photo_probes.sql.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { supabaseUrl } = require("./instance.cjs");
const { installRoot, installTools } = require("./root.cjs");
const ENV_FILE = path.join(installRoot(), ".env");
export const LOG = installTools("data", "photo-probe-log.jsonl");

/** A probe for the same visit whose window ends within this of ours is the same question. */
export const SAME_WINDOW_MS = 2 * 60000;
/** Poll interval while waiting for the phone. */
export const POLL_MS = 3000;
/** A probe still pending after this long is marked expired. */
export const EXPIRE_MS = 6 * 3600000;

export function envValue(k) {
  if (process.env[k]) return process.env[k];
  try {
    const m = fs.readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${k}=(.+)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}

// SUPABASE_URL (environment or .env), else the instance's project.
export const SUPABASE_URL = envValue("SUPABASE_URL") || supabaseUrl();

const iso = (t) => new Date(t).toISOString();
const q = encodeURIComponent;

export function log(row) {
  try { fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n"); } catch {}
}

/** Default dependencies; tests pass their own. */
function defaults(d = {}) {
  return {
    fetch: d.fetch || globalThis.fetch,
    now: d.now || (() => Date.now()),
    sleep: d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    push: d.push || null,
    key: d.key || null,
  };
}

async function sb(deps, pathQs, init = {}) {
  const key = deps.key || envValue("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("no SUPABASE_SERVICE_ROLE_KEY");
  const r = await deps.fetch(`${SUPABASE_URL}/rest/v1/${pathQs}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  if (init.method === "PATCH" && !(init.headers || {}).Prefer?.includes("representation")) return null;
  return r.json();
}

/** Minimal supabase-js stand-in for sendSilentPush (it only reads device_tokens). */
function tokenReader(deps) {
  return {
    from: (table) => ({
      select: async (cols) => {
        try { return { data: await sb(deps, `${table}?select=${q(cols)}`), error: null }; }
        catch (e) { return { data: null, error: { message: String(e.message || e) } }; }
      },
    }),
  };
}

async function defaultPush(deps, data) {
  const { sendSilentPush } = await import("./apns-push.mjs");
  return sendSilentPush(tokenReader(deps), data);
}

/** Is an existing probe row an answer to (or still on its way to answering) this window? */
export function reusable(row, end) {
  if (!row) return false;
  const we = Date.parse(row.window_end);
  if (!(Math.abs(we - end) <= SAME_WINDOW_MS)) return false;
  if (row.status === "pending") return true;
  if (row.status === "done") return !!row.answered_at && Date.parse(row.answered_at) >= end;
  return false;
}

/**
 * Create a probe for the window (or reuse one), and wake the phone.
 * @returns {Promise<{id, status, requested_at, reused, push?}>}
 */
export async function requestProbe({ visitId, start, end }, d = {}) {
  const deps = defaults(d);
  const s = Date.parse(iso(start)), e = Date.parse(iso(end));
  if (!(e > s)) throw new Error("window has no length");
  await expireStale(deps).catch(() => {});
  if (visitId) {
    const rows = await sb(deps, `photo_probes?visit_id=eq.${q(visitId)}&status=in.(pending,done)`
      + `&select=id,status,requested_at,answered_at,window_end,photo_count&order=requested_at.desc&limit=10`);
    const hit = rows.find((r) => reusable(r, e));
    if (hit) return { id: hit.id, status: hit.status, requested_at: hit.requested_at, reused: true };
  }
  const [row] = await sb(deps, "photo_probes", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ visit_id: visitId || null, window_start: iso(s), window_end: iso(e) }),
  });
  let push;
  try { push = await (deps.push ? deps.push({ kind: "photo_probe", probe_id: row.id }) : defaultPush(deps, { kind: "photo_probe", probe_id: row.id })); }
  catch (err) { push = { delivered: false, reason: String(err.message || err) }; }
  return { id: row.id, status: row.status, requested_at: row.requested_at, reused: false, push };
}

/** Poll until the probe leaves `pending` or the timeout passes. Returns the row. */
export async function waitProbe(id, { timeoutMs = 45000 } = {}, d = {}) {
  const deps = defaults(d);
  const until = deps.now() + timeoutMs;
  for (;;) {
    const [row] = await sb(deps, `photo_probes?id=eq.${q(id)}&select=*&limit=1`);
    if (!row) throw new Error(`no probe ${id}`);
    if (row.status !== "pending" || deps.now() >= until) return row;
    await deps.sleep(Math.min(POLL_MS, Math.max(0, until - deps.now())));
  }
}

/** Mark probes pending for over EXPIRE_MS as expired (nobody is answering them). */
export async function expireStale(d = {}) {
  const deps = defaults(d);
  await sb(deps, `photo_probes?status=eq.pending&requested_at=lt.${q(iso(deps.now() - EXPIRE_MS))}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "expired" }),
  });
}

/**
 * Ask the phone for the window's photos and wait briefly for the answer.
 * @returns {Promise<{status: 'done'|'pending'|'error'|'unavailable', id?, age_min?, photo_count?, answered_at?, reason?}>}
 */
export async function probeForWindow({ visitId, start, end, waitMs = 45000 }, d = {}) {
  const deps = defaults(d);
  let req;
  try { req = await requestProbe({ visitId, start, end }, deps); }
  catch (e) {
    const out = { status: "unavailable", reason: String(e.message || e).slice(0, 200) };
    log({ visit_id: visitId, window: { start: iso(start), end: iso(end) }, ...out });
    return out;
  }
  const base = { id: req.id, reused: req.reused };
  if (!req.reused && req.push && !req.push.delivered) {
    // Nothing woke the phone. Leave the row: the app still answers it the next
    // time it runs. The caller just shouldn't wait.
    const out = { ...base, status: "unavailable", reason: `push not delivered: ${req.push.reason || "unknown"}`, age_min: 0 };
    log({ visit_id: visitId, window: { start: iso(start), end: iso(end) }, ...out, push: req.push });
    return out;
  }
  let row;
  try { row = req.status === "pending" ? await waitProbe(req.id, { timeoutMs: waitMs }, deps) : null; }
  catch (e) { row = null; base.reason = String(e.message || e).slice(0, 200); }
  if (!row) {
    const [r] = await sb(deps, `photo_probes?id=eq.${q(req.id)}&select=*&limit=1`).catch(() => [null]);
    row = r;
  }
  if (!row) {
    const out = { ...base, status: "unavailable", reason: base.reason || "probe row vanished" };
    log({ visit_id: visitId, window: { start: iso(start), end: iso(end) }, ...out });
    return out;
  }
  const status = row.status === "expired" ? "pending" : row.status;
  const out = {
    ...base, status,
    age_min: Math.round((deps.now() - Date.parse(row.requested_at)) / 6000) / 10,
    photo_count: row.photo_count ?? null,
    answered_at: row.answered_at ?? null,
    ...(row.error ? { reason: row.error } : {}),
    ...(req.push ? { push: { ok: req.push.ok, sent: req.push.sent } } : {}),
  };
  log({ visit_id: visitId, window: { start: iso(start), end: iso(end) }, ...out });
  return out;
}
