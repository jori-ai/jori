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
// Config (agents.json → ops.gmailTriageTarget): "ops-light" (default) | "ops"
// | "strict". Rollback: set it to "ops" and restart the ops supervisor.
//
// "strict" (2026-11-16): each per-message item first runs the strict one-shot
// (bin/email-triage-run: no shell, web or browser; tools bound to the one email;
// agent/ops-agent/jobs/email-triage-strict.md). When it does not finish — no
// answer, a timeout, no triage action, or STRICT_MAX already running — the item
// goes to ops-light exactly as before, with a note of what the one-shot already
// did. Never drops an email.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "email-triage-run");
export const STRICT_MAX = 3;

// Run the strict one-shot for one email. Resolves { ok, actions, why }; never rejects.
export function runStrictOneShot(packet, { timeoutMs = 9 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let f;
    try {
      f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "triage-strict-")), "payload.json");
      fs.writeFileSync(f, JSON.stringify(packet));
    } catch (e) { return resolve({ ok: false, actions: [], why: `payload: ${e.message}` }); }
    execFile(process.execPath, [RUNNER, "--payload", f], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
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
  const done = (r?.actions || []).filter((a) => !a.dry).map((a) => a.summary || a.tool).filter(Boolean);
  if (!done.length) return "";
  return `\n\n[triage-route] A strict triage one-shot ran first and stopped (${r.why || "no result"}). It already did: ${done.join("; ")}. Do not repeat those; finish the rest.`;
}

export function triageTargetFromConfig(agentsConfig, { selfAgent = "ops" } = {}) {
  const self = agentsConfig?.agents?.[selfAgent] || {};
  const configured = self.gmailTriageTarget === undefined ? "ops-light" : self.gmailTriageTarget;
  const strict = configured === "strict";
  const target = strict ? "ops-light" : configured;
  if (!target || target === selfAgent) return null;
  const sup = agentsConfig?.agents?.[target]?.supervisor;
  if (!sup?.webhookPort || !sup?.healthPort) return null;
  return { agent: target, webhookPort: sup.webhookPort, healthPort: sup.healthPort, ...(strict ? { strict: true } : {}) };
}

export function makeTriageRouter({
  target,                 // { agent, webhookPort, healthPort } | null
  localDispatch,          // (content, source) => any — the ops dispatcher
  tokenFile,
  fetchFn = globalThis.fetch,
  readFile = (p) => fs.readFileSync(p, "utf8"),
  log = () => {},
  timeoutMs = 5000,
  runStrict = runStrictOneShot,   // the strict one-shot (target.strict)
  strictMax = STRICT_MAX,
}) {
  let strictInFlight = 0;
  const token = () => { try { return readFile(tokenFile).trim(); } catch { return ""; } };

  async function healthy() {
    try {
      const r = await fetchFn(`http://127.0.0.1:${target.healthPort}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return false;
      const j = await r.json();
      return j?.childAlive === true;
    } catch { return false; }
  }

  return async function routeTriage(content, source, { forceLocal = false, packet = null } = {}) {
    if (!target || forceLocal) return { routed: "local", result: localDispatch(content, source) };
    if (target.strict && packet?.messageId) {
      if (strictInFlight >= strictMax) {
        log(`triage-route ${source} → ${target.agent} (strict: ${strictInFlight} already running)`);
      } else {
        strictInFlight++;
        let r;
        try { r = await runStrict({ ...packet, content }); } finally { strictInFlight--; }
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
  };
}
