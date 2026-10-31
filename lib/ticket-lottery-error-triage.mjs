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

const require = createRequire(import.meta.url);

/** Every code bin/ticket-lottery-run already handles explicitly. */
export const KNOWN_CODES = new Set([
  "already_entered", "captcha_challenge", "not_logged_in", "no_drawings_window",
  "captcha_invalid", "cloudflare_challenge", "form_not_found", "entry_window_closed",
  "tab_navigated_mid_eval",
]);

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
