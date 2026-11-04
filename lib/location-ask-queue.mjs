// location-ask-queue — composed location questions waiting to earn a send.
//
// WHY THIS EXISTS
//
// Until 2026-08-04 the location-enrich job ended with "Send via
// jori-send-curl. One message per run", and it runs every 15 minutes. That
// made it the only proactive lane in Jori that never had to win anything:
// it did not enter hum's ranker, so it never competed against a recommendation,
// a task, or an exercise nudge — it just went. Meanwhile hum-ping was refusing
// 0.41-scored candidates for being below the bar.
//
// The result, measured over one week: 46 "did you stop somewhere?" questions
// reached the user, roughly two thirds unanswered, against zero publishes from
// the `nearby` lane that exists to tell the user something useful about where
// they are. The requirement is the opposite: something of value first —
// information about the area, places nearby that are interesting or relevant.
//
// So the composition step stays exactly where it was (jobs/location-enrich.md
// builds a real hypothesis from calendar + candidates + movement evidence, and
// that part works well). What changes is who decides whether it ships: the job
// writes the composed ask HERE, and the location_context harvester offers it to
// the ranker as an ordinary candidate. A question now has to beat a
// recommendation instead of running beside it.
//
// Entries expire rather than accumulate. A backlog of stale asked-but-
// unanswered pendings is what let a fresh reply get silently applied to a
// 40-hour-old question; nothing in here outlives its usefulness.

import fs from "node:fs";
import path from "node:path";
import { installTools } from "./root.cjs";

export const QUEUE_PATH = process.env.JORI_LOCATION_ASK_QUEUE || installTools("data", "location-ask-queue.json");

// Nobody remembers a stop from yesterday, and a question that cannot be answered
// is pure interruption. Same 12h horizon location-enrich already applies when
// choosing what to ask about.
export const MAX_AGE_H = 12;

// ── How late is too late ──────────────────────────────────────────────────
//
// MAX_AGE_H bounds how long a COMPOSED question may sit; it says nothing about
// how long ago the STOP was. Those came apart badly: a 10:21–10:40 breakfast
// was asked about at 13:43 as "18m near <café> … a bite there?" — three hours
// later, phrased as though the user were still at the table. The requirement:
// location questions arrive while the user is there or shortly after, not
// hours after the fact.
//
// Measured from the stop's END, because that is when the user left it:
//   < ASK_HONEST_AFTER_MIN   fresh — ask as composed.
//   < ASK_DROP_AFTER_H       late — still ask, but SAY it is late, with the
//                            time ("Looking back to this morning, around 10:21
//                            — …"), never as though the user is standing there.
//   otherwise, or the stop   too old — not asked at all. The pending row stays
//   was on an earlier local  asked:false, so resolve-day's
//   day                      loadUnaskedPendingEnrich puts it in the next
//                            daily summary's "Corrections & follow-ups", where
//                            one batched answer costs one email rather than an
//                            interrupt about a morning long moved on from.
// Four hours keeps that case (3h03m) askable but honestly framed;
// anything older is past the point a lock-screen question beats the summary.
export const ASK_HONEST_AFTER_MIN = 45;
export const ASK_DROP_AFTER_H = 4;

function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), hhmm: `${p.hour}:${p.minute}` };
}

/**
 * Where an ask stands against the clock. Pure: everything it needs is passed in.
 * The stop's end falls back to `composed_at` for entries queued before the
 * stop window was carried on the entry (they were composed ~15–30 min after
 * the stop ended, so this errs towards "fresher than it was", never staler).
 *
 * @returns {{verdict:"fresh"|"late"|"drop", minutes_since_stop:number|null,
 *            lead:string|null, reason:string}}
 */
export function askTiming(entry, { nowMs = Date.now(), tz = "UTC" } = {}) {
  const endMs = Date.parse(entry?.stop_ended_at || entry?.composed_at || "");
  if (!Number.isFinite(endMs)) return { verdict: "fresh", minutes_since_stop: null, lead: null, reason: "no stop time" };
  const startMs = Date.parse(entry?.stop_started_at || "") || endMs;
  const mins = Math.max(0, Math.round((nowMs - endMs) / 60000));
  const stop = localParts(startMs, tz);
  const now = localParts(nowMs, tz);
  if (stop.date !== now.date) {
    return { verdict: "drop", minutes_since_stop: mins, lead: null, reason: `stop was on ${stop.date}, it is now ${now.date}` };
  }
  if (mins >= ASK_DROP_AFTER_H * 60) {
    return { verdict: "drop", minutes_since_stop: mins, lead: null, reason: `stop ended ${mins} min ago (> ${ASK_DROP_AFTER_H}h)` };
  }
  if (mins < ASK_HONEST_AFTER_MIN) return { verdict: "fresh", minutes_since_stop: mins, lead: null, reason: "fresh" };
  const part = stop.hour < 12 ? "this morning" : stop.hour < 17 ? "this afternoon" : "this evening";
  return {
    verdict: "late", minutes_since_stop: mins,
    lead: `Looking back to ${part}, around ${stop.hhmm} — `,
    reason: `stop ended ${mins} min ago`,
  };
}

/** The message to actually send, given its timing. A late ask keeps every
 *  word the composer wrote and gains a code-built lead that says when. */
export function timedMessage(entry, timing) {
  const msg = String(entry?.message || "").trim();
  if (!timing || timing.verdict !== "late" || !timing.lead) return msg;
  return `${timing.lead}${msg}`;
}

function nowMs() { return Date.now(); }

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
    return Array.isArray(raw?.queue) ? raw : { queue: [] };
  } catch { return { queue: [] }; }
}

function write(state) {
  const tmp = `${QUEUE_PATH}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, QUEUE_PATH);
}

/** Drop anything past its horizon. Called on every read path — an expired ask
 *  must never be reachable, not merely unlikely to be picked. */
export function prune(state = read(), persist = true) {
  const cutoff = nowMs() - MAX_AGE_H * 3600_000;
  const before = state.queue.length;
  state.queue = state.queue.filter((e) => {
    const t = Date.parse(e?.composed_at || "");
    return Number.isFinite(t) && t >= cutoff;
  });
  if (persist && state.queue.length !== before) write(state);
  return { state, dropped: before - state.queue.length };
}

/**
 * Queue a composed ask. Idempotent per visit_id: re-composing the same visit
 * replaces the previous text rather than queueing a second question about one
 * stop, which is how the same place gets asked about twice in an hour.
 */
export function add({ visit_id, message, score_hint = 0.5, signals = {}, stop_started_at = null, stop_ended_at = null }) {
  if (!visit_id || !message || !String(message).trim()) {
    throw new Error("location-ask-queue: visit_id and message are both required");
  }
  const { state } = prune(read(), false);
  const entry = {
    visit_id: String(visit_id),
    message: String(message).trim(),
    score_hint: Number.isFinite(Number(score_hint)) ? Number(score_hint) : 0.5,
    signals,
    // The stop's own window, so the send side can tell how long ago the user LEFT
    // (askTiming) rather than only how long the question has waited.
    stop_started_at: stop_started_at || null,
    stop_ended_at: stop_ended_at || null,
    composed_at: new Date().toISOString(),
  };
  const at = state.queue.findIndex((e) => e.visit_id === entry.visit_id);
  // Log compose vs. re-compose. A visit that keeps getting
  // recomposed every 15 min because it keeps losing its hum tick is a real
  // cost (a full agent turn + tool calls, re-done for no behavioral change —
  // measured at 5 consecutive recomposes / ~80 min for one stop)
  // and previously left no trace once each entry overwrote the last. Visible
  // now via `grep location-ask-queue agent/logs/watchdog.log`.
  if (at >= 0) {
    const ageMin = Math.round((Date.now() - Date.parse(state.queue[at].composed_at)) / 60000);
    process.stderr.write(
      `[location-ask-queue] RE-COMPOSE ${entry.visit_id} (was waiting ${ageMin}m, still unsent)\n`
    );
    state.queue[at] = entry;
  } else {
    process.stderr.write(`[location-ask-queue] compose ${entry.visit_id}\n`);
    state.queue.push(entry);
  }
  write(state);
  return entry;
}

/** Everything still live, freshest first — the ranker should see the most
 *  answerable question, not the oldest one. */
export function list() {
  const { state } = prune();
  return [...state.queue].sort((a, b) => Date.parse(b.composed_at) - Date.parse(a.composed_at));
}

/** Is this visit already queued? (A re-compose is not a NEW ask, so it must
 *  not re-fire the priority lane.) */
export function has(visit_id) {
  return list().some((e) => e.visit_id === String(visit_id));
}

/** The single best ask to offer this tick, or null. */
export function peek() {
  return list()[0] || null;
}

/** Remove one entry — called after it ships, or when another path resolved the
 *  stop out from under it. */
export function drop(visit_id) {
  const { state } = prune(read(), false);
  const before = state.queue.length;
  state.queue = state.queue.filter((e) => e.visit_id !== String(visit_id));
  write(state);
  return before - state.queue.length;
}
