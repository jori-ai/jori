// jev-p1-gate.mjs — Jev in front of the p1-resolution-scan (unstar-scan) turn.
//
// One of the Jev decision sites (docs/jev.md). The trigger
// already dispatches only when bin/p1-scan-gate sees a NEW unstarred-P1
// id; the ops-haiku turn then decides, per id, downgrade (a genuine unstar) or
// leave untouched (a fresh third-party reply that inherited the p1 label —
// jobs/p1-resolve.md § Reliability notes). Jev answers that same per-id
// question for the NEW ids:
//
//   every id "leave", confidently → the turn is SKIPPED (the saving). Leaving is
//       exactly what the scan itself does with ambiguous mail, and the ids stay
//       in p1-scan-seen.json, so nothing re-triggers.
//   any "downgrade", any doubt, any excluded sender, Jev down → dispatch as today.
//
// Per-item decisions, whole-job action: Jev never downgrades anything itself.
// Acting per item would mean Jev closing Google Tasks and relabelling live mail
// on its own verdict, which is the costly direction; gating the turn keeps every
// downgrade on the existing unstar-scan-run path.
//
// SHADOW (the week), via jev-pending.mjs — each batch resolved once:
//   * skipped → a DETACHED tool-less Haiku judgment with the playbook's criteria
//     over the same metadata (`bin/jev-gate-shadow p1-resolution <id>`).
//     APPROXIMATION: the real turn can open the thread; the shadow sees what
//     Jev saw.
//   * dispatched → what the turn actually did: rows with source "unstar-scan"
//     in data/p1-resolutions.jsonl for these ids (success or not — the
//     row records the decision to downgrade). A batch is scored only once at
//     least ONE of its own ids has such a row, because the turn writes nothing
//     for an id it deliberately LEAVES: silence is indistinguishable from "the
//     turn has not reached this batch", and a pass routinely runs far longer
//     than SETTLE_MS. A batch nothing ever acted on is retired unobserved
//     after VERDICT_TTL_MS instead of being scored as "the turn left
//     everything" — that inference produced one false agreement and one false
//     disagreement in a single afternoon (review 2026-09-24).
//
// Medical / financial senders (data/jev-exclude-senders.json) keep the
// whole batch off Jev; everything else passes the on-device privacy screen.
// Fail-open everywhere: any error dispatches.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { decide, siteConfig, recordLateComparison, SHADOW_DIR, privacyOn } from "./jev-shadow.mjs";
import { jevSiteDef, answerConfidence, boolOf } from "./jev.mjs";
import { appendPending, readPending, markResolved, compactPending, spawnGateShadow } from "./jev-pending.mjs";
import { healthExcluded } from "./jev-email-triage.mjs";

export const SITE = "p1-resolution";
const require = createRequire(import.meta.url);
const { installTools } = require("./root.cjs");
const { instance, agentAddresses } = require("./instance.cjs");
const ROOT = installTools();
export const RESOLUTIONS = process.env.P1_RESOLUTIONS_FILE || path.join(ROOT, "data/p1-resolutions.jsonl");
export const SETTLE_MS = 30 * 60e3;
// How long a dispatched batch waits for the turn to act on at least one of its
// own ids before it is retired unobserved (reconcileP1). Generous on purpose:
// on 2026-09-24 the scan first acted on a 13:15 batch at 17:01.
export const VERDICT_TTL_MS = 6 * 3600e3;
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
// The user's own address and every address that is the agent's (instance.json).
const selfAddresses = () => [String(instance().owner_email || "").toLowerCase(), ...agentAddresses()].filter(Boolean);

const addrOf = (from) => { const m = String(from || "").match(/<([^>]+)>/); return (m ? m[1] : String(from || "")).trim().toLowerCase(); }; // lang-regex-ok: RFC 5322 address extraction from a header
const header = (msg, name) => ((msg?.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";

// Ids a shadow disagreement sent back for a real scan (see jev-gate-shadow).
export const P1_FORCE_FILE = path.join(SHADOW_DIR, "p1-force.json");
// Batches the trigger CONFIRMED it dispatched (curl succeeded). A "dispatched"
// pending row is only compared once confirmed — an unhealthy-supervisor skip or
// a failed curl must not read as "the scan left everything" (review 2026-09-23).
export const P1_CONFIRMED_FILE = path.join(SHADOW_DIR, "p1-resolution-confirmed.json");
const UNCONFIRMED_TTL_MS = 2 * 3600e3;
// batchState is ~700 chars per message and the privacy screen fails closed above
// 24k, so a batch bigger than this could never be screened: dispatch without
// fetching anything (a reset/corrupt seen-file makes every lingering P1 "new").
export const MAX_BATCH = 12;

function readConfirmed() {
  try { return JSON.parse(fs.readFileSync(P1_CONFIRMED_FILE, "utf8")) || {}; } catch { return {}; }
}
export function confirmDispatched(batchId, nowMs = Date.now()) {
  if (!batchId) return false;
  const c = readConfirmed();
  c[batchId] = new Date(nowMs).toISOString();
  for (const [k, t] of Object.entries(c)) if (nowMs - Date.parse(t) > 7 * 864e5) delete c[k];
  try {
    fs.mkdirSync(SHADOW_DIR, { recursive: true });
    fs.writeFileSync(P1_CONFIRMED_FILE + ".tmp", JSON.stringify(c));
    fs.renameSync(P1_CONFIRMED_FILE + ".tmp", P1_CONFIRMED_FILE);
  } catch { return false; }
  return true;
}

export async function fetchMeta(id) {
  const { getAccessToken, fetchWithRetry } = require("./google-auth.js");
  const token = await getAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}` } };
  const m = await (await fetchWithRetry(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, H)).json();
  if (m.error) throw new Error(`gmail ${m.error.code}: ${m.error.message}`);
  let thread = null;
  try { thread = m.threadId ? await (await fetchWithRetry(`${GMAIL}/threads/${m.threadId}?format=metadata&metadataHeaders=From`, H)).json() : null; } catch {}
  const msgs = (thread?.messages || []).filter((x) => !(x.labelIds || []).includes("DRAFT"));
  const newest = msgs[msgs.length - 1] || null;
  return {
    id,
    from: header(m, "From"),
    subject: header(m, "Subject"),
    internalDate: Number(m.internalDate) || null,
    snippet: String(m.snippet || ""),
    labelIds: m.labelIds || [],
    thread_messages: msgs.length || null,
    newest_from: newest ? header(newest, "From") : null,
    newest_is_sent: newest ? (newest.labelIds || []).includes("SENT") : null,
  };
}

export function batchState(metas, nowMs = Date.now()) {
  const self = selfAddresses();
  return {
    messages: metas.map((m, n) => ({
      n,
      from: m.from,
      from_is_user_or_agent: self.includes(addrOf(m.from)),
      subject: String(m.subject || "").slice(0, 200),
      age_hours: m.internalDate ? Math.round((nowMs - m.internalDate) / 36e5) : null,
      snippet: String(m.snippet || "").slice(0, 300),
      thread_messages: m.thread_messages,
      newest_in_thread_from: m.newest_from,
      newest_in_thread_is_from_user: m.newest_is_sent,
    })),
  };
}

export function batchQuestions(n) {
  const def = jevSiteDef(SITE);
  if (!def?.item_question) throw new Error("jev: p1-resolution.json has no item_question");
  const q = {};
  for (let i = 0; i < n; i++) {
    q[`m${i}`] = { ...def.item_question, instructions: String(def.item_question.instructions).replace(/\{\{n\}\}/g, String(i)) };
  }
  return q;
}

export function interpretBatch(answers, ids) {
  const downgrade = [];
  let confidence = 1;
  ids.forEach((id, i) => {
    const a = answers[`m${i}`];
    const b = boolOf(a);
    if (b === null) throw new Error(`jev: no answer for m${i}`);
    confidence = Math.min(confidence, answerConfidence(a));
    if (b) downgrade.push(id);
  });
  return { value: { downgrade }, confidence };
}

export const sameSet = (a, b) => [...(a || [])].sort().join(",") === [...(b || [])].sort().join(",");

const spawnShadow = (id) => spawnGateShadow(SITE, id);

/**
 * @param {string[]} ids  the NEW unstarred-P1 ids from p1-scan-gate
 * @returns {Promise<{dispatch: boolean, reason: string, batchId?: string}>}
 */
export async function p1JevGate(ids, deps = {}) {
  if (!Array.isArray(ids) || !ids.length) return { dispatch: true, reason: "no ids — legacy" };
  if (ids.length > MAX_BATCH) return { dispatch: true, reason: `${ids.length} ids > ${MAX_BATCH} — too many to screen, legacy` };
  const batchId = `p1_${Date.now().toString(36)}`;
  try {
    const nowMs = deps.nowMs ?? Date.now();
    const metas = await Promise.all(ids.map((id) => (deps.fetchMeta || fetchMeta)(id)));
    const excl = privacyOn() ? metas.map((m) => healthExcluded({ from: m.from, subject: m.subject })).find(Boolean) : null;
    const skipJev = excl ? (excl.startsWith("financial:") ? "financial-excluded" : "health-excluded") : undefined;
    const state = batchState(metas, nowMs);
    const r = await (deps.decide || decide)({
      site: SITE, id: batchId, state, logInput: skipJev ? undefined : state,
      questions: skipJev ? undefined : batchQuestions(ids.length),
      interpret: (answers) => interpretBatch(answers, ids),
      legacy: async () => ({ dispatch: true }),
      same: () => null,
      skipJev, privacyScreen: true, jevTimeoutMs: 6000,
    });
    const jev = r.jev && !r.jev.error ? { downgrade: r.jev.value?.downgrade ?? null, confidence: r.jev.confidence } : null;
    if (r.used === "jev" && r.value?.downgrade?.length === 0) {
      appendPending(SITE, { id: batchId, kind: "skipped", ids, jev, state });
      if (siteConfig(SITE).inShadow) (deps.spawnShadow || spawnShadow)(batchId);
      return { dispatch: false, batchId, reason: `jev: all ${ids.length} new unstarred P1(s) should be left untouched` };
    }
    // Compared only after the trigger confirms the dispatch (confirmDispatched).
    if (jev) appendPending(SITE, { id: batchId, kind: "dispatched", ids, jev, jev_used: r.used === "jev", state });
    return { dispatch: true, batchId, reason: r.used === "jev" ? `jev: ${r.value.downgrade.length} to downgrade` : `legacy (${r.reason || "jev not used"})` };
  } catch (err) {
    return { dispatch: true, reason: `jev-p1-gate error — fail-open: ${String(err?.message || err).slice(0, 120)}` };
  }
}

function readResolutions() {
  try {
    return fs.readFileSync(RESOLUTIONS, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Late comparison for dispatched batches, once SETTLE_MS has passed. Run every trigger tick. */
export function reconcileP1(nowMs = Date.now()) {
  // ANY source counts as a downgrade (unstar-scan, p1-reply-sweep, text-resolve…):
  // the question is whether the id stopped being a live P1, not who did it.
  const res = readResolutions();
  const confirmed = readConfirmed();
  let compared = 0;
  let unobserved = 0;
  for (const p of readPending(SITE)) {
    if (p.kind !== "dispatched" || nowMs - Date.parse(p.ts) < SETTLE_MS) continue;
    if (!confirmed[p.id]) {
      // The trigger never confirmed this dispatch (supervisor unhealthy, curl
      // failed): there is no legacy verdict to compare against.
      if (nowMs - Date.parse(p.ts) > UNCONFIRMED_TTL_MS) markResolved(SITE, p.id, "no-run");
      continue;
    }
    const since = Date.parse(p.ts);
    const done = [...new Set(res.filter((r) => p.ids.includes(r.messageId) && Date.parse(r.ts) >= since).map((r) => r.messageId))];
    // Silence is not a verdict. The turn writes a row only for an id it
    // DOWNGRADES; a deliberate "leave" writes nothing. So an empty `done`
    // means either "the turn looked and left them all" or "the turn has not
    // got to this batch yet" — and a pass takes ~50 min and queues behind
    // other dispatches, well past SETTLE_MS. Score a batch only once the turn
    // has demonstrably acted on one of ITS OWN ids; until then keep waiting,
    // then retire it unobserved rather than invent an all-leave verdict.
    if (!done.length) {
      if (nowMs - since > VERDICT_TTL_MS && markResolved(SITE, p.id, "no-verdict")) unobserved++;
      continue;
    }
    if (!markResolved(SITE, p.id, "outcome")) continue;
    recordLateComparison({
      site: SITE, id: p.id,
      jevRow: { used: p.jev_used ? "jev" : "legacy", reason: p.jev_used ? undefined : "jev-low-confidence", input: p.state, jev: { value: p.jev, confidence: p.jev?.confidence } },
      legacyValue: { downgrade: done, via: "unstar-scan-turn" },
      agree: sameSet(p.jev?.downgrade, done),
    });
    compared++;
  }
  if (unobserved) console.error(`${new Date().toISOString()} jev-p1-gate: ${unobserved} batch(es) retired unobserved — the scan never acted on any of their ids`);
  compactPending(SITE, nowMs);
  return compared;
}
