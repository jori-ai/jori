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
