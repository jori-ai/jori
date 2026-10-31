// decision-queue — the decisions waiting on the user, asked one a day in chat.
//
// Requirement (2026-10-22): the questions that pile up at the bottom of the
// weekly review email (improvement planner + cost review) reach the user
// instead as ONE decision a day in chat, as a hum lane — so it shares hum's
// daily ping budget, quiet hours, waits while the user is moving and stays
// quiet mid-conversation (all of that is hum's existing machinery: the
// hum-sense gate, the pre-rank budget veto, the APNs motion gate). Format: a
// question card (yellow background) with multiple-choice options and a
// recommended option. The reference is Claude Code's AskUserQuestion
// prompt: a short header chip, the question in bold, numbered options each
// with a one-line label and a grey description, the recommended option FIRST
// and labelled "(Recommended)", and a final free-text "Type something" option.
//
// SOURCES (all live on the host, gitignored runtime state):
//   improvement  data/improvement-plan-state.json  questions[]
//                {source, rank?, question, options[], recommendation?,
//                 recommended?, why_it_matters, asked_at, status, time_sensitive?}
//   cost         data/cost-efficiency-review-state.json  questions[]
//                {id, asked_at, question, options[], recommendation,
//                 why_it_matters, est_usd_per_day, status: "open"}
//   people       data/people-watch-asks.json  questions[]
//                {id, wiki_id, kind, rank, question, options[], recommended,
//                 why_it_matters, asked_at, status: "open"} — written only by
//                 lib/people-watch.js, which imports the answer back.
//
// PACING GROUPS. People questions (stay in touch with someone? track their
// news?) have their own daily slot (one a day; more when the question backlog
// is long — `perDay`), so they never crowd out a planner or
// cost decision and are never crowded out by them.
// An answer is written BACK to the source entry (status + answer + timestamp)
// so the planner / cost review acts on it on its next run.
//
// WHAT IS CODE AND WHAT IS A MODEL (Rule #0b). Code owns ids, order, the one-
// a-day pacing, the card's structure and the write-back. A model owns the
// wording: turning a long planner question into a short header, a bold
// question and one-line option labels + descriptions, and judging which option
// the source's prose recommendation points at. Nothing here reads what the user
// said: a tapped option is matched EXACTLY against our own labels by
// choice-reply.mjs, and a typed answer is interpreted by the chat agent (a
// model), which then calls `decision-answer --text`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { instance } = require("./instance.cjs");

export const DATA = process.env.JORI_DATA_DIR || path.join(require("./root.cjs").installRoot(), "data");
export const PATHS = {
  improvement: () => path.join(DATA, "improvement-plan-state.json"),
  cost: () => path.join(DATA, "cost-efficiency-review-state.json"),
  people: () => path.join(DATA, "people-watch-asks.json"),
  lane: () => path.join(DATA, "decision-lane-state.json"),
};

/** Days before a decision asked and left unanswered may be asked again. */
export const REASK_AFTER_DAYS = 7;
/** How long the card stays tappable in the app; an answer after that still files. */
export const CARD_TTL_DAYS = 14;
export const FREE_TEXT_LABEL = "Type something";
/** Sources that share one daily slot; any source not listed has its own. */
export const PACING_GROUP = { improvement: "review", cost: "review", people: "people" };
export const groupOf = (source) => PACING_GROUP[source] || source;
const SOURCE_LABEL = { cost: "daily cost review", improvement: "weekly self-improvement planner", people: "people tracker (staying in touch with people the user knows)" };
const SOURCE_HEADER = { cost: "Cost", improvement: "Decision", people: "People" };

function readJson(p, d = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; }
}
export function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

/**
 * A stable ref for a source entry. Cost questions carry an id; improvement
 * questions do not, so theirs is a hash of when it was asked + its opening
 * text — stable across planner runs that leave the entry alone.
 */
export function refFor(source, q) {
  if (source === "cost" && q?.id) return `cost:${q.id}`;
  if (source === "people" && q?.id) return `ppl:${q.id}`;
  const h = crypto.createHash("sha1").update(`${q?.asked_at || ""}\n${String(q?.question || "").slice(0, 200)}`).digest("hex").slice(0, 10);
  return `imp:${h}`;
}

/** Open = status exactly "open" and at least two options to choose between. */
export function isOpen(q) {
  return q && q.status === "open" && Array.isArray(q.options) && q.options.length >= 2 && typeof q.question === "string";
}

/** Every open decision from every source, unordered. */
export function loadOpen({ improvement = readJson(PATHS.improvement(), {}), cost = readJson(PATHS.cost(), {}), people = readJson(PATHS.people(), {}) } = {}) {
  const out = [];
  for (const [source, doc] of [["improvement", improvement], ["cost", cost], ["people", people]]) {
    for (const q of (doc?.questions || [])) {
      if (isOpen(q)) out.push({ ref: refFor(source, q), source, q });
    }
  }
  return out;
}

/**
 * Most important first, from structured fields only: a time-sensitive entry,
 * then the planner's own rank (1 = most important; cost questions carry none
 * and sit at the middle), then the one that has waited longest.
 */
export function orderDecisions(items) {
  const key = (it) => [
    it.q.time_sensitive ? 0 : 1,
    Number.isFinite(it.q.rank) ? it.q.rank : 50,
    Date.parse(it.q.asked_at || "") || 0,
  ];
  return [...items].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}

export function readLane() {
  const s = readJson(PATHS.lane(), null);
  return s && typeof s === "object" ? { asked: [], cards: {}, ...s } : { asked: [], cards: {} };
}
export function writeLane(s) { writeJsonAtomic(PATHS.lane(), s); }

const localDate = (tz, when) => new Date(when).toLocaleDateString("en-CA", { timeZone: tz });

const sourceOfRef = (ref) => {
  const p = String(ref || "").split(":")[0];
  return p === "cost" ? "cost" : p === "imp" ? "improvement" : p === "ppl" ? "people" : null;
};

/**
 * The decision this lane should offer now, or null with a reason.
 * One a day per pacing group: a group is closed once one of its decisions was
 * asked on the user's local today. A decision asked within REASK_AFTER_DAYS and still
 * open is skipped, so one the user is sitting on does not block every other one
 * behind it. Review decisions go before people ones on a day both are open.
 * `group` limits the pick to one pacing group.
 */
export function nextDecision({ items = loadOpen(), lane = readLane(), now = Date.now(), tz = instance().tz, group = null, perDay = 1 } = {}) {
  const today = localDate(tz, now);
  // perDay > 1 when the question backlog is long (lib/question-pacing.mjs).
  const askedToday = new Map();
  for (const a of lane.asked || []) {
    if (!a.at || localDate(tz, a.at) !== today) continue;
    const g = groupOf(sourceOfRef(a.ref));
    askedToday.set(g, [...(askedToday.get(g) || []), a.ref]);
  }
  const closed = new Map([...askedToday].filter(([, refs]) => refs.length >= Math.max(1, perDay)).map(([g, refs]) => [g, refs[refs.length - 1]]));
  const recent = new Set((lane.asked || [])
    .filter((a) => a.at && now - Date.parse(a.at) < REASK_AFTER_DAYS * 86400e3)
    .map((a) => a.ref));
  const pool = group ? items.filter((it) => groupOf(it.source) === group) : items;
  const open = orderDecisions(pool).filter((it) => !recent.has(it.ref));
  const ordered = [...open.filter((it) => groupOf(it.source) !== "people"), ...open.filter((it) => groupOf(it.source) === "people")]
    .filter((it) => !closed.has(groupOf(it.source)));
  if (!ordered.length) {
    if (open.length && closed.size) return { decision: null, reason: `already asked one today (${[...closed.values()].join(", ")})` };
    return { decision: null, reason: pool.length ? "every open decision was asked in the last week" : "no open decisions" };
  }
  return { decision: ordered[0], waiting: ordered.length, reason: null };
}

export function findDecision(ref, items = loadOpen()) {
  return items.find((it) => it.ref === ref) || null;
}

// ─── the card ──────────────────────────────────────────────────────────────

const CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["header", "question", "options", "recommended_source_index"],
  properties: {
    header: { type: "string", description: "A 1-3 word topic chip, at most 14 characters, e.g. 'Hum pings', 'Calendar', 'Cost'." },
    question: { type: "string", description: "The decision as the user reads it in bold: plain words, second person, at most 2 sentences / 260 characters, carrying only the context needed to choose." },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_index", "label", "description", "changes_nothing"],
        properties: {
          source_index: { type: "integer", description: "0-based index of the source option this rewrites." },
          label: { type: "string", description: "The choice in at most 7 words." },
          description: { type: "string", description: "One line, at most 110 characters: what choosing it means or costs." },
          // Not shown on the card: it shapes the reply after a tap (followUp / choice-reply).
          changes_nothing: { type: "boolean", description: "true only when choosing this option leaves everything exactly as it is now: nothing built, changed, removed, started or scheduled (a 'leave it as it is' or 'not now' option). false for anything else, including an option that keeps something running but adds a check, a limit or a follow-up." },
        },
      },
    },
    recommended_source_index: { type: "integer", description: "0-based index of the source option the source's recommendation points at, or -1 if it recommends none." },
  },
};

export function cardPrompt(item) {
  const q = item.q;
  return [
    "Rewrite this decision for a phone chat card in the style of a multiple-choice prompt.",
    "Keep every option, one card option per source option, same meaning; do not merge, add or drop options, and do not invent facts.",
    "Write to the user as 'you'. No jargon, no file paths, no ids.",
    "",
    `SOURCE: ${SOURCE_LABEL[item.source] || item.source}`,
    `QUESTION: ${q.question}`,
    q.why_it_matters ? `WHY IT MATTERS: ${q.why_it_matters}` : null,
    "OPTIONS:",
    ...q.options.map((o, i) => `  [${i}] ${o}`),
    q.recommendation ? `RECOMMENDATION (prose): ${q.recommendation}` : null,
    Number.isInteger(q.recommended) ? `RECOMMENDED OPTION INDEX (given): ${q.recommended}` : null,
  ].filter((l) => l !== null).join("\n");
}

/** Shape-check the model's card against the source; null when it does not fit. */
export function validateCard(raw, item) {
  const n = item.q.options.length;
  if (!raw || typeof raw !== "object") return null;
  const opts = Array.isArray(raw.options) ? raw.options : [];
  const seen = new Set();
  for (const o of opts) {
    if (!Number.isInteger(o?.source_index) || o.source_index < 0 || o.source_index >= n || seen.has(o.source_index)) return null;
    if (typeof o.label !== "string" || !o.label.trim()) return null;
    seen.add(o.source_index);
  }
  if (seen.size !== n) return null;
  const header = String(raw.header || "").trim().slice(0, 18) || "Decision";
  const question = String(raw.question || "").trim();
  if (!question) return null;
  const rec = Number.isInteger(raw.recommended_source_index) && raw.recommended_source_index >= 0 && raw.recommended_source_index < n
    ? raw.recommended_source_index : null;
  const labels = new Set();
  const options = [...opts].sort((a, b) => a.source_index - b.source_index).map((o) => {
    let label = o.label.trim().slice(0, 80);
    // Labels must be unique: a tap is matched on the exact label.
    while (labels.has(label) || label === FREE_TEXT_LABEL) label = `${label} (${o.source_index + 1})`;
    labels.add(label);
    return {
      source_index: o.source_index, label, description: String(o.description || "").trim().slice(0, 160),
      // Cards cached before the field existed have none; the reply then names the run instead.
      ...(typeof o.changes_nothing === "boolean" ? { changes_nothing: o.changes_nothing } : {}),
    };
  });
  return { header, question, options, recommended: rec };
}

/** The card with no model: the source's own words. */
export function fallbackCard(item) {
  const q = item.q;
  const rec = Number.isInteger(q.recommended) && q.recommended >= 0 && q.recommended < q.options.length ? q.recommended : null;
  return {
    header: SOURCE_HEADER[item.source] || "Decision",
    question: q.question,
    options: q.options.map((o, i) => ({ source_index: i, label: String(o).slice(0, 300), description: "" })),
    recommended: rec,
    fallback: true,
  };
}

/**
 * Build (or reuse) the card for a decision. The model call is one tool-less
 * Sonnet-low judgment on the Max session (lib/max-judge.js), made only
 * when the decision is actually being sent and cached per ref in the lane
 * state, so a decision costs one call however often it is re-asked.
 */
export async function buildCard(item, { lane = readLane(), judgeFn = null } = {}) {
  const cached = lane.cards?.[item.ref];
  if (cached && cached.question_hash === hashQuestion(item.q)) return cached.card;
  let card = null;
  try {
    const judge = judgeFn || require("./max-judge.js").judge;
    const { MODELS } = require("./models.cjs");
    const raw = await judge({ model: MODELS.sonnet, effort: "low", prompt: cardPrompt(item), schema: CARD_SCHEMA, timeoutMs: 120000 });
    card = validateCard(raw, item);
  } catch (e) {
    process.stderr.write(`decision-queue: card model failed, using the source wording: ${String(e?.message || e).slice(0, 200)}\n`);
  }
  return card || fallbackCard(item);
}

export function hashQuestion(q) {
  return crypto.createHash("sha1").update(JSON.stringify([q.question, q.options, q.recommendation ?? null, q.recommended ?? null])).digest("hex").slice(0, 12);
}

/** Card options in display order: the recommended one first. */
export function displayOptions(card) {
  const opts = card.options.map((o) => ({ ...o, recommended: o.source_index === card.recommended }));
  return [...opts.filter((o) => o.recommended), ...opts.filter((o) => !o.recommended)];
}

/**
 * The metadata.choices payload (apps/companion/Jori/ChoicePrompt.swift, contract
 * v1) and the plain message text. Additive fields (`header`, `recommended_id`,
 * `free_text`) are drawn by builds that know them and ignored by older ones,
 * which still show the options as tappable buttons under the text below.
 */
export function renderDecision(item, card, { now = Date.now(), promptId = crypto.randomUUID() } = {}) {
  const shown = displayOptions(card);
  const options = shown.map((o, i) => ({
    id: `o${i + 1}`,
    label: o.label,
    ...(o.description ? { sublabel: o.description } : {}),
    // What decision-answer stores: the source's own option text.
    value: String(item.q.options[o.source_index]),
  }));
  const recIdx = shown.findIndex((o) => o.recommended);
  const choices = {
    v: 1,
    id: promptId,
    kind: "decision",
    ref: item.ref,
    header: card.header,
    prompt: card.question,
    options,
    ...(recIdx >= 0 ? { recommended_id: options[recIdx].id } : {}),
    free_text: true,
    expires_at: new Date(now + CARD_TTL_DAYS * 86400e3).toISOString(),
  };
  const lines = [`❓ ${card.header}`, "", `**${card.question}**`, ""];
  shown.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.label}${o.recommended ? " (Recommended)" : ""}`);
    if (o.description) lines.push(`   ${o.description}`);
  });
  lines.push(`${shown.length + 1}. ${FREE_TEXT_LABEL}`);
  lines.push("", "Reply with a number, or in your own words.");
  return { choices, text: lines.join("\n") };
}

// ─── the answer ────────────────────────────────────────────────────────────

/**
 * Write the user's answer back to the source entry. Re-reads the file immediately
 * before writing and replaces it atomically, so a planner run that rewrote the
 * file since the card was sent is never clobbered beyond this one entry.
 *
 * @param {object} a
 * @param {string} a.ref
 * @param {string} a.answer  the chosen option's source text, or the user's own words
 * @param {"option"|"text"} a.kind
 * @returns {{ok: boolean, error?: string, source?: string, already?: boolean}}
 */
export function recordAnswer({ ref, answer, kind, messageId = null, now = new Date() }) {
  const source = sourceOfRef(ref);
  if (!source) return { ok: false, error: `unknown ref ${ref}` };
  const text = String(answer || "").trim();
  if (!text) return { ok: false, error: "empty answer" };
  const file = PATHS[source]();
  const doc = readJson(file, null);
  if (!doc || !Array.isArray(doc.questions)) return { ok: false, error: `${file} unreadable` };
  const q = doc.questions.find((x) => refFor(source, x) === ref);
  if (!q) return { ok: false, error: `no decision ${ref} in ${path.basename(file)}` };
  if (q.status !== "open") return { ok: true, already: true, source };
  const at = now.toISOString();
  // Each source's own answered convention: the planner reads status
  // "answered" + answer; the cost review reads status "answered:<the user's words>".
  q.status = source === "cost" ? `answered:${text}` : "answered";
  q.answer = text;
  q.answer_kind = kind === "text" ? "own_words" : "option";
  q.answered_at = at;
  q.answered_via = "chat-decision";
  if (messageId) q.answered_message_id = messageId;
  writeJsonAtomic(file, doc);

  const lane = readLane();
  for (const a of lane.asked || []) if (a.ref === ref && !a.answered_at) a.answered_at = at;
  try { writeLane(lane); } catch { /* the source write is what matters */ }
  return { ok: true, source };
}

/** The most recent decision sent in the last 48h that is still open — for an unthreaded reply. */
export function latestAsked({ lane = readLane(), items = loadOpen(), now = Date.now() } = {}) {
  const open = new Set(items.map((i) => i.ref));
  const rows = (lane.asked || []).filter((a) => !a.answered_at && open.has(a.ref) && now - Date.parse(a.at) < 48 * 3600e3);
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return rows[0] || null;
}

// ─── after the answer: who acts on it, and by when ─────────────────────────
//
// What an answer leads to, for the line the user reads after tapping a card
// (decision-answer returns it as `next`; choice-reply.mjs words it). A tap
// starts nothing by itself: the source's own job reads the answer on its next
// run. `task` is the tasks-registry entry whose schedule bounds that run, so
// the time follows the registry when a job moves:
//   improvement  the planner acts on answers at the start of its run, which
//                is chained after the weekly review; the review's start is
//                the latest an answer can land and still make that week's plan
//   cost         the nightly cost review reads its own state each run
//   people       people-watch applies a tapped option in code on its nightly
//                pass (and on hourly day passes, so the time is an upper bound)
// Every time is worded as "by …": a run can come sooner, never later.
export const FOLLOW_UP = {
  improvement: { who: "the weekly improvement planner", task: "nightly-review", after: "right after the weekly review", does: "plans whatever your answer unblocks" },
  cost: { who: "the nightly cost review", task: "cost-efficiency-review", does: "acts on it" },
  people: { who: "the people tracker", task: "people-watch", does: "puts it into effect" },
};

function taskSchedule(name) {
  const tasks = require("./registry.cjs").loadRegistryList("tasks") || [];
  return tasks.find((t) => t.name === name)?.schedule || null;
}

/** One cron field as a set of values, or null when it is not a plain list/range/step. */
function cronField(spec, lo, hi) {
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    let a, b;
    if (range === "*") [a, b] = [lo, hi];
    else if (range.includes("-")) [a, b] = range.split("-").map(Number);
    else [a, b] = [Number(range), stepS === undefined ? Number(range) : hi];
    if (![a, b, step].every(Number.isInteger) || step < 1 || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * The next firing (epoch ms) of a five-field cron schedule strictly after
 * `from`, read in `tz` (default: this machine's zone, which is what cron and
 * launchd run in). Day-of-month and month must be "*"; anything else, or no
 * firing within 8 days, is null — the caller then says "on its next run".
 */
export function nextRun(expr, from = Date.now(), tz = undefined) {
  const f = String(expr || "").trim().split(" ").filter(Boolean);
  if (f.length !== 5 || f[2] !== "*" || f[3] !== "*") return null;
  const mins = cronField(f[0], 0, 59), hours = cronField(f[1], 0, 23), dows = cronField(f[4], 0, 7);
  if (!mins || !hours || !dows) return null;
  if (dows.has(7)) dows.add(0);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" });
  let t = Math.floor(from / 60000) * 60000 + 60000;
  while (t - from < 8 * 86400e3) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const h = Number(p.hour) % 24, m = Number(p.minute);
    if (!dows.has(DOW[p.weekday]) || !hours.has(h)) { t += (60 - m) * 60000; continue; }
    if (mins.has(m)) return t;
    t += 60000;
  }
  return null;
}

/** "by tomorrow morning", "by Tuesday morning", "by next Tuesday morning" — in the user's zone. */
export function byWhen(at, now = Date.now(), tz = undefined) {
  const day = (t) => Date.parse(new Date(t).toLocaleDateString("en-CA", { timeZone: tz }));
  const days = Math.round((day(at) - day(now)) / 86400e3);
  const hour = Number(new Date(at).toLocaleString("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" })) % 24;
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const weekday = new Date(at).toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  if (days <= 0) return `by this ${part}`;
  if (days === 1) return `by tomorrow ${part}`;
  if (days < 7) return `by ${weekday} ${part}`;
  if (days === 7) return `by next ${weekday} ${part}`;
  return `by ${weekday}, ${new Date(at).toLocaleDateString("en-US", { timeZone: tz, month: "long", day: "numeric" })}`;
}

/**
 * What answering `ref` leads to: {who, does, after, at, when}, or null for an
 * unknown source. `when` is null when the schedule cannot be read — the reply
 * then promises no time. `tz` is the user's zone (for the words); the schedule is
 * read in `schedTz`, by default this machine's zone (tests pin it).
 */
export function followUp(ref, { now = Date.now(), tz = undefined, schedTz = undefined, scheduleOf = taskSchedule } = {}) {
  const f = FOLLOW_UP[sourceOfRef(ref)];
  if (!f) return null;
  let at = null;
  try { at = nextRun(scheduleOf(f.task), now, schedTz); } catch { at = null; }
  return { who: f.who, does: f.does, after: f.after || null, at: at ? new Date(at).toISOString() : null, when: at ? byWhen(at, now, tz) : null };
}
