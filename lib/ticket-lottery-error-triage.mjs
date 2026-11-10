// ticket-lottery-error-triage.mjs — what to do about a lottery-enter error code
// the script has never seen.
//
// bin/ticket-lottery-run handles every error code the browsing skills are known
// to return (KNOWN_CODES) in code. A code outside that set used to land in the
// summary as a bare "errors: <code>" with no action. Now ONE tool-less Haiku
// call classifies it — retryable / permanent / needs_attention plus a one-line
// explanation — and the script acts on the class:
//
//   retryable        retry the entry once now; if it still fails the row stays
//                    "error", which the duplicate guard does not count, so the
//                    next scheduled run tries again
//   permanent        record "failed_permanent" (counted by doneKeys), so the
//                    same show+date is not hammered every run
//   needs_attention  surface the explanation under "Needs a look"
//
// Classifications are cached per code for 30 days in the lottery config's
// `files.error_classes` (lib/ticket-lottery.mjs), so a recurring code costs one call a
// month, not one a run. At most MAX_CALLS_PER_RUN calls per run; past that, or
// if the call fails, the code falls back to the old behaviour (plain "error").
//
// The model reads a machine error code plus the skill's own diagnostic message;
// it decides nothing about what the user said, so this is a judgment call on
// machine output, not language interpretation of the user.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const pexec = promisify(execFile);

/** Every code bin/ticket-lottery-run already handles explicitly. */
export const KNOWN_CODES = new Set([
  "already_entered", "captcha_challenge", "not_logged_in", "no_drawings_window",
  "captcha_invalid", "cloudflare_challenge", "form_not_found", "entry_window_closed",
  "tab_navigated_mid_eval",
]);

/**
 * Codes the script itself produces when the browser harness (not the site) failed:
 * the CDP socket, the evaluate call, an unreadable result. They are retryable by
 * definition, so they are classified here and never cost a model call. This
 * mattered on 2026-11-09: the model call is a tool-less `claude -p`, which cannot
 * run from cron ("Not logged in"), so a harness hiccup was never retried and two
 * entries were lost for the night. A retry is safe: lottery-enter reports
 * already_entered for a drawing that did go through.
 */
export const HARNESS_CODES = new Set(["runner_exception", "runner_error", "eval_timeout", "unparseable_result"]);

export const CLASSES = ["retryable", "permanent", "needs_attention"];
export const CACHE_TTL_MS = 30 * 86400_000;
export const MAX_CALLS_PER_RUN = 3;

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["class", "explanation"],
  properties: {
    class: { type: "string", enum: CLASSES },
    explanation: { type: "string", maxLength: 200 },
  },
};

const SYSTEM = `You triage error codes from a browser-automation script that enters theater ticket lotteries on the user's behalf.
Given one error code and the automation's diagnostic message, classify it:
- "retryable": transient — timeouts, network or runner glitches, page still loading, rate limiting. Retrying in a few seconds or on the next run is likely to work.
- "permanent": this specific entry cannot succeed — the performance is not eligible, sold out, cancelled, or the lottery for it is closed. Retrying is pointless.
- "needs_attention": a human must act — an account, login, profile, payment or site-layout problem that will keep failing every entry until someone fixes it.
"explanation" is ONE short plain-English sentence the user can act on (no code names, no jargon). Answer only with the JSON object.`;

export function isUnknown(code) {
  return !!code && !KNOWN_CODES.has(code);
}

export function loadCache(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}

export function saveCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function cached(cache, code, now = Date.now()) {
  const c = cache[code];
  if (!c || !CLASSES.includes(c.class)) return null;
  if (now - Date.parse(c.classified_at || 0) > CACHE_TTL_MS) return null;
  return c;
}

/** Validate a model answer structurally. Returns null when it is unusable. */
export function validate(ans) {
  if (!ans || typeof ans !== "object") return null;
  if (!CLASSES.includes(ans.class)) return null;
  const explanation = String(ans.explanation || "").trim().slice(0, 200);
  if (!explanation) return null;
  return { class: ans.class, explanation };
}

/**
 * A per-run triager. `judge` is injectable for tests; production uses
 * max-judge's tool-less Haiku call.
 */
export function createTriager({ cacheFile, judge, now = () => Date.now(), maxCalls = MAX_CALLS_PER_RUN, log = () => {} } = {}) {
  const realJudge = judge || require("./max-judge.js").judge;
  const cache = cacheFile ? loadCache(cacheFile) : {};
  let calls = 0;

  /** → {class, explanation, source: "cache"|"model"} | null (null = fall back to plain "error"). */
  async function classify({ code, message, platform, show }) {
    if (!isUnknown(code)) return null;
    if (HARNESS_CODES.has(code)) {
      return { class: "retryable", explanation: "The browser hiccuped while entering; it is tried again.", source: "builtin" };
    }
    const hit = cached(cache, code, now());
    if (hit) return { class: hit.class, explanation: hit.explanation, source: "cache" };
    if (calls >= maxCalls) { log(`error-triage: call budget spent, leaving ${code} unclassified`); return null; }
    calls++;
    const prompt = JSON.stringify({ error_code: code, diagnostic_message: String(message || "").slice(0, 500), platform, show });
    let ans;
    try {
      ans = validate(await realJudge({ model: "haiku", system: SYSTEM, prompt, schema: SCHEMA, effort: "low", timeoutMs: 90_000 }));
    } catch (e) {
      log(`error-triage: classify ${code} failed: ${String(e.message || e).slice(0, 200)}`);
      return null;
    }
    if (!ans) { log(`error-triage: unusable answer for ${code}`); return null; }
    cache[code] = { ...ans, classified_at: new Date(now()).toISOString(), example_message: String(message || "").slice(0, 200) };
    if (cacheFile) { try { saveCache(cacheFile, cache); } catch (e) { log(`error-triage: cache write failed: ${e.message}`); } }
    return { ...ans, source: "model" };
  }

  return { classify, get calls() { return calls; } };
}

// ── A wedged automation Chrome ─────────────────────────────────────────────
// Chrome's DevTools port can keep answering /json/version while the browser no
// longer opens new tabs. A caller that sees a harness failure (a socket that
// never opens, a tab request that times out) asks cdpResponsive before retrying,
// and restarts Chrome with healChrome, instead of waiting for the 15-minute
// chrome-cdp-watch. Incident and dates: system/changelog.md. It reads HTTP and
// WebSocket outcomes only, never the user's language.

/**
 * Probe the same path a skill run uses: open a blank tab, open its socket, close it.
 * → {ok:true} | {ok:false, stage:"new_tab"|"socket", detail}
 */
export async function cdpResponsive(host, { timeoutMs = 8000, fetchImpl = fetch, WS = globalThis.WebSocket } = {}) {
  let tab;
  try {
    const url = `http://${host}/json/new?about:blank`;
    let res = await fetchImpl(url, { method: "PUT", signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    if (!res || !res.ok) res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, stage: "new_tab", detail: `HTTP ${res.status}` };
    tab = await res.json();
  } catch (e) {
    return { ok: false, stage: "new_tab", detail: String(e?.message || e).slice(0, 120) };
  }
  let socketErr = null;
  try {
    const ws = new WS(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("socket open timeout")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("socket error")); }, { once: true });
    });
    try { ws.close(); } catch { /* already closed */ }
  } catch (e) { socketErr = String(e?.message || e); }
  await fetchImpl(`http://${host}/json/close/${tab.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
  return socketErr ? { ok: false, stage: "socket", detail: socketErr } : { ok: true };
}

/**
 * Restart a launchd-managed Chrome and wait until it opens tabs again.
 * → {healed:boolean, detail}. Never throws.
 */
export async function healChrome({ host, label, waitMs = 90_000, pollMs = 3000, run = pexec, probe = cdpResponsive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  try {
    await run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${label}`], { timeout: 30_000 });
  } catch (e) {
    return { healed: false, detail: `launchctl kickstart ${label} failed: ${String(e?.message || e).split("\n")[0].slice(0, 120)}` };
  }
  const t0 = now();
  await sleep(pollMs);
  while (now() - t0 < waitMs) {
    const p = await probe(host, { timeoutMs: 5000 });
    if (p.ok) return { healed: true, detail: `restarted ${label}, answering again after ${Math.round((now() - t0) / 1000)}s` };
    await sleep(pollMs);
  }
  return { healed: false, detail: `restarted ${label} but it was still not opening tabs after ${Math.round(waitMs / 1000)}s` };
}

/**
 * A plain-English cause for a harness failure message (the text of the exception
 * the CDP runner threw). Falls back to the message itself, trimmed.
 */
export function describeHarnessFailure(message) {
  const m = String(message || "").trim();
  if (!m) return "the browser driver failed without saying why";
  if (m.includes("websocket open timeout") || m.includes("aborted due to timeout") || m.startsWith("websocket"))
    return "the automation Chrome stopped answering (it would not open a new tab)";
  if (m.includes("ECONNREFUSED") || m.includes("fetch failed"))
    return "the automation Chrome was not reachable";
  return m.slice(0, 160);
}
