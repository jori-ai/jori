// calendar-in-words — did the user say the user went to the calendar event a stop overlaps?
//
// Asked where a 10:30-10:56 stop was, the user answered "the hotel for the AI
// conference". The user's calendar had "Future of AI 2026 conference", 8am-4pm,
// with no location, and the daily summary listed it under "Events not matched to
// a location" right below the hotel stop. Nothing code
// can test ties the two: the event has no place, the stop's name shares no word
// with it, and 26 minutes is a sliver of eight hours. Whether the user's words name that
// event is language (Rule #0b), so a model reads it: Jev first (site
// `calendar-in-words`), then a tool-less Sonnet, then Opus when Sonnet's answer
// does not validate. A word-overlap test was tried first and vetoed: "lunch with
// Sam" matched an unrelated "Call with Alex" through "with".
//
// Asked only for a stop carrying the user's words (resolve-day `his_words`: a
// day-statements reading bound to a stop the user named, by the model's time) whose
// calendar event has no location of its own. A yes is stamped on that stop's
// event as `in_his_words` ({quote, by}), which calendarCorroborated in
// daily-summary-render.js reads. During the shadow week a Claude no vetoes a Jev
// yes (the costly mistake is placing the user at an event the user did not go to). Each
// question is asked once: data/.cache/calendar-in-words-verdicts.json.
// `daily-summary-build prep` calls markCalendarInWords; JORI_CALENDAR_IN_WORDS=0
// turns it off.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HOME_TZ = require("./instance.cjs").instance().tz;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const JEV_SITE = "calendar-in-words";
export const VERDICT_FILE = process.env.JORI_CALENDAR_IN_WORDS_FILE
  || path.join(HERE, "..", "data", ".cache", "calendar-in-words-verdicts.json");
const QUESTION_FILE = path.join(HERE, "..", "data", "jev-questions", `${JEV_SITE}.json`);
const VERDICT_TTL_MS = 60 * 24 * 3600 * 1000;
const MAX_ASKS = 6;

const LADDER_PROMPT = `You are helping write up the user's day. \`stop\` is a place the user was (the user's own name for it) and the hours the user was there, local time. \`what_he_said\` is what the user wrote about that stop, verbatim (\`words\`), with another model's short reading of it (\`read_as\`). \`event\` is an entry on the user's calendar whose hours overlap the stop and which has no place of its own.

Did the user's words say the user was at this stop FOR this calendar event, the same event under another wording ("the AI conference" for "Future of AI 2026 conference")? Answer true only when the user's words name the event's activity specifically enough that it is this entry. Answer false when the user's words describe something else the user did there, when they only share a common word with the title ("with", "meeting", "lunch" with someone else), or when the event is a call, a reminder or a block of time the user did not attend. If in doubt, false.

Reply with JSON only: {"went_to_event": true|false, "quote": "<when true: the exact words of the user's, copied from \`words\`, that show it; else empty>"}`;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}

function writeJsonAtomic(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  } catch {}
}

function wallClock(iso, tz) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  try {
    return new Date(t).toLocaleTimeString("en-GB", { timeZone: tz || HOME_TZ, hour: "2-digit", minute: "2-digit" });
  } catch { return null; }
}

/** The questions a day poses: one per stop with his words and a place-less event. */
export function candidates(day) {
  const out = [];
  for (const s of (day && day.stops) || []) {
    const cal = s && s.calendar_event;
    if (!cal || !cal.summary || cal.location || cal.location_match) continue;
    const said = (s.his_words || []).filter((h) => h && typeof h.evidence === "string" && h.evidence.trim());
    if (!said.length) continue;
    const tz = s.tz || day.tz;
    const state = {
      stop: { place: (s.place && s.place.name) || null, from: s.start || null, to: s.end || null },
      what_he_said: said.map((h) => ({ words: h.evidence, read_as: [h.venue, h.activity].filter(Boolean).join(", ") || null })),
      event: { title: cal.summary, from: wallClock(cal.start, tz), to: wallClock(cal.end, tz) },
    };
    out.push({ stop_id: s.id, stop: s, state });
  }
  return out;
}

export function verdictKey(state) {
  let q = "";
  try { q = fs.readFileSync(QUESTION_FILE, "utf8"); } catch {}
  return createHash("sha1").update(JSON.stringify(state)).update(q).update(LADDER_PROMPT).digest("hex");
}

/** A ladder answer counts only if it is a boolean and a yes quotes his own words. */
export function validLadderAnswer(state, j) {
  if (!j || typeof j.went_to_event !== "boolean") return null;
  if (!j.went_to_event) return { yes: false, quote: null };
  const quote = typeof j.quote === "string" ? j.quote.trim() : "";
  if (!quote) return null;
  const said = state.what_he_said.map((w) => String(w.words || "").toLowerCase());
  return said.some((w) => w.includes(quote.toLowerCase())) ? { yes: true, quote } : null;
}

async function askClaudeLadder(state) {
  const { runToollessDetailed, parseModelJson } = await import("./jev-claude.mjs");
  const { MODELS } = require(path.join(HERE, "models.cjs"));
  const prompt = `${LADDER_PROMPT}\n\nInput:\n${JSON.stringify(state, null, 1)}`;
  const tried = [];
  for (const [tier, model] of [["sonnet", MODELS.sonnet], ["opus", MODELS.opus]]) {
    const { out, error } = await runToollessDetailed({ model, prompt, timeoutMs: 90000 });
    if (error) throw new Error(`calendar-in-words ${tier}: ${error.kind}: ${error.message}`);
    const v = validLadderAnswer(state, parseModelJson(out));
    if (v) return { ...v, by: tier };
    tried.push(tier);
  }
  throw new Error(`calendar-in-words: no tier gave a valid answer (${tried.join(", ")})`);
}

/** Jev first, the Claude ladder below its threshold; a Claude no vetoes a Jev yes in the shadow week. */
export async function askInWords(state, { id = null } = {}) {
  const { decide } = await import("./jev-shadow.mjs");
  const { answerConfidence, boolOf, jevSiteDef, jevQuestions } = await import("./jev.mjs");
  const def = jevSiteDef(JEV_SITE) || {};
  let memo = null;
  const legacy = () => (memo ||= askClaudeLadder(state));
  if (!def.questions) return legacy();
  const { value, used } = await decide({
    site: JEV_SITE,
    id,
    state,
    questions: jevQuestions(JEV_SITE),
    interpret: (answers) => {
      const a = answers.went_to_event;
      const b = boolOf(a);
      if (b === null) return { value: null, confidence: 0 };
      return { value: { yes: b, quote: null, by: "jev" }, confidence: answerConfidence(a) };
    },
    legacy,
    alwaysShadow: !!(def.shadow_until && Date.now() < Date.parse(def.shadow_until)),
    same: (j, l) => !!(j && j.yes) === !!(l && l.yes),
    privacyScreen: true,
  });
  if (used === "jev" && memo && value && value.yes) {
    const shadow = await memo.catch(() => null);
    if (shadow && shadow.yes === false) return { yes: false, quote: null, by: "claude veto" };
    if (shadow && shadow.yes) return { ...value, quote: shadow.quote };
  }
  return value || { yes: false, quote: null, by: used };
}

/**
 * Stamp `in_his_words` on each stop's calendar event the user's words say the user went to.
 * @param day   the resolved / settled day ({tz, stops})
 * @param opts  file (verdict store), ask (state => {yes, quote, by}; injectable for tests)
 * @returns [{stop_id, event, yes, by, cached}] for every question posed
 */
export async function markCalendarInWords(day, opts = {}) {
  if (process.env.JORI_CALENDAR_IN_WORDS === "0") return [];
  const file = opts.file || VERDICT_FILE;
  const ask = opts.ask || askInWords;
  const out = [];
  let asked = 0;
  for (const c of candidates(day)) {
    const key = verdictKey(c.state);
    const store = readJson(file);
    const hit = store.verdicts && store.verdicts[key];
    let verdict = null, cached = false;
    if (hit && hit.verdict && Date.now() - Date.parse(hit.at) < VERDICT_TTL_MS) {
      verdict = hit.verdict; cached = true;
    } else {
      if (asked >= MAX_ASKS) continue;
      asked += 1;
      try { verdict = await ask(c.state, { id: key.slice(0, 12) }); }
      catch (e) {
        process.stderr.write(`[calendar-in-words] ${c.stop_id}: ${String((e && e.message) || e).split("\n")[0].slice(0, 200)}\n`);
        continue;
      }
      if (!verdict || typeof verdict.yes !== "boolean") continue;
      const fresh = readJson(file);
      const now = Date.now();
      const verdicts = {};
      for (const [k, v] of Object.entries(fresh.verdicts || {})) {
        if (v && now - Date.parse(v.at) < VERDICT_TTL_MS) verdicts[k] = v;
      }
      verdicts[key] = { verdict, at: new Date(now).toISOString(), state: c.state };
      writeJsonAtomic(file, { ...fresh, verdicts });
    }
    if (verdict.yes) {
      c.stop.calendar_event = { ...c.stop.calendar_event, in_his_words: { quote: verdict.quote || null, by: verdict.by || null } };
    }
    out.push({ stop_id: c.stop_id, event: c.state.event.title, yes: verdict.yes, by: verdict.by || null, cached });
  }
  return out;
}

// ---- The trip to a stop ----
// A calendar entry with no place that ends as the user reaches a stop is often the
// way there: "Drive to the airport", 5:15-6:00, and the airport stop from 6:00.
// Calendar fusion (resolve-day) gives an event to the stops it overlaps, so it sat
// on the stop the user left, and the summary listed it under "Events not matched
// to a location" right below the stop it led to. Whether the entry is the trip
// to that place, or something else done before leaving or on the way (a call
// taken in the car), is language (Rule #0b): a model reads it, through the same
// rungs as above. Code picks the questions by timing only and stamps a yes as
// `trip_to` on every copy of the event, which eventsNotMatched in
// daily-summary-render.js honours. It is not corroboration: the stop the user
// left never becomes where the event happened, and the narrator is not told it
// may state the calendar's title. `daily-summary-build prep` calls
// markCalendarTrips; JORI_CALENDAR_TRIP=0 turns it off.

export const TRIP_SITE = "calendar-trip";
// How far the entry's end may sit from the arrival, either side.
export const TRIP_END_SLACK_MIN = 15;
export const TRIP_VERDICT_FILE = process.env.JORI_CALENDAR_TRIP_FILE
  || path.join(HERE, "..", "data", ".cache", "calendar-trip-verdicts.json");
const MAX_TRIP_ASKS = 4;

const TRIP_PROMPT = `You are helping write up the user's day. \`event\` is an entry on the user's calendar with no place of its own. The user left \`left\` and arrived at \`arrived\` (the user's own name for that place) around the time the entry ends. Times are local.

Is this entry the trip to that place: getting there, or taking, dropping off or collecting someone there? Answer true only when the entry's title describes going to that place or to what is there (a flight for an airport, a train for a station). Answer false when the title is something else that could have happened before leaving or on the way (a call, a meeting, a reminder, a block of time), when it names a different place, or when it is too vague to tell. If in doubt, false.

Reply with JSON only: {"trip_to_place": true|false}`;

const eventKey = (ev) => `${ev.summary}|${ev.start}`;

function settledName(stop) {
  const p = stop && stop.provenance;
  if (!p || p.non_stop || (p.tier !== "CONFIRMED" && p.tier !== "CORROBORATED")) return null;
  return p.confirmed_name || p.display_name || null;
}

/** One question per (place-less timed event, stop it ends as the user reaches after travelling). */
export function tripCandidates(day) {
  const stops = (day && day.stops) || [];
  const events = new Map();
  const consider = (ev) => {
    if (!ev || !ev.summary || ev.location || !String(ev.start || "").includes("T")) return;
    if (ev.in_his_words || ev.near_miss_min != null || events.has(eventKey(ev))) return;
    events.set(eventKey(ev), ev);
  };
  for (const s of stops) consider(s && s.calendar_event);
  for (const ev of (day && day.unmatched_calendar_events) || []) consider(ev);
  const slack = TRIP_END_SLACK_MIN * 60000;
  const out = [];
  for (const ev of events.values()) {
    const es = Date.parse(ev.start), ee = Date.parse(ev.end);
    if (!Number.isFinite(es) || !Number.isFinite(ee) || ee <= es) continue;
    for (let i = 1; i < stops.length; i++) {
      const s = stops[i], prev = stops[i - 1];
      const name = settledName(s);
      if (!name || !Number.isFinite(s.start_ts_ms) || !Number.isFinite(prev.end_ts_ms)) continue;
      // A trip between the two stops, the entry under way before the user arrived,
      // still running when the user set off, and over within minutes of the arrival.
      if (prev.end_ts_ms >= s.start_ts_ms || es >= s.start_ts_ms || ee <= prev.end_ts_ms) continue;
      if (Math.abs(ee - s.start_ts_ms) > slack) continue;
      const tz = s.tz || day.tz;
      out.push({ stop_id: s.id, event: ev, state: {
        event: { title: ev.summary, from: wallClock(ev.start, tz), to: wallClock(ev.end, tz) },
        left: { place: settledName(prev) || null, at: prev.end || null },
        arrived: { place: name, from: s.start || null, to: s.end || null },
      } });
    }
  }
  return out;
}

export function tripVerdictKey(state) {
  return createHash("sha1").update(JSON.stringify(state)).update(TRIP_PROMPT).digest("hex");
}

async function askTripLadder(state) {
  const { runToollessDetailed, parseModelJson } = await import("./jev-claude.mjs");
  const { MODELS } = require(path.join(HERE, "models.cjs"));
  const prompt = `${TRIP_PROMPT}\n\nInput:\n${JSON.stringify(state, null, 1)}`;
  const tried = [];
  for (const [tier, model] of [["sonnet", MODELS.sonnet], ["opus", MODELS.opus]]) {
    const { out, error } = await runToollessDetailed({ model, prompt, timeoutMs: 90000 });
    if (error) throw new Error(`calendar-trip ${tier}: ${error.kind}: ${error.message}`);
    const j = parseModelJson(out);
    if (j && typeof j.trip_to_place === "boolean") return { yes: j.trip_to_place, by: tier };
    tried.push(tier);
  }
  throw new Error(`calendar-trip: no tier gave a valid answer (${tried.join(", ")})`);
}

/** Jev first once the site has questions, else the Claude ladder (as for went_to_event above). */
export async function askTrip(state, { id = null } = {}) {
  const { decide } = await import("./jev-shadow.mjs");
  const { answerConfidence, boolOf, jevSiteDef, jevQuestions } = await import("./jev.mjs");
  const def = jevSiteDef(TRIP_SITE) || {};
  if (!def.questions) return askTripLadder(state);
  const { value, used } = await decide({
    site: TRIP_SITE,
    id,
    state,
    questions: jevQuestions(TRIP_SITE),
    interpret: (answers) => {
      const b = boolOf(answers.trip_to_place);
      if (b === null) return { value: null, confidence: 0 };
      return { value: { yes: b, by: "jev" }, confidence: answerConfidence(answers.trip_to_place) };
    },
    legacy: () => askTripLadder(state),
    same: (j, l) => !!(j && j.yes) === !!(l && l.yes),
    privacyScreen: true,
  });
  return value || { yes: false, by: used };
}

/**
 * Stamp `trip_to` on every copy of each calendar event a model reads as the trip
 * to the stop it ends at.
 * @param day   the resolved day ({tz, stops, unmatched_calendar_events})
 * @param opts  file (verdict store), ask (state => {yes, by}; injectable for tests)
 * @returns [{stop_id, event, yes, by, cached}] for every question posed
 */
export async function markCalendarTrips(day, opts = {}) {
  if (process.env.JORI_CALENDAR_TRIP === "0") return [];
  const file = opts.file || TRIP_VERDICT_FILE;
  const ask = opts.ask || askTrip;
  const out = [];
  const tripped = new Map();
  let asked = 0;
  for (const c of tripCandidates(day)) {
    if (tripped.has(eventKey(c.event))) continue;
    const key = tripVerdictKey(c.state);
    const hit = (readJson(file).verdicts || {})[key];
    let verdict = null, cached = false;
    if (hit && hit.verdict && Date.now() - Date.parse(hit.at) < VERDICT_TTL_MS) {
      verdict = hit.verdict; cached = true;
    } else {
      if (asked >= MAX_TRIP_ASKS) continue;
      asked += 1;
      try { verdict = await ask(c.state, { id: key.slice(0, 12) }); }
      catch (e) {
        process.stderr.write(`[calendar-trip] ${c.stop_id}: ${String((e && e.message) || e).split("\n")[0].slice(0, 200)}\n`);
        continue;
      }
      if (!verdict || typeof verdict.yes !== "boolean") continue;
      const fresh = readJson(file);
      const now = Date.now();
      const verdicts = {};
      for (const [k, v] of Object.entries(fresh.verdicts || {})) {
        if (v && now - Date.parse(v.at) < VERDICT_TTL_MS) verdicts[k] = v;
      }
      verdicts[key] = { verdict, at: new Date(now).toISOString(), state: c.state };
      writeJsonAtomic(file, { ...fresh, verdicts });
    }
    if (verdict.yes) tripped.set(eventKey(c.event), { stop_id: c.stop_id, place: c.state.arrived.place, by: verdict.by || null });
    out.push({ stop_id: c.stop_id, event: c.event.summary, yes: verdict.yes, by: verdict.by || null, cached });
  }
  const stamp = (ev) => (ev && tripped.has(eventKey(ev)) ? { ...ev, trip_to: tripped.get(eventKey(ev)) } : ev);
  for (const s of (day && day.stops) || []) if (s && s.calendar_event) s.calendar_event = stamp(s.calendar_event);
  if (day && Array.isArray(day.unmatched_calendar_events)) day.unmatched_calendar_events = day.unmatched_calendar_events.map(stamp);
  return out;
}
