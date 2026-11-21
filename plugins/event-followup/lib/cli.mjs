// event-followup CLI (plugins/event-followup/bin/event-followup).
//
//   event-followup check [--dry-run] [--now <ISO>] [--force]
//        Read the calendar, have a model pick the ended events worth a
//        follow-up, and ask about one (through bin/hum-ask). --dry-run prints
//        what it would ask and writes nothing. --force ignores quiet hours and pacing.
//   event-followup record <ref> --happened yes|no --text "<the user's words, verbatim>"
//                         [--reading "<your reading, one or two sentences>"] [--no-watchlist]
//        File the answer: a day-record entry (bin/day-correction) for the
//        event's day and window; for a film/show that happened, mark it watched
//        on the watchlist (added if missing). Prints JSON with what was done.
//   event-followup check --adopt <calendar event id> --now <ISO after it ended>
//        Backfill: read one past event (the user already said what happened)
//        and keep it under a ref for `record`, without asking anything.
//   event-followup list [--json]          what was judged, asked and recorded
//   event-followup show <ref>             one event's state
//
// <ref> is the short ref in the question id (`evf-<ref>`) or the memory hook
// (`event_followup:<ref>`); either form is accepted.

import {
  settings, readState, writeState, eventKey, refOf, normalizeEvent, windowCandidates,
  inQuiet, paced, readEvents, gogEvents, openTaskTitles, runBin, localDate, OPTIONS,
} from "./event-followup.mjs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./event-followup.mjs";

const require = createRequire(import.meta.url);
const { instance } = require(path.join(ROOT, "lib", "instance.cjs"));

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(`--${n}`);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const tzNow = () => {
  try { return instance().tz || "UTC"; } catch { return "UTC"; }
};

function findByRef(state, ref) {
  const r = String(ref || "").replace(/^evf-/, "").replace(/^event_followup:/, "");
  for (const [key, e] of Object.entries(state.events)) if (e.ref === r) return [key, e];
  return [null, null];
}

async function check() {
  const cfg = settings();
  const tz = tzNow();
  const now = flag("now") ? Date.parse(flag("now")) : Date.now();
  const dry = has("dry-run");
  const force = has("force") || Boolean(flag("adopt"));
  const state = readState();

  if (!force && inQuiet(now, cfg, tz)) return out({ asked: false, why: "quiet hours" });

  const from = new Date(now - (cfg.max_after_end_h + cfg.max_duration_h) * 3600e3).toISOString();
  const to = new Date(now).toISOString();
  const events = [];
  for (const cal of cfg.calendars) {
    try { for (const raw of gogEvents(cal, from, to)) { const ev = normalizeEvent(raw, cal); if (ev) events.push(ev); } }
    catch (e) { console.error(`calendar ${cal}: ${e.message}`); if (!events.length && cfg.calendars.length === 1) return out({ asked: false, why: "calendar read failed", error: e.message }), 2; }
  }
  const adopt = flag("adopt");
  const cands = adopt ? events.filter((ev) => ev.id === adopt) : windowCandidates(events, state, cfg, now);
  if (adopt && !cands.length) return out({ asked: false, why: `event ${adopt} not found in the window` }), 4;
  if (!cands.length) return out({ asked: false, why: "no ended events to judge" });

  const { reading, model } = await readEvents(cands, { tz, owner: instance().owner_name, tasks: openTaskTitles() });
  if (!reading) return out({ asked: false, why: "no usable model reading (will retry next run)", candidates: cands.length });

  const judged = cands.map((ev) => ({ ev, r: reading.get(ev.id) }));
  if (!dry) {
    for (const { ev, r } of judged) {
      if (r.ask) continue;
      state.events[eventKey(ev)] = { ref: refOf(eventKey(ev)), status: "skipped", why: r.why, title: ev.title, start: ev.start, end: ev.end, at: new Date(now).toISOString(), model };
    }
  }
  if (adopt) {
    // Backfill: the user already told us about it. Keep the model's reading so
    // `record` can file it, but send nothing.
    const { ev, r } = judged[0];
    const key = eventKey(ev);
    if (!dry) {
      state.events[key] = { ref: refOf(key), status: "adopted", title: ev.title, start: ev.start, end: ev.end, attendees: ev.attendees,
        kind: r.kind || "other", screen_title: r.screen_title, screen_type: r.screen_type, why: r.why, at: new Date(now).toISOString(), model };
      writeState(state);
    }
    return out({ adopted: true, ref: refOf(key), title: ev.title, reading: r });
  }
  const toAsk = judged.filter((j) => j.r.ask).sort((a, b) => Date.parse(b.ev.end) - Date.parse(a.ev.end));
  if (!toAsk.length) { if (!dry) writeState(state); return out({ asked: false, why: "nothing worth a follow-up", judged: judged.length }); }

  const pace = force ? { ok: true } : paced(state, cfg, now);
  if (dry) return out({ asked: false, dry_run: true, would_ask: toAsk.map(({ ev, r }) => ({ title: ev.title, end: ev.end, ...r })), pace });
  if (!pace.ok) { writeState(state); return out({ asked: false, why: pace.why, waiting: toAsk.length }); }

  const { questionSlotBusy } = await import(path.join(ROOT, "lib", "question-pacing.mjs"));
  if (!force && questionSlotBusy({ now })) { writeState(state); return out({ asked: false, why: "another question is waiting for an answer", waiting: toAsk.length }); }

  const { ev, r } = toAsk[0];
  const key = eventKey(ev);
  const ref = refOf(key);
  const opts = r.kind === "screen"
    ? [{ label: ev.attendees.length ? "Yes, we watched it" : "Yes, I watched it" }, OPTIONS.screen[1]]
    : OPTIONS.default;
  const args = [
    "--id", `evf-${ref}`, "--lane", "event_followup",
    "--subject", ev.title, "--memory-hook", `event_followup:${ref}`,
    "--rationale", `Calendar event "${ev.title}" ended ${ev.end}; follow up so the day's record and taste reflect it.`,
    "--options", JSON.stringify(opts), "--recommended", "1", "--header", "Follow-up",
    "--message", r.question,
  ];
  const sent = runBin("hum-ask", args);
  const landed = sent.code === 0;
  state.events[key] = {
    ref, status: landed ? "asked" : (sent.code === 12 || sent.code === 13 ? "resolved_from_records" : "send_failed"),
    title: ev.title, start: ev.start, end: ev.end, attendees: ev.attendees,
    kind: r.kind, screen_title: r.screen_title, screen_type: r.screen_type,
    question: r.question, question_id: `evf-${ref}`, at: new Date(now).toISOString(), model, exit: sent.code,
  };
  if (sent.code === 3) delete state.events[key]; // send failed: try again next run
  if (landed) state.asks.push(new Date(now).toISOString());
  state.asks = state.asks.filter((t) => now - Date.parse(t) < 7 * 864e5);
  writeState(state);
  return out({ asked: landed, ref, title: ev.title, exit: sent.code, hum_ask: sent.out.slice(0, 400), waiting: toAsk.length - 1 });
}

function record() {
  const state = readState();
  const [key, e] = findByRef(state, argv[1]);
  if (!e) { console.error(`no event with ref ${argv[1]} (event-followup list)`); return 4; }
  const happened = flag("happened");
  if (!["yes", "no"].includes(happened)) { console.error("--happened yes|no is required"); return 2; }
  const text = flag("text");
  if (!text) { console.error("--text \"<the user's words>\" is required"); return 2; }
  const tz = tzNow();
  const date = localDate(e.start, tz);
  const reading = flag("reading") || (happened === "yes"
    ? `The calendar event "${e.title}" took place as planned.`
    : `The calendar event "${e.title}" did not take place.`);
  const dc = runBin("day-correction", ["add", date, "--text", text, "--from", e.start, "--to", e.end,
    "--channel", "chat", "--reading", reading, "--source", `event-followup:${e.ref}`]);
  const result = { ref: e.ref, title: e.title, date, happened, day_record: dc.code === 0 ? "recorded" : `failed: ${dc.err || dc.out}` };

  if (happened === "yes" && e.kind === "screen" && e.screen_title && !has("no-watchlist")) {
    let w = runBin("watchlist", ["mark-watched", e.screen_title]);
    if (w.code !== 0) {
      w = runBin("watchlist", ["add", e.screen_title, "--type", e.screen_type || "movie", "--watched",
        ...(e.attendees?.length ? ["--audience", "together"] : []), "--source", "event-followup",
        "--reason", `Watched ${date} (calendar: ${e.title})`]);
    }
    result.watchlist = w.code === 0 ? w.out.split("\n").pop() : `failed: ${(w.err || w.out).slice(0, 200)}`;
    result.taste_next = "If their words say what they thought, run `watchlist rate \"" + e.screen_title + "\" <loved|liked|meh|disliked|dropped> --note \"<their words>\"`; otherwise the watchlist lane asks \"how was it?\".";
  }
  state.events[key] = { ...e, status: "recorded", happened, answer: text, recorded_at: new Date().toISOString() };
  writeState(state);
  out(result);
  return dc.code === 0 ? 0 : 3;
}

function list() {
  const state = readState();
  const rows = Object.values(state.events).sort((a, b) => String(b.start).localeCompare(String(a.start)));
  if (has("json")) return out(rows);
  for (const r of rows) console.log(`${r.ref}  ${r.status.padEnd(9)} ${r.start?.slice(0, 16)}  ${r.title}${r.why ? `  (${r.why})` : ""}`);
}

function show() {
  const [, e] = findByRef(readState(), argv[1]);
  if (!e) { console.error(`no event with ref ${argv[1]}`); return 4; }
  out(e);
}

const COMMANDS = { check, record, list, show };
if (!COMMANDS[cmd]) {
  console.log("Usage: event-followup check [--dry-run] [--force] | record <ref> --happened yes|no --text \"…\" [--reading \"…\"] | list [--json] | show <ref>");
  process.exit(cmd ? 2 : 0);
}
const code = await COMMANDS[cmd]();
process.exit(typeof code === "number" ? code : 0);
