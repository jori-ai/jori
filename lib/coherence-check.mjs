// coherence-check.mjs — before a proactive message goes out, does every reason
// it gives for putting two things together actually follow?
//
// WHY. A hum ping reminded the user of an airport pickup and, in the same
// breath, of a parcel due that day: "check the mailbox before you leave, it
// saves a trip back". It saved nothing: a parcel delivered at home waits there
// while you are at the airport. Every gate in front of the send passed it,
// because each one asked whether the facts were TRUE (they were: the flight,
// the pickup, the open task) and none asked whether the message's own stated
// reason FOLLOWS from its facts. The two items were fused at compose time (one
// harvester candidate carried both) and nothing later read the message the way
// the user would.
//
// WHAT. A model reads the message on its own (no records: whether the facts are
// true is the other gates' job) and judges every link that ties a second,
// separate subject to the first ("so", "before you go", "while you're there",
// "saves a trip", or a bare "also"): given what the message says, would the
// person act differently because of it? Code owns the action table:
//
//   keep   no link fails (one subject, a roundup of separate items, or a link
//          that holds)                       → sent exactly as written
//   trim   a link fails, and the stapled-on part is not worth a message of its
//          own                               → sent without it
//   split  a link fails, and that part IS worth telling on its own → sent
//          without it, and the part is queued (data/hum-split-queue.jsonl) for
//          the hum to offer later as its own candidate (topic `split`): ranked
//          on its own merits against everything else, sent through every gate,
//          routed by ping-route to its own team member, at most once, and only
//          until the end of the day it was split off
//
// A message is never blocked whole: the most this does is take a part off.
//
// WHERE. bin/coherence-check. bin/hum-ping calls it before ping-route, so a
// ping is routed on the one subject it keeps, and tells jori-send-curl it is
// done (--coherence-checked). bin/jori-send-curl calls it after every other
// text-changing gate and before the role signature and the speak gate, for
// every other chat-bound proactive message that reaches the resolve-first or
// precheck gate; never for an answer to something the user asked for. So the
// speak gate judges the text that will actually go out.
//
// MODEL. Rule #0b: what a message means is a model's call, never a regex or a
// keyword list. A Sonnet → Opus ladder (models.env; Max session only, tool-less,
// structured output), climbing only when a rung errors or its answer fails
// validation. No Haiku rung, on evidence: on 2026-11-21, of the two wordings of
// the triggering ping, Haiku kept one ("the mailbox is at the start of the
// trip, a natural same-place step"); Sonnet at low effort caught both and kept
// every legitimate link in the test set (a freed hour, a shop next door, a late
// arrival on the same trip, a three-item roundup).
//
// VALIDATION (code, structural only). A change needs at least one link marked
// as failing; a kept text must be non-empty and shorter than the original; a
// split needs its own text; a keep must mark no link as failing. Anything else
// is the next rung.
//
// FAIL-OPEN, NEVER FAIL-TRUE. No model, a timeout, a fatal auth error or no
// valid answer on any rung → the message goes out exactly as written and the
// log row says why (`decision: "error"`). The gate can only take a part off; it
// never asserts or adds anything, and what it keeps is still read by the gates
// after it (the speak gate checks the kept text against the records).
//
// PRIVACY. jori-send-curl never calls it for the bank, brokerage and health
// intents or the finance and stocks hum lanes, and this module refuses every
// private hum lane itself (finance, stocks, health, exercise; by --lane or by
// intent), logging the skip with no text. Their text reaches neither this log
// nor the split queue.
//
// MEASURED. One row per decision in data/coherence-check-log.jsonl
// ({ts, decision_id, source, intent, lane, ping_id, decision, reason, links,
// original, kept, detached, split_id, model, attempts, ms}); split-queue
// events in data/hum-split-queue.jsonl. `coherence-check stats|tail|queue`.
// Off switch: data/.coherence-check-off.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { installTools } from "./root.cjs";
import { endOfLocalDay, userTz } from "./open-questions.mjs";

const require = createRequire(import.meta.url);
const { MODELS } = require("./models.cjs");

export const DATA = () => process.env.JORI_DATA_DIR || installTools("data");
export const LOG_FILE = () => path.join(DATA(), "coherence-check-log.jsonl");
export const QUEUE_FILE = () => path.join(DATA(), "hum-split-queue.jsonl");
export const OFF_FILE = () => path.join(DATA(), ".coherence-check-off");

// Lanes whose text is jori-model-only (bank, brokerage, health): never judged
// here, so never logged or queued here.
export const PRIVATE_LANES = new Set(["finance", "stocks", "health", "exercise"]);

// The candidate topic a split-off part comes back under, and its dedup_key prefix.
export const SPLIT_TOPIC = "split";
export const SPLIT_KEY_PREFIX = "split:";
// Middling on purpose: the ranker decides on relevance and timing, as for any
// other candidate; the part only has to stand on its own.
export const SPLIT_URGENCY = 0.55;

// A rung answers in 2–7 s (measured 2026-11-21); the timeouts and the deadline
// bound the worst case to about a minute, so a send is never held long.
export const TIERS = [
  { name: "sonnet", model: MODELS.sonnet, effort: "low", timeoutMs: 30000 },
  { name: "opus", model: MODELS.opus, effort: "low", timeoutMs: 40000 },
];
export const DEADLINE_MS = 60000;

export const SYSTEM = `You read ONE message an assistant is about to send to the person it works for, and judge one thing only: whether every stated reason or benefit that ties two things together actually follows.

You are not checking whether the facts are true (another check does that). Take the facts the message states as given, and read it the way the person would.

What to look for. A message is about one subject: one event, errand, decision or item the person would act on. Sometimes a second, separate subject is attached to it, by a claimed reason or benefit ("so", "before you go", "while you're there", "on the way", "saves a trip", "since you're already…", "good moment to…") or by a bare connective ("also", "too", "and another thing"). For each such link, ask: given only what the message says, would the person act differently because of the link? Would they do the second thing at a different time, place or way than they otherwise would, or does it change the first?
- The link FOLLOWS when the stated facts make it true: the second errand is on the route to the first, one thing's timing really frees or blocks the other, both concern the same trip, booking, place or decision, or doing them together really saves the trip, time or money claimed.
- The link FAILS when the benefit is invented or the second subject has no bearing on the first: something that will simply wait where it is, a reminder about something unrelated to the trip it is stapled to, weather or a free window used as an excuse to mention an unrelated task. A bare "also" that staples an unrelated subject on fails too: nothing about the first subject makes this the moment for the second.

What is never a failure:
- A message about a single subject, however many facts it gives about it.
- A message built as a roundup (a digest, a list of several separate items presented as separate items, an answer listing what the person asked for). Separate items side by side, with no claim that one bears on the other, are fine.
- A link you can see holds, even if it is loose ("you're free until 3, so there's time to look at the quote that came in").

Decide:
- "keep": no link fails. The message goes out unchanged.
- "trim": a link fails, and the attached subject is not worth a message of its own (it adds nothing the person needs now, or it is something they plainly already have, such as an item from their own list that is merely due). Return the message with that part removed.
- "split": a link fails, and the attached subject IS worth telling the person on its own (it carries a fact they may not have, or needs them to act). Return the message without it, and that subject on its own, worded to stand alone with no invented link.

Writing the kept text and the detached text: use only the message's own facts and, as far as possible, its own words. Delete the failing part and re-join what remains so it reads naturally. Never add a fact, a time, a number or a benefit that the message does not state. The kept text keeps the message's main subject: the one it opens with and that its timing is about. If the message asks the person a question, that question is its main subject and is always kept, whatever comes before it. If the message offers fixed answers to tap, keep the part those answers answer. If several parts fail, remove all of them (for split, the detached text is the single most worth-telling of them; mention only that one).

List in "links" every link you considered (empty when there is none), with the connecting words as written, whether it follows, and why in one sentence. "reason" is one plain sentence a person could read, saying what you decided and why.`;

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subjects", "links", "decision", "kept_text", "detached_text", "reason"],
  properties: {
    subjects: { type: "array", items: { type: "string" } },
    links: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["words", "follows", "why"],
        properties: { words: { type: "string" }, follows: { type: "boolean" }, why: { type: "string" } },
      },
    },
    decision: { type: "string", enum: ["keep", "trim", "split"] },
    kept_text: { type: ["string", "null"] },
    detached_text: { type: ["string", "null"] },
    reason: { type: "string" },
  },
};

const DETACHED_MAX = 600;

/** `hum:<lane>[:…]` → lane; anything else → null. Machine-written intent label. */
export function laneOf(intent) {
  const parts = String(intent || "").split(":");
  return parts[0] === "hum" && parts[1] ? parts[1] : null;
}

/**
 * null when the message is one this gate judges, else why not (logged as a
 * skip). The structural scope only: the caller (jori-send-curl) decides the
 * channel and sender, hum-ping the lane.
 */
export function outOfScope({ message, intent, lane } = {}) {
  if (fs.existsSync(OFF_FILE())) return "off";
  if (!String(message || "").trim()) return "empty";
  // Either label naming a private lane is enough (a caller's --lane may be a
  // default like "unknown" while its intent names the lane).
  if ([lane, laneOf(intent)].some((l) => l && PRIVATE_LANES.has(String(l)))) return "private";
  return null;
}

/**
 * The per-call prompt: the message, whether the sender marked it as a question
 * (structure the sender knows, never read from the words), and its tappable
 * answers when it has some.
 */
export function buildPrompt({ message, choices, question = false }) {
  const opts = choiceLabels(choices);
  return `MESSAGE:\n${String(message)}`
    + (question ? "\n\nTHIS MESSAGE ASKS THE PERSON SOMETHING: its question is its main subject and is always kept." : "")
    + (opts.length ? `\n\nTAPPABLE ANSWERS IT OFFERS: ${JSON.stringify(opts)}` : "");
}

function choiceLabels(choices) {
  const list = Array.isArray(choices) ? choices : (choices && Array.isArray(choices.options) ? choices.options : []);
  return list.map((o) => (o && typeof o === "object" ? String(o.label ?? "") : String(o))).filter(Boolean).slice(0, 8);
}

const norm = (s) => String(s ?? "").trim();

/** null when the verdict is usable for this message, else what is wrong with it. */
export function validate(v, message) {
  if (!v || typeof v !== "object") return "not an object";
  if (!["keep", "trim", "split"].includes(v.decision)) return `bad decision ${JSON.stringify(v.decision)}`;
  if (!Array.isArray(v.links)) return "links is not an array";
  const failing = v.links.filter((l) => l && l.follows === false).length;
  if (v.decision === "keep") return failing ? "keep, but a link is marked as failing" : null;
  if (!failing) return `${v.decision} with no link marked as failing`;
  const original = norm(message);
  const kept = norm(v.kept_text);
  if (!kept) return `${v.decision} with no kept text`;
  if (kept === original) return `${v.decision}, but the kept text is the original`;
  if (kept.length >= original.length) return `${v.decision}, but the kept text is not shorter than the original`;
  if (v.decision === "split") {
    const det = norm(v.detached_text);
    if (!det) return "split with no detached text";
    if (det.length > DETACHED_MAX) return `detached text longer than ${DETACHED_MAX}`;
  }
  return null;
}

/** Default judge: one structured-output call on the Max session. */
async function maxJudge({ tier, prompt }) {
  const { judge } = require("./max-judge.js");
  return judge({ model: tier.model, effort: tier.effort, appendSystem: SYSTEM, prompt, schema: SCHEMA, timeoutMs: tier.timeoutMs });
}

export function newDecisionId(nowMs = Date.now()) {
  const t = new Date(nowMs).toISOString().replace(/[-:]/g, "").slice(0, 15); // lang-regex-ok: formats a machine timestamp
  return `cc-${t}-${crypto.randomBytes(2).toString("hex")}`;
}

/**
 * Judge one message and apply the action table.
 *
 * input: {message, intent?, lane?, ping_id?, choices?, question?, source?}
 * opts:  {judgeFn?, tiers?, now?, log?, queue?}
 *
 * Returns {decision: "keep"|"trim"|"split"|"skip"|"error", text, decision_id,
 * reason, split_id?, links?, model?}. `text` is what to send: the original for
 * keep / skip / error, the kept text for trim / split. Never throws.
 */
export async function coherenceCheck(input = {}, opts = {}) {
  const t0 = Date.now();
  const nowMs = opts.now ?? Date.now();
  const message = String(input.message ?? "");
  const lane = input.lane || laneOf(input.intent);
  const base = {
    decision_id: newDecisionId(nowMs),
    source: input.source || null,
    intent: input.intent || null,
    lane: lane || null,
    ping_id: input.ping_id || null,
  };
  const finish = (row, text) => {
    const out = { ...base, ...row, ms: Date.now() - t0 };
    if (opts.log !== false) appendLog({ ts: new Date(nowMs).toISOString(), ...out, original: row.decision === "skip" && row.reason === "private" ? undefined : message });
    return { decision: out.decision, text, decision_id: out.decision_id, reason: out.reason, split_id: out.split_id || null, links: out.links || [], model: out.model || null };
  };

  const why = outOfScope({ message, intent: input.intent, lane });
  if (why) return finish({ decision: "skip", reason: why }, message);

  const judgeFn = opts.judgeFn || maxJudge;
  const tiers = opts.tiers || TIERS;
  const prompt = buildPrompt({ message, choices: input.choices, question: input.question === true });
  const tried = [];
  for (const tier of tiers) {
    if (Date.now() - t0 > (opts.deadlineMs ?? DEADLINE_MS)) { tried.push(`${tier.name}: deadline`); break; }
    let v;
    try {
      v = await judgeFn({ tier, prompt, message });
    } catch (e) {
      tried.push(`${tier.name}: ${String(e?.message || e).slice(0, 160)}`);
      if (e && e.fatal) break; // not logged in / usage limit: every rung fails the same way
      continue;
    }
    const bad = validate(v, message);
    if (bad) { tried.push(`${tier.name}: ${bad}`); continue; }
    const links = v.links.map((l) => ({ words: String(l.words || "").slice(0, 160), follows: l.follows === true, why: String(l.why || "").slice(0, 300) }));
    const common = { model: tier.model, attempts: tried.length + 1, reason: String(v.reason || "").slice(0, 400), links };
    if (v.decision === "keep") return finish({ decision: "keep", ...common }, message);
    const kept = norm(v.kept_text);
    if (v.decision === "trim") return finish({ decision: "trim", kept, ...common }, kept);
    const detached = norm(v.detached_text);
    let splitId = null;
    if (opts.queue !== false) {
      try { splitId = enqueueSplit({ text: detached, from: { ...base }, nowMs }); }
      catch (e) { common.queue_error = String(e?.message || e).slice(0, 160); }
    }
    return finish({ decision: "split", kept, detached, split_id: splitId, ...common }, kept);
  }
  return finish({ decision: "error", reason: tried.join(" | ").slice(0, 600) || "no rung answered", attempts: tried.length }, message);
}

function appendLog(row) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE()), { recursive: true });
    fs.appendFileSync(LOG_FILE(), JSON.stringify(row) + "\n");
  } catch { /* the log never changes what is sent */ }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ─── The split queue ────────────────────────────────────────────────────────
//
// Append-only: an `add` row per split-off part, a `consumed` row when hum-ping
// has put it through a send (sent or held by a later gate: one chance only).
// An item lapses at the end of the local day it was split off on.

/** Queue a split-off part; returns its id. */
export function enqueueSplit({ text, from = {}, nowMs = Date.now(), tz = userTz() }) {
  const created = new Date(nowMs).toISOString();
  const id = `sp-${created.replace(/[-:]/g, "").slice(0, 15)}-${crypto.randomBytes(2).toString("hex")}`; // lang-regex-ok: formats a machine timestamp
  const row = {
    event: "add", id, created_at: created, expires_at: endOfLocalDay(created, tz),
    text: String(text).slice(0, DETACHED_MAX),
    from: { decision_id: from.decision_id || null, intent: from.intent || null, lane: from.lane || null, ping_id: from.ping_id || null, source: from.source || null },
  };
  fs.mkdirSync(path.dirname(QUEUE_FILE()), { recursive: true });
  fs.appendFileSync(QUEUE_FILE(), JSON.stringify(row) + "\n");
  return id;
}

/** Collapsed queue: [{...add row, consumed, consumed_at, ping_id}], oldest first. */
export function readSplitQueue() {
  const byId = new Map();
  for (const r of readJsonl(QUEUE_FILE())) {
    if (!r || !r.id) continue;
    if (r.event === "add") byId.set(r.id, { ...r, consumed: false });
    else if (r.event === "consumed" && byId.has(r.id)) Object.assign(byId.get(r.id), { consumed: true, consumed_at: r.at, ping_id: r.ping_id || null, consumed_by: r.by || null });
  }
  return [...byId.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/** Split-off parts still waiting (not consumed, not lapsed). */
export function pendingSplits(nowMs = Date.now()) {
  return readSplitQueue().filter((r) => !r.consumed && Date.parse(r.expires_at) > nowMs);
}

/**
 * The hum candidate(s) for waiting parts: newest first, `max` of them. Newest
 * first so a part the ranker keeps declining never blocks a fresher one; an
 * older part still lapses at the end of its day.
 */
export function splitCandidates({ nowMs = Date.now(), max = 1 } = {}) {
  return pendingSplits(nowMs).reverse().slice(0, max).map((r) => ({
    topic: SPLIT_TOPIC,
    signal: r.text,
    urgency: SPLIT_URGENCY,
    freshness_min: Math.max(0, Math.round((nowMs - Date.parse(r.created_at)) / 60000)),
    dedup_key: `${SPLIT_KEY_PREFIX}${r.id}`,
    evidence_as_of: r.created_at,
    supporting_data: {
      split_id: r.id,
      split_from: r.from,
      created_at: r.created_at,
      evidence_as_of: r.created_at,
      rationale: "Taken off an earlier message because it was attached to an unrelated subject; offered here on its own.",
    },
    temporal_fit: { relative_to: "always", expires_after_iso: r.expires_at },
  }));
}

/** dedup_key `split:<id>` → id; anything else → null. Machine-written key. */
export function splitIdFromKey(key) {
  const k = String(key || "");
  return k.startsWith(SPLIT_KEY_PREFIX) ? k.slice(SPLIT_KEY_PREFIX.length) || null : null;
}

/** Mark a part as having had its chance. Idempotent; false when unknown. */
export function consumeSplit(id, { ping_id = null, by = "hum-ping", nowMs = Date.now() } = {}) {
  const item = readSplitQueue().find((r) => r.id === id);
  if (!item || item.consumed) return false;
  fs.appendFileSync(QUEUE_FILE(), JSON.stringify({ event: "consumed", id, at: new Date(nowMs).toISOString(), ping_id, by }) + "\n");
  return true;
}

// ─── Measurement ────────────────────────────────────────────────────────────

export function readLog() { return readJsonl(LOG_FILE()); }

/** Counts by decision (and by source / lane) since `sinceMs`; what split-offs became. */
export function stats({ sinceMs = 0 } = {}) {
  const rows = readLog().filter((r) => Date.parse(r.ts || "") >= sinceMs);
  const count = (key) => rows.reduce((m, r) => { const k = r[key] || "none"; m[k] = (m[k] || 0) + 1; return m; }, {});
  const by = (key) => rows.reduce((m, r) => {
    const k = r[key] || "none";
    m[k] = m[k] || {};
    m[k][r.decision] = (m[k][r.decision] || 0) + 1;
    return m;
  }, {});
  const queue = readSplitQueue().filter((r) => Date.parse(r.created_at || "") >= sinceMs);
  const now = Date.now();
  const splits = {
    queued: queue.length,
    sent_or_tried: queue.filter((r) => r.consumed).length,
    waiting: queue.filter((r) => !r.consumed && Date.parse(r.expires_at) > now).length,
    lapsed: queue.filter((r) => !r.consumed && Date.parse(r.expires_at) <= now).length,
  };
  const ms = rows.filter((r) => ["keep", "trim", "split"].includes(r.decision)).map((r) => r.ms).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    total: rows.length,
    decisions: count("decision"),
    by_source: by("source"),
    by_lane: by("lane"),
    splits,
    median_ms: ms.length ? ms[Math.floor(ms.length / 2)] : null,
  };
}
