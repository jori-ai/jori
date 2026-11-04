// stay-sync.mjs — "a stay changed": run bin/stay-calendar now.
//
// Sent by the rental portfolio's side the moment something that decides a
// check-in or check-out changes — the hub right after its channel-manager
// webhook syncs a reservation, and the Firestore trigger on `leases` /
// `tenants`. The ping is a NOTIFICATION, never data: whatever it says, the run
// re-reads the channel manager and Firestore itself, so a forged or stale ping can cause at most one extra
// reconcile of a calendar that is already right.
//
// DETERMINISTIC, like plaid-webhook.mjs: no agent, no model spend. The cron
// (every 15 min) stays on as the safety net for a ping that never arrives.
//
// Coalescing: a lease signing writes several documents in a burst, and each
// fires the trigger. One run per burst (debounce), and a ping that lands while
// a run is in flight marks it dirty so it re-runs once afterwards — never
// dropped, never two runs at once.

import fs from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { installTools } = require("../../lib/root.cjs");
const BIN = installTools("bin/stay-calendar");
const LOGFILE = installTools("agent/logs/stay-calendar.log");
const OFF = installTools("data/.stay-calendar-off");

const DEBOUNCE_MS = 5000;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

const st = { running: false, dirty: false, timer: null };

function log(line) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  try { fs.appendFileSync(LOGFILE, `${stamp} [stay-sync] ${line}\n`); } catch { /* stderr still has it */ }
  console.error(`[stay-sync] ${line}`);
}

function run() {
  st.running = true;
  st.dirty = false;
  execFile(process.execPath, [BIN, "--json"], { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) log(`run FAILED: ${err.message.split("\n")[0]}`);
    else log(`run ok ${String(stdout).trim().slice(0, 300)}`);
    st.running = false;
    if (st.dirty) schedule("coalesced");
  });
}

function schedule(reason) {
  if (st.running) { st.dirty = true; return; }
  if (st.timer) return;
  st.timer = setTimeout(() => { st.timer = null; run(); }, DEBOUNCE_MS);
  if (st.timer.unref) st.timer.unref();
  log(`scheduled (${reason})`);
}

/**
 * Act on an authenticated ping. Never throws, never blocks — the caller acks
 * first. `body` is only logged (source + kind + id), never trusted.
 */
export function handleStaySync(body) {
  if (fs.existsSync(OFF)) { log("kill switch present, ignoring ping"); return { action: "killswitch" }; }
  const clean = (v) => String(v ?? "").replace(/[^\w:.\-]/g, "").slice(0, 80);
  schedule(`${clean(body?.source) || "unknown"} ${clean(body?.kind)} ${clean(body?.id)}`.trim());
  return { action: "scheduled" };
}
