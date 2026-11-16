// triage-route.mjs — send per-message Gmail triage dispatches to the ops-light
// supervisor instead of the ops session (part of a determinism pass).
//
// Why. gmail-source runs inside the ops supervisor (it owns the Pub/Sub port),
// so every triage dispatch used to land in the ops session: Sonnet at --effort
// xhigh with the Chrome MCP and the biggest floor. A per-message triage turn
// needs none of that — the dispatch already carries the body, headers, Jev's
// verdict and the sender history, and the agent reads `triage-rules core` + one
// section. ops-light runs the same model and the same CLAUDE.md (its cwd
// symlinks ops-agent/CLAUDE.md) at --effort medium, with no Chrome.
//
// What moves. Only the per-message triage items gmail-source hands to
// `_dispatchTriage` (source `gmail:<messageId>`). Everything else gmail-source
// dispatches — batch catch-up, history-expired recovery, storm consolidation,
// periodic catch-up — and any mail addressed to Jori itself (the command
// channel, which may need Chrome or a long multi-step turn) stays on ops.
//
// Idempotency and counters are unchanged: gmail-source records the dispatch
// attempt (lib/dispatch-attempts.mjs) BEFORE calling us, and the
// RECLASSIFY flap counter lives in the shared reclassify-tracking.json that
// every tier's dispatcher reads. The ops-light ledger attributes cost under the
// same `gmail:<id>` source, and jori-cost-report unions both ledgers.
//
// Fails toward delivery: if ops-light is unhealthy, or the POST fails, the item
// goes to the local (ops) dispatcher exactly as before. Never drop an email.
//
// Config (agents.json → ops.gmailTriageTarget, overridden by the installation's
// agent/local/config/agents.json `gmail_triage_target`): "ops-light" (default)
// | "ops" | "strict" | "strict-shadow". Read at supervisor start. Rollback: set
// it to "ops" and restart the ops supervisor.
//
// "strict" (2026-11-16): each per-message item first runs the strict one-shot
// (bin/email-triage-run: no shell, web or browser; tools bound to the one email;
// agent/ops-agent/jobs/email-triage-strict.md). When it does not finish — no
// answer, a timeout, no triage action, or STRICT_MAX already running — the item
// goes to ops-light exactly as before, with a note of what the one-shot already
// did. Never drops an email: each run leaves a marker in
// data/triage-strict-pending/ until it ends, and a marker older than
// PENDING_STALE_MS (a supervisor restart mid-run) is dispatched to ops-light.
//
// "strict-shadow": triage stays on ops-light as before, and each per-message
// item ALSO runs the one-shot in dry run (nothing changes), started alongside
// the dispatch. bin/email-triage-report scores those runs against the
// recorded decisions — the evidence for "strict".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = path.join(ROOT, "bin", "email-triage-run");
export const STRICT_MAX = 3;
export const PENDING_DIR = path.join(ROOT, "data", "triage-strict-pending");
export const PENDING_STALE_MS = 11 * 60 * 1000;   // past the runner's 9-minute cap

// Run the strict one-shot for one email. Resolves { ok, actions, why }; never rejects.
export function runStrictOneShot(packet, { timeoutMs = 9 * 60 * 1000, dry = false } = {}) {
  return new Promise((resolve) => {
    let f;
    try {
      f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "triage-strict-")), "payload.json");
      fs.writeFileSync(f, JSON.stringify(packet));
    } catch (e) { return resolve({ ok: false, actions: [], why: `payload: ${e.message}` }); }
    const args = [RUNNER, "--payload", f, ...(dry ? ["--dry-run"] : [])];
    const env = dry ? { ...process.env, EMAIL_TRIAGE_MODE: "shadow" } : process.env;
    execFile(process.execPath, args, { timeout: timeoutMs, maxBuffer: 1 << 20, env }, (err, stdout) => {
      try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch {}
      let r = null;
      try { r = JSON.parse(String(stdout || "").trim().split("\n").pop()); } catch {}
      if (r && r.ok === true && !err) return resolve(r);
      resolve({ ok: false, actions: r?.actions || [], why: r?.why || err?.message || "no result" });
    });
  });
}

/** The note an ops-light fallback carries when the one-shot already acted. */
export function strictFallbackNote(r) {
  const done = (r?.actions || []).filter((a) => !a.dry && !a.failed).map((a) => a.summary || a.tool).filter(Boolean);
  if (!done.length) return "";
  return `\n\n[triage-route] A strict triage one-shot ran first and stopped (${r.why || "no result"}). It already did: ${done.join("; ")}. Do not repeat those; finish the rest.`;
}

// The installation's own choice wins (agent/local/config/agents.json
// `gmail_triage_target`), so trying "strict-shadow" or "strict" is not a kernel edit.
export function localTriageTarget() {
  try {
    const { localConfig } = createRequire(import.meta.url)("../../lib/instance.cjs");
    return localConfig("agents", {}).gmail_triage_target;
  } catch { return undefined; }
}

export function triageTargetFromConfig(agentsConfig, { selfAgent = "ops", local = localTriageTarget() } = {}) {
  const self = agentsConfig?.agents?.[selfAgent] || {};
  const configured = local != null ? local : self.gmailTriageTarget === undefined ? "ops-light" : self.gmailTriageTarget;
  const strict = configured === "strict";
  const shadow = configured === "strict-shadow";
  const target = strict || shadow ? "ops-light" : configured;
  if (!target || target === selfAgent) return null;
  const sup = agentsConfig?.agents?.[target]?.supervisor;
  if (!sup?.webhookPort || !sup?.healthPort) return null;
  const t = { agent: target, webhookPort: sup.webhookPort, healthPort: sup.healthPort, ...(strict ? { strict: true } : {}), ...(shadow ? { shadow: true } : {}) };
  // Hidden marker: this target follows the installation's config live (makeTriageRouter readMode).
  Object.defineProperty(t, "fromConfig", { value: true, enumerable: false });
  return t;
}

export function makeTriageRouter({
  target,                 // { agent, webhookPort, healthPort } | null
  localDispatch,          // (content, source) => any — the ops dispatcher
  tokenFile,
  fetchFn = globalThis.fetch,
  readFile = (p) => fs.readFileSync(p, "utf8"),
  log = () => {},
  timeoutMs = 5000,
  runStrict = runStrictOneShot,   // the strict one-shot (target.strict / target.shadow)
  strictMax = STRICT_MAX,
  pendingDir = PENDING_DIR,
  sweepEveryMs = 5 * 60 * 1000,
  now = () => Date.now(),
  // The installation's choice, re-read per email (cached 30 s), so switching
  // between ops-light / strict-shadow / strict needs no supervisor restart.
  // null = keep the mode the router was built with (tests, other callers).
  readMode = localTriageTarget,
}) {
  let modeCache = { at: -Infinity, mode: undefined };
  function currentTarget() {
    if (!target || !readMode || !target.fromConfig) return target;
    if (now() - modeCache.at > 30_000) {
      let m; try { m = readMode(); } catch { m = undefined; }
      modeCache = { at: now(), mode: m };
    }
    const m = modeCache.mode;
    if (m === undefined || m === null) return target;
    if (m === "ops") return null;                      // rollback: this supervisor's own dispatcher
    const { strict: _s, shadow: _h, ...base } = target;
    return { ...base, ...(m === "strict" ? { strict: true } : {}), ...(m === "strict-shadow" ? { shadow: true } : {}) };
  }
  let strictInFlight = 0;
  const marker = (source) => path.join(pendingDir, `${String(source).replace(/[^A-Za-z0-9:_-]/g, "_")}.json`); // lang-regex-ok: file-name sanitising
  const putMarker = (source, content, packet) => {
    try { fs.mkdirSync(pendingDir, { recursive: true }); fs.writeFileSync(marker(source), JSON.stringify({ ts: now(), source, content, packet })); } catch {}
  };
  const dropMarker = (source) => { try { fs.rmSync(marker(source), { force: true }); } catch {} };
  const token = () => { try { return readFile(tokenFile).trim(); } catch { return ""; } };

  async function healthy() {
    try {
      const r = await fetchFn(`http://127.0.0.1:${target.healthPort}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return false;
      const j = await r.json();
      return j?.childAlive === true;
    } catch { return false; }
  }

  async function routeTriage(content, source, { forceLocal = false, packet = null, skipStrict = false } = {}) {
    const target = currentTarget();
    if (!target || forceLocal) return { routed: "local", result: localDispatch(content, source) };
    if (target.shadow && packet?.messageId && strictInFlight < strictMax) {
      // Shadow: a dry one-shot alongside, never in the way of the real dispatch.
      strictInFlight++;
      Promise.resolve(runStrict({ ...packet, content }, { dry: true }))
        .then((r) => log(`triage-route ${source} shadow one-shot: ${r?.ok ? `${(r.actions || []).length} action(s)${r.escalated ? ", escalated" : ""}` : r?.why || "no result"}`))
        .catch(() => {})
        .finally(() => { strictInFlight--; });
    }
    if (target.strict && packet?.messageId && !skipStrict) {
      if (strictInFlight >= strictMax) {
        log(`triage-route ${source} → ${target.agent} (strict: ${strictInFlight} already running)`);
      } else {
        strictInFlight++;
        putMarker(source, content, packet);
        let r;
        try { r = await runStrict({ ...packet, content }); } finally { strictInFlight--; dropMarker(source); }
        if (r?.ok) {
          log(`triage-route ${source} → strict one-shot (${r.escalated ? "escalated to ops" : "triaged"}, ${(r.actions || []).length} action(s))`);
          return { routed: "strict" };
        }
        log(`triage-route ${source} → ${target.agent} (strict fallback: ${r?.why || "no result"})`);
        content = content + strictFallbackNote(r);
      }
    }
    if (!(await healthy())) {
      log(`triage-route ${source} → ops (fallback: ${target.agent} unhealthy)`);
      return { routed: "local", result: localDispatch(content, source) };
    }
    try {
      const headers = { "Content-Type": "application/json" };
      const t = token();
      if (t) headers.Authorization = `Bearer ${t}`;
      const r = await fetchFn(`http://127.0.0.1:${target.webhookPort}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ task: content, source }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { routed: target.agent };
    } catch (err) {
      log(`triage-route ${source} → ops (fallback: POST to ${target.agent} failed: ${err.message})`);
      return { routed: "local", result: localDispatch(content, source) };
    }
  }

  // A run the supervisor did not see end (a restart mid-run): dispatch its
  // email the ordinary way, once.
  async function sweepPending() {
    let names = [];
    try { names = fs.readdirSync(pendingDir).filter((n) => n.endsWith(".json")); } catch { return 0; }
    let n = 0;
    for (const name of names) {
      const f = path.join(pendingDir, name);
      let m = null;
      try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
      if (m && now() - Number(m.ts || 0) < PENDING_STALE_MS) continue;
      try { fs.rmSync(f, { force: true }); } catch {}
      if (!m?.content || !m?.source) continue;
      log(`triage-route ${m.source} → ${target?.agent || "ops"} (strict one-shot never finished — restart?)`);
      await routeTriage(`${m.content}\n\n[triage-route] A strict triage one-shot started on this email and never reported back (the supervisor restarted). Check its current labels before acting.`, m.source, { skipStrict: true });
      n++;
    }
    return n;
  }
  if ((target?.strict || target?.fromConfig) && sweepEveryMs > 0) {
    const t = setInterval(() => { sweepPending().catch(() => {}); }, sweepEveryMs);
    t.unref?.();
  }
  routeTriage.sweepPending = sweepPending;
  return routeTriage;
}
