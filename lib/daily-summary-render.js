"use strict";
// daily-summary-render — deterministic renderer for the daily-summary location
// SPINE. The report agent kept silently dropping photos and merging distinct
// stops (a restaurant lumped into the neighborhood around it). The rule is:
// determine the steps programmatically first, enrich with calendar, only then
// produce the report. So the location spine — stop headers, per-stop photos,
// travel legs, the unmatched-calendar + corrections lists — is now built by
// CODE from resolve-day's output. The agent fills ONLY prose into named slots
// and cannot restructure, rename, relocate, or drop photos.
//
// Three pure functions:
//   buildManifest(resolved)               -> { date, h1, stops:[...], ... }   (for the agent)
//   buildSkeleton(resolved, photoHtmlById) -> HTML string with {{PROSE:id}} / {{ASIDE:id}} / {{QUESTION:id:default}} / {{NIGHT:default}} / {{SECTION}} slots
//   assemble(skeleton, prose)             -> final HTML (slots substituted)
//
// `prose.questions[unknown_stop.id]` and `prose.night` are the two slots that
// override a CODE default rather than filling a blank one (the night one only
// when its times check out — see nightTimesOk). See the {{QUESTION:}} handling in
// assemble() and the matching branch in buildMarkdown(). Everything else about
// the "Corrections & follow-ups" list (which stops appear, their coordinates,
// their candidates[]) stays code-owned; only the sentence asking about them is
// eligible for a model's context-aware phrasing (a model's phrasing reads better
// than an automatic multiple choice).

const { money } = require("./daily-summary-transactions.js");
const { tzAtMs, tzAbbr, crossesZones } = require("./geo-timezone.js");
const { commitLines, placeCommits, PRE_GROUPS } = require("./daily-summary-commits.js");
const { defaultTz } = require("./day-window.js");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Carries the deterministic default question through the skeleton/assemble
// split (see {{QUESTION:id:...}} below) without duplicating the near/candidates
// logic at assemble-time. Base64 because the default text is free-form HTML
// (an address, an em-dash, a candidate name) that could otherwise collide with
// the placeholder's own `:` / `}` delimiters.
function b64(s) { return Buffer.from(String(s), "utf8").toString("base64"); }

// Calendar event titles are reproduced verbatim and can carry an em/en dash
// (e.g. "Drive home — Old Port → Hill Town"); email-send hard-blocks
// those in the outbound body, so swap for a comma at render time only — the
// underlying calendar event is never touched.
function escNoDash(s) {
  return esc(s).replace(/\s*[—–]\s*/g, ", ");
}

// The calendar date itself, named: noon UTC of the date read in UTC is that date
// in every zone's sense, so no zone enters it.
function dayTitle(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const dayName = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const monthDay = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  return { dayName, monthDay, h1: `Day of ${dayName}, ${monthDay}` };
}

// unmatched_calendar_events carry their raw ISO offset (the calendar's home
// zone for most Google Calendar events) -- rendering that substring directly
// reads correct only when the day's display tz also happens to be the home
// zone. On a travel day (a day abroad showed "08:40-11:15" for a 2:40pm-local
// flight) it's off by the tz difference and
// visibly contradicts times stated elsewhere in the same report. Convert to
// the day's actual display tz before rendering.
function hhmmInTz(iso, tz) {
  if (!iso) return "";
  if (!tz) return String(iso).slice(11, 16);
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(11, 16);
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

// The local date (YYYY-MM-DD) of an ISO instant: in `tz` when given, else the
// date the ISO string spells in its own offset (hhmmInTz's raw-digits case).
function ymdInTz(iso, tz) {
  if (!iso) return "";
  if (!tz) return String(iso).slice(0, 10);
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// An event's clock times for a one-line listing. An end on a later date than the
// start (a flight's arrival) is left out: printed bare it reads as ending before
// it began ("9:05am-3:42am"). t1 is "" then.
function eventClock(ev, tz) {
  const t0 = hhmmInTz(ev.start, tz);
  const sameDay = ev.end && ymdInTz(ev.end, tz) === ymdInTz(ev.start, tz);
  return { t0, t1: sameDay ? hhmmInTz(ev.end, tz) : "" };
}

// A day that crossed zones (resolve-day's `tzs` has more than one) labels
// every clock with the zone it was read in — each stop is in the local time of
// where the user was (the local time at each location, when the user was
// there), so without the label the clock would jump unexplained. A
// single-zone day gets no label: it renders exactly as before.
function isMultiTz(day) {
  return !!day && crossesZones(day.tzs, day.tz);
}
function tzTag(day, obj) {
  return isMultiTz(day) && obj && obj.tz_abbr ? ` ${obj.tz_abbr}` : "";
}
// An unmatched calendar event has an instant but no position; read it in the
// zone of the stop the user was at when it started (resolve-day's tzAtMs rule).
function eventTz(day, iso) {
  if (!isMultiTz(day)) return { tz: day.tz, abbr: "" };
  const ms = Date.parse(iso);
  const tz = tzAtMs(day.stops, ms, day.tz) || day.tz;
  return { tz, abbr: ` ${tzAbbr(tz, ms)}` };
}

function fmtDur(min) {
  if (min == null) return "";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function companionsStr(stop) {
  const c = (stop.companions || []).map(x => (typeof x === "string" ? x : x && x.name)).filter(Boolean);
  return c.length ? ` · with ${esc(c.join(" + "))}` : "";
}

// Trailing parentheticals are provenance notes the writer appended, not part of
// the place name: "(confirmed by the user)", "(already reported)",
// "(photo-inferred)". They belong to the tier, not to the venue.
function stripProvenance(n) {
  return String(n || "").replace(
    /\s*\((?:confirmed by [^)]*|already reported|photo[- ]inferred|inferred|guess|unconfirmed)\)\s*$/i,
    "").trim();
}

function placeNameRaw(stop) {
  // The settled day JSON decides identity (daily-summary-day.settleDay ->
  // provenance.title); this file only formats it. Falling through to the
  // resolver's own name is the pre-settle path (a caller that skipped the day
  // builder entirely) and the coordinate fallback is the last resort.
  const p = stop.provenance;
  if (p && p.title) return p.title;
  // A window the user answered as "not a stop" has no venue to name — falling
  // through to the resolver's guess would put the guess back in the manifest
  // (and so in the agent's prose) after the header correctly dropped it.
  if (p && p.non_stop) return "not a stop";
  if (stop.place && stop.place.name) return stop.place.name;
  const la = (typeof stop.lat === "number") ? stop.lat.toFixed(3) : "?";
  const lo = (typeof stop.lon === "number") ? stop.lon.toFixed(3) : "?";
  return `unknown near ${la}, ${lo}`;
}
function placeName(stop) { return stripProvenance(placeNameRaw(stop)); }

// A wake signal (often just "first chat message of the day") can land long
// after GPS shows the user already having left the day's first stop — attaching
// that stop's name to the wake line then asserts the user was still there at a time
// the user demonstrably wasn't (2026-08-06: "Woke 10:17 at Terre de Café" when GPS
// had that stop ending at 09:52). Only name the place when the wake time
// actually falls inside it.
// Compared on instants when both sides have them — on a zone-crossing day the
// wake line and the first stop can be stated in different zones, so their
// HH:MM strings aren't on one axis. Falls back to the strings otherwise.
// What the wake/sleep line may claim (a woke/went-to-sleep line read from weak
// evidence was entirely inaccurate). Only the phone seeing itself used says
// "Woke"; a message, a photo or leaving the flat only proves the user was up BY then.
// The evidence is named so the line can be judged.
const WAKE_EVIDENCE = {
  first_user_message: "first message", phone_context: "first phone check-in", first_photo: "first photo",
  left_overnight_place: "left where you slept", phone_lock_event: "phone unlocked", phone_usage: "phone in use",
  phone_unlocks: "phone unlocked",
};
const SLEEP_EVIDENCE = {
  last_user_message: "last message", phone_context: "last phone check-in", last_photo: "last photo",
  phone_lock_event: "last unlock", phone_usage: "phone last in use",
};
const PHONE_USE = new Set(["phone_unlocks", "phone_lock_event", "phone_usage"]);
const sawPhone = (x) => !!(x.phone_use || PHONE_USE.has(x.source));
// The night record (sleep_nights, 2026-10-08) speaks for itself: the Watch
// measured sleep; the phone saw itself go down / come up.
const NIGHT_WAKE = { night_watch: { verb: "Woke", note: " (Watch)" }, night_phone_up: { verb: "Woke", note: "" } };
const NIGHT_SLEEP = {
  night_watch: { verb: "Fell asleep", note: " (Watch)" },
  night_phone_down: { verb: "Phone down", note: "" },
  "night_phone_down+typical_latency": { verb: "Asleep around", note: " (phone down + usual reading time)" },
};
function wakeWords(w) {
  if (NIGHT_WAKE[w.source]) return NIGHT_WAKE[w.source];
  const ev = WAKE_EVIDENCE[w.source];
  return { verb: sawPhone(w) ? "Woke" : "Up by", note: ev && !sawPhone(w) ? ` (${ev})` : "" };
}
function sleepWords(sl) {
  if (NIGHT_SLEEP[sl.source]) return NIGHT_SLEEP[sl.source];
  const ev = SLEEP_EVIDENCE[sl.source];
  return { verb: sawPhone(sl) ? "Phone last used" : "Last seen up", note: ev && !sawPhone(sl) ? ` (${ev})` : "" };
}

// The day's opening line: the night that led into it — when the user went to sleep
// the evening before, when the user woke, and how long the Watch had the user asleep.
// "Fell asleep 11:48pm (Watch) · Woke 6:52am (Watch) · 6h 54m asleep".
function nightLine(day, stops, fmt) {
  const parts = [];
  if (day.sleep && day.sleep.at) {
    const sw = sleepWords(day.sleep);
    parts.push(`${sw.verb} ${fmt(day.sleep.at)}${tzTag(day, day.sleep)}${sw.note}`);
  }
  if (day.wake && day.wake.at) {
    const w0 = wakeCoherentWithFirstStop(day.wake, stops[0]) ? placeName(stops[0]) : "";
    const ww = wakeWords(day.wake);
    parts.push(`${ww.verb} ${fmt(day.wake.at)}${tzTag(day, day.wake)}${w0 ? ` at ${w0}` : ""}${ww.note}`);
    if (day.wake.asleep_min) parts.push(`${fmtDur(day.wake.asleep_min)} asleep`);
  }
  return parts.length ? parts.join(" · ") : null;
}

// ---------- the night, in words ----------
// The Watch's sleep segments read accurately, so the summary includes them.
// When the Watch recorded the night (resolve-day's `night`), the summary opens
// with it as a sentence instead of the stat line above: when the user fell
// asleep, when the user woke,
// roughly how long, and any wake-up worth naming. Every time and length in it
// is CODE's (sleep-night.js, read in the night's own zone). The narrator may
// say it better in `prose.night`, but only with times it was given — see
// nightTimesOk. Sleep is health data: it lives in this self-addressed email
// and the private day page, nowhere else.
const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const countWord = (k) => COUNT[k] || String(k);
function roughMin(m) {
  return m < 10 ? `${m} minute${m === 1 ? "" : "s"}` : `about ${Math.round(m / 5) * 5} minutes`;
}
function roughHours(min) {
  if (min < 60) return `${min} minutes`;
  const q = Math.round(min / 15), h = Math.floor(q / 4), f = ["", "¼", "½", "¾"][q % 4];
  return `${h}${f} hour${h === 1 && !f ? "" : "s"}`;
}

function nightSentence(n, fmt = fmt12) {
  const t = (hm) => `${fmt(hm)}${n.tz_abbr ? ` ${n.tz_abbr}` : ""}`;
  const ups = n.wakeups || [];
  const lastUp = ups.length && ups[ups.length - 1].final_doze ? ups[ups.length - 1] : null;
  const during = lastUp ? ups.slice(0, -1) : ups;
  const notable = during.filter(w => w.notable);
  const brief = during.length - notable.length;
  const stirrings = `${countWord(brief)} brief stirring${brief === 1 ? "" : "s"}`;
  let lead;
  if (n.woke_range) {
    const r = n.woke_range;
    lead = r.from === r.to
      ? `You fell asleep around ${t(n.fell_asleep)} and were up some time after ${t(r.to)}`
      : `You fell asleep around ${t(n.fell_asleep)} and woke somewhere between ${t(r.from)} and a little after ${t(r.to)}`;
    lead += `; the Watch's last stretch of sleep has no end time, so that's as close as it gets.`
      + ` That's at least ${roughHours(n.asleep_min)} of sleep.`;
  } else if (lastUp) {
    lead = `You fell asleep around ${t(n.fell_asleep)}, surfaced at ${t(lastUp.at)} for ${roughMin(lastUp.min)},`
      + ` dozed a little longer and were up for good at ${t(n.woke)}: about ${roughHours(n.asleep_min)} of actual sleep.`;
  } else {
    lead = `You fell asleep around ${t(n.fell_asleep)} and woke at ${t(n.woke)}: about ${roughHours(n.asleep_min)} of actual sleep.`;
  }
  let rest;
  if (!notable.length && !brief) rest = lastUp ? "Before that it was an unbroken night." : "It was an unbroken night.";
  else if (!notable.length) rest = `${lastUp ? "Before that, a" : "A"} settled night, with just ${stirrings}.`;
  else {
    const plus = brief ? `, plus ${stirrings}` : "";
    rest = notable.length === 1
      ? `You were awake for ${roughMin(notable[0].min)} around ${t(notable[0].at)}${plus}.`
      : `You were up ${countWord(notable.length)} times in the night (${notable.map(w => `${t(w.at)} for ${roughMin(w.min)}`).join(", ")})${plus}.`;
  }
  return `${lead} ${rest}`;
}

// The facts the narrator writes `prose.night` from: every time already in the
// email's 12-hour form (never a zone for it to convert), plus code's sentence.
function nightForNarrator(n) {
  const t = (hm) => `${fmt12(hm)}${n.tz_abbr ? ` ${n.tz_abbr}` : ""}`;
  return {
    fell_asleep: t(n.fell_asleep),
    woke: n.woke ? t(n.woke) : null,
    woke_range: n.woke_range ? { from: t(n.woke_range.from), to_a_little_after: t(n.woke_range.to) } : null,
    asleep: `${n.woke_range ? "at least" : "about"} ${roughHours(n.asleep_min)}`,
    wakeups: (n.wakeups || []).map(w => ({ at: t(w.at), min: w.min,
      ...(w.notable ? { notable: true } : {}), ...(w.final_doze ? { final_doze: true } : {}) })),
    default_sentence: nightSentence(n),
  };
}

// Every clock time the narrator's night paragraph states must be one the code
// computed. A "7:36am" must be one of the night's times exactly; a bare "2am"
// must be within half an hour of one. The chat answer this paragraph comes
// from first called a 04:11Z wake-up 6:11am when it was 7:11am IDT, so the
// narrator quotes and never converts — and a paragraph with a time it wasn't
// given ships code's sentence instead.
const toMin = (h, m, mer) => ((h % 12) + (mer.toLowerCase() === "p" ? 12 : 0)) * 60 + m;
function nightTimesOk(text, n) {
  const allowed = [n.fell_asleep, n.woke, n.woke_range && n.woke_range.from, n.woke_range && n.woke_range.to,
    ...(n.wakeups || []).map(w => w.at)].filter(Boolean)
    .map(hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; });
  if (!text || !allowed.length) return false;
  const near = (min, tol) => allowed.some(a => { const d = Math.abs(a - min) % 1440; return Math.min(d, 1440 - d) <= tol; });
  let seen = 0;
  // lang-regex-ok: clock times in our own narrator's paragraph, each checked against the code-computed set; decides nothing about what the user meant
  for (const m of String(text).matchAll(/\b(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\b\.?)?/gi)) {
    const h = +m[1], mm = +m[2];
    const ok = m[3] ? near(toMin(h, mm, m[3]), 0)
      : (h > 12 ? [h * 60 + mm] : [h * 60 + mm, toMin(h, mm, "a"), toMin(h, mm, "p")]).some(x => near(x, 0));
    if (!ok) return false;
    seen++;
  }
  // lang-regex-ok: bare "2am"-style clock times in our own narrator's paragraph, checked against the code-computed set
  for (const m of String(text).matchAll(/(?<![\d:.])(\d{1,2})\s*([ap])\.?m\b\.?/gi)) {
    if (!near(toMin(+m[1], 0, m[2]), 30)) return false;
    seen++;
  }
  return seen > 0;
}

// What the night paragraph says: the narrator's version when every time in it
// is one of the night's, else code's sentence. A night with only a wake RANGE
// always gets code's sentence: "woke at 7:46am" would pass the time check while
// claiming the precision the range exists to deny.
function nightText(written, n, fallback) {
  const w = typeof written === "string" ? written.trim() : "";
  if (!w) return fallback;
  if (!n.woke_range && nightTimesOk(w, n)) return w;
  process.stderr.write(n.woke_range
    ? "[daily-summary] prose.night ignored: the Watch's last stretch has no end time, so the code's range sentence ships\n"
    : "[daily-summary] prose.night states a time the night's facts don't have; using the code's sentence\n");
  return fallback;
}

function wakeCoherentWithFirstStop(wake, stop) {
  const wakeAt = wake && typeof wake === "object" ? wake.at : wake;
  if (!stop || !stop.start || !stop.end || !wakeAt) return false;
  const ms = wake && typeof wake === "object" ? wake.ts_ms : null;
  if (Number.isFinite(ms) && Number.isFinite(stop.start_ts_ms) && Number.isFinite(stop.end_ts_ms)) {
    return ms >= stop.start_ts_ms && ms <= stop.end_ts_ms;
  }
  return wakeAt >= stop.start && wakeAt <= stop.end;
}


// True when the day's geometry is straight lines between fixes rather than the
// street-matched path — the map-matcher was unreachable (2026-09-01: the public
// Valhalla instance timed out and OSRM returned nothing). Straight lines are a
// FLOOR on the real distance, never the real distance, so every number derived
// from them is marked as approximate rather than stated.
function geometryEstimated(resolved) {
  return ((resolved && resolved.path && resolved.path.stats) || {}).geometry_source
    === "straight_line_fallback";
}

// A walk's own measurements: how far it went, taken from the street-matched
// path. The duration is already in the header's time range, so only distance
// goes here — and only when it's enough to be worth stating.
function excursionMiles(stop) {
  const m = stop.excursion && stop.excursion.routed_m;
  return m != null && m / M_PER_MILE >= 0.1 ? m / M_PER_MILE : null;
}
function excursionMetaHtml(stop, resolved) {
  const mi = excursionMiles(stop);
  if (mi == null) return "";
  const approx = geometryEstimated(resolved) ? "at least " : "";
  return ` <span style="color:#999;">· ${approx}${mi.toFixed(1)} mi</span>`;
}

// Format the settled title. Certainty is visible at a glance: an answered/known venue is bold; a guess is muted and marked;
// a weak guess is shown as approximate with its competing alternatives, never
// asserted as fact.
//
// This function makes NO identity decisions — `title`, `certainty`, `title_kind`
// and `alternatives` are settled upstream in the day JSON (see
// lib/daily-summary-day.js). It only chooses the styling. That's the
// 2026-07-27 split: deciding at render time is what let a title disagree with
// the prose written against a different snapshot of the same day.
function venueHeaderHtml(stop, resolved) {
  const p = stop.provenance;
  if (!p) return `<b>${esc(placeName(stop))}</b>`;
  const name = esc(placeName(stop));

  // A walk from the base and back. Not a hedge and not an absence — it is the
  // slot, so it asserts like any other title, with the distance it covered.
  if (p.excursion) {
    return `<b>${name}</b>${excursionMetaHtml(stop, resolved)}`;
  }

  // A stretch the user told us wasn't a stop: the user's words, else an honest area label,
  // else just "not a stop" — never the nearest POI, never alternatives.
  if (p.non_stop || p.title_kind === "movement") {
    // The title names the PLACE; this marker carries what the user was doing there —
    // the user's own verb when the user gave one, an honest "moving" when we inferred the
    // walk from drift and pace.
    const doing = p.movement_verb || (p.merged_walk ? "moving" : "not a stop");
    // `doing` already IS "not a stop" when there's no verb — don't say it twice
    // (2026-10-07 shipped "9:28am · not a stop, not a stop").
    if (p.certainty === "none" || !p.title) return `<span style="color:#999;">${esc(doing === "not a stop" ? doing : `${doing}, not a stop`)}</span>`;
    return `<span style="color:#555;">${name}</span> <span style="color:#999;">· ${esc(doing)}</span>`;
  }
  if (p.certainty === "none" || !p.title) return `<span style="color:#999;">unlabeled</span>`;
  // An unanswered card's default (2026-10-22): a guess, said as one.
  if (p.probable) return `<span style="color:#999;">probably</span> <span style="color:#555;">${name}</span>`;

  switch (p.certainty) {
    case "answered":
    case "known":
    case "corroborated":
      return `<b>${name}</b>`;
    case "weak_guess": {
      const alts = (p.alternatives || []).filter(Boolean).slice(0, 2);
      const altStr = alts.length
        ? ` <span style="color:#999;">· unconfirmed (also: ${esc(alts.join(", "))})</span>`
        : ` <span style="color:#999;">· unconfirmed</span>`;
      return `<span style="color:#555;">~${name}?</span>${altStr}`;
    }
    case "guess":
    default:
      // An honest area label (neighborhood) isn't hedged — it isn't pretending
      // to be a venue. A single-signal venue guess gets a muted "likely".
      return p.title_kind === "area"
        ? `<b>${name}</b>`
        : `<span style="color:#555;">${name}</span> <span style="color:#999;">· likely</span>`;
  }
}

function normCalWords(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length >= 4);
}

// Gate for printing "· cal: X" on a stop header. Calendar events (all-day or timed) are background cues resolve-day attaches
// to every overlapping stop, never asserted verbatim unless another signal
// confirms them — GPS (the event's own `location` field independently agrees
// with this stop's resolved place, computed as `location_match` in
// enrichStopsWithCalendar) or an answer (chat/txn already confirmed this
// stop's identity and it names the same thing as the event). Plain time
// overlap — which is all `calendar_event` used to require — is not
// corroboration by itself (that's what tagged a multi-day "Stay at ..."
// accommodation block onto every single stop).
// A TIMED event this stop barely overlaps is one the user passed through, not
// one attended — an 11-minute pause on the drive home carried a concert's
// "cal:" line because it fell inside the concert's 2.5h window, 20 km from
// the venue. Long container events (a multi-day stay) are exempt: a 5-hour stop
// can only ever be a sliver of a 9-day block, and that one IS corroboration.
// At the event's own place the bar is lower: the share test exists for a
// stop somewhere else that merely overlaps the event's hours, and a calendar block is
// usually padded past the errand it holds. A 24-minute stop at the place an hour-long
// block names covers 36% of it, and was listed as "not matched" right beside the stop
// that was that event. A quarter of the event at its own place is still required, so
// a short pause by a venue during a long show is not taken for attending it.
const CAL_TIMED_MAX_MIN = 12 * 60;
const CAL_MIN_EVENT_SHARE = 0.4;
const CAL_MIN_EVENT_SHARE_AT_PLACE = 0.25;

function calendarSharesEnough(cal) {
  if (!cal || cal.duration_min == null || cal.duration_min > CAL_TIMED_MAX_MIN) return true;
  if (cal.event_share == null) return true;
  return cal.event_share >= (cal.location_match ? CAL_MIN_EVENT_SHARE_AT_PLACE : CAL_MIN_EVENT_SHARE);
}

// People, as well as places: an event with no location of its own whose title
// names someone the user's record puts at this stop is that stop. A "Sam and
// Alex" event, 8-9pm, sat inside a dinner; the user confirmed they were there,
// the visit row carried them, and the event was still listed as "not matched to
// a location" right under "Restaurant · with Sam + Alex". The
// names are the stop's own companions, compared word for word, the same test
// the venue name gets below. An event placed somewhere else is never matched by
// who was there.
function calendarNamesCompanion(stop, cal) {
  if (cal.location) return false;
  const words = new Set(normCalWords(cal.summary));
  if (!words.size) return false;
  return (stop.companions || []).some((c) => {
    const nameWords = normCalWords(typeof c === "string" ? c : c && c.name);
    return nameWords.length > 0 && nameWords.every((w) => words.has(w));
  });
}

// A place-less event that missed every stop by minutes. Its hours are the plan:
// "Pick up Sam", 17:30-18:00, for a flight that landed at 17:25, and the pickup
// the user described ("Picking up Sam at the airport now", 6:09pm) was
// 18:06-18:12, listed as "not matched" right beside its own stop. Such an event goes
// on the nearest stop within CAL_NEAR_MISS_MIN of it that has no event of its own
// and that someone its title names JOINS the user at (on that stop, not on the one
// before it; for a stop just before the event, someone who is gone by the one after),
// stamped near_miss_min; calendarCorroborated takes it on that person. "Dinner
// with <partner>" cannot land this way: the partner is on every stop. An event a stop overlaps is
// left alone. Run by prep on the resolved day. JORI_CAL_NEAR_MISS=0 turns it off.
const CAL_NEAR_MISS_MIN = 15;
function attachNearMissEvents(day) {
  if (process.env.JORI_CAL_NEAR_MISS === "0") return [];
  const stops = (day && day.stops) || [];
  const nameOf = (c) => (typeof c === "string" ? c : c && c.name);
  const timed = (ev) => ev && ev.summary && String(ev.start || "").includes("T");
  // A place-less event on a stop it no longer overlaps is not that stop's: a stop cut
  // into pieces hands its event to every piece ("Pick up Sam" once rode on two
  // pieces of a 14:12-17:35 blend, ending 17:28). It is unmatched.
  const pool = [...((day && day.unmatched_calendar_events) || [])];
  const key = (ev) => `${ev.summary}|${ev.start}`;
  const pooled = new Set(pool.map(key));
  let released = 0;
  for (const s of stops) {
    const c = s.calendar_event;
    if (!timed(c) || c.location || c.near_miss_min != null) continue;
    if (s.start_ts_ms < Date.parse(c.end) && s.end_ts_ms > Date.parse(c.start)) continue;
    s.calendar_event = null;
    released += 1;
    if (!pooled.has(key(c))) {
      pooled.add(key(c));
      pool.push({ summary: c.summary, location: null, start: c.start, end: c.end,
                  duration_min: Math.round(c.duration_min), physical: false });
    }
  }
  const left = [], out = [];
  for (const ev of pool) {
    const sMs = Date.parse(ev && ev.start), eMs = Date.parse(ev && ev.end);
    let best = null;
    if (timed(ev) && !ev.location
        && Number.isFinite(sMs) && Number.isFinite(eMs)
        && !stops.some((s) => s.start_ts_ms < eMs && s.end_ts_ms > sMs)) {
      stops.forEach((s, i) => {
        if (s.calendar_event || !Number.isFinite(s.start_ts_ms) || !Number.isFinite(s.end_ts_ms)) return;
        const gap = Math.max(s.start_ts_ms - eMs, sMs - s.end_ts_ms);
        if (gap <= 0 || gap > CAL_NEAR_MISS_MIN * 60000) return;
        // After the event: the person is new since the stop before. Before it: gone
        // by the stop after. No stop on that side, no way to tell: left alone.
        const other = stops[s.start_ts_ms >= eMs ? i - 1 : i + 1];
        if (!other) return;
        const there = new Set((other.companions || []).map(nameOf));
        const joined = (s.companions || []).filter((c) => !there.has(nameOf(c)));
        if (!calendarNamesCompanion({ companions: joined }, ev)) return;
        if (!best || gap < best.gap) best = { s, gap };
      });
    }
    if (!best) { left.push(ev); continue; }
    const min = Math.round(best.gap / 60000);
    best.s.calendar_event = { summary: ev.summary, location: null, location_match: false,
      start: ev.start, end: ev.end, duration_min: ev.duration_min, physical: false,
      event_share: 0, near_miss_min: min };
    out.push({ stop_id: best.s.id, event: ev.summary, near_miss_min: min });
  }
  if (out.length || released) day.unmatched_calendar_events = left;
  return out;
}

// And the user's words (2026-10-21): "hilton hotel for the AI conference", the user's answer
// for the 10:30 stop, while "Future of AI 2026 conference" (8am-4pm, no location)
// was listed as not matched right under it. A model read the user's words and said they
// name the event (lib/calendar-in-words.mjs, run by prep): the event is that
// stop, however little of a long event the stop covers, since the user said the user went.
function calendarCorroborated(stop) {
  const cal = stop.calendar_event;
  if (!cal || !cal.summary) return false;
  if (cal.in_his_words && !cal.location) return true;
  // A near miss (attachNearMissEvents) is that stop on the person who joined the user there.
  if (cal.near_miss_min != null) return calendarNamesCompanion(stop, cal);
  if (!calendarSharesEnough(cal)) return false;
  if (cal.location_match) return true;
  if (calendarNamesCompanion(stop, cal)) return true;
  const p = stop.provenance;
  const confirmedName = p && (p.tier === "CONFIRMED" || p.tier === "CORROBORATED")
    ? (p.confirmed_name || p.display_name) : null;
  if (!confirmedName) return false;
  const calWords = new Set([...normCalWords(cal.summary), ...normCalWords(cal.location)]);
  if (calWords.size === 0) return false;
  return normCalWords(confirmedName).some(w => calWords.has(w));
}

// The header is time, place, duration, companions. No `cal:` line — a corroborating calendar event is evidence FOR the title, not
// something to print beside it. When it corroborates, the title is already
// right; restating the event just repeats the stop in machine words. It stays
// in the manifest (`calendar_event.corroborated`), where it does its real job:
// telling the agent what it may state in the prose.
// "12:30pm Lunch at Bistro Example" -- a START time, not a range (start times
// are enough; exact start and end times for events are not needed). GPS stops
// emitting the moment the user sits down, so an end
// time is frequently invented precision. The approximate length belongs in the
// prose, where it can be hedged.
function fmt12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  if (!m) return String(hhmm || "");
  let h = parseInt(m[1], 10);
  const suffix = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m[2]}${suffix}`;
}

function stopHeaderHtml(stop, resolved) {
  return `<h3 style="margin:0 0 6px;font-size:16px;">${esc(fmt12(stop.start) + tzTag(resolved, stop))} · `
    + `${venueHeaderHtml(stop, resolved)}${companionsStr(stop)}</h3>`;
}

// When a walk is not its own block it lives here, in the line between two stops
// -- and a line with no clock on it cannot be placed in the day (the walk has
// its start time next to it). The walk starts when the previous stop ended,
// which is a time we observed: the user was there, then wasn't. Every stop header already carries its own start time this way, so
// the movement between them now reads on the same axis.
function legTimeHtml(fromStop, day) {
  const t = fromStop && fromStop.end;
  return t ? `${esc(fmt12(t) + tzTag(day, fromStop))} · ` : "";
}

function travelHtml(leg, fromStop, toStop, day) {
  if (!leg) return "";
  // A walk block abuts the base stops on both sides, so the derived legs around
  // it are zero minutes long and their straight-line distance is an artefact of
  // the walk's own turnaround coordinate ("0 min (722 m) to next."). There is no
  // journey to describe between two moments that are the same moment.
  if ((leg.duration_min || 0) < 1) return "";
  // The distance is the trace's, not the straight line between the two stops'
  // points (2026-10-16: the airport pickup read "56 min (233 m) to next." for
  // 34.6 km driven out and back, both ends being the flat). Where the spine has
  // the leg, its metres are the figure and its mode the verb; a leg that could
  // not be street-matched is a floor ("at least").
  // A spine leg that began before this stop began, or ends after the next one
  // ended, runs through that stop: it is two journeys, and this gap is only one
  // of them (a drive home, 22:11-23:08, ran through a drop-off at a friend's,
  // 22:29-22:34, a stop the user named that the spine never saw; the 22:34-23:08
  // half held 60% of the leg and printed all of it, "at least 24.0 km"). It is then read like a leg a stop sits inside
  // (spineLegsAround below). JORI_TRAVEL_THROUGH_STOP=0 claims it whole again.
  const through = (n) => process.env.JORI_TRAVEL_THROUGH_STOP !== "0"
    && ((Number.isFinite(fromStop.start_ts_ms) && n.start_ms < fromStop.start_ts_ms - 60_000)
      || (Number.isFinite(toStop.end_ts_ms) && n.end_ms > toStop.end_ts_ms + 60_000));
  const spineLegs = day && fromStop && toStop
    ? spineLegsBetween(day, fromStop.end_ts_ms, toStop.start_ts_ms).filter(n => !through(n)) : [];
  // A street match that came back far shorter than the leg's own straight line
  // matched only part of it (4.9 km between fixes, printed "Drove 9 min (623 m)"), so it is a floor at the straight line, like an
  // unmatched leg. JORI_TRAVEL_PARTIAL_FLOOR=0 trusts any match again.
  const partial = (l) => l.geometry !== "map_matched"
    || (process.env.JORI_TRAVEL_PARTIAL_FLOOR !== "0" && (l.routed_m || 0) < 0.8 * (l.straight_m || 0));
  const legM = (l) => (partial(l) ? Math.max(l.routed_m || 0, l.straight_m || 0) : (l.routed_m || l.straight_m || 0));
  const traced = spineLegs.reduce((t, l) => t + legM(l), 0);
  // A stop inside one leg (the airport pickup inside the drive out and back)
  // leaves each half under half of it, so neither half claims the leg; the leg
  // still says how the user moved, and the straight line between the stops is a floor.
  const around = !spineLegs.length && day && fromStop && toStop
    ? spineLegsAround(day, fromStop.end_ts_ms, toStop.start_ts_ms) : [];
  const km = traced > 0 ? traced / 1000 : leg.distance_km;
  const floor = (traced > 0 && spineLegs.some(partial)) || (traced === 0 && around.length && leg.distance_km) ? "at least " : "";
  const moved = spineLegs.length ? spineLegs : around;
  const drove = moved.length && moved.every(l => l.mode === "driving" && !l.mode_uncertain);
  const dist = km != null ? ` (${floor}${km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(1) + " km"})` : "";
  const dur = leg.duration_min != null ? `${drove ? "Drove " : ""}${fmtDur(leg.duration_min)}` : "";
  // mode is left null by resolve-day; the agent may refine in prose, but the
  // deterministic line just states duration+distance to next.
  const body = [dur, dist].filter(Boolean).join("");
  if (!body) return "";
  return `<p class="travel" style="color:#999;font-style:italic;margin:4px 0 14px;font-size:13px;">${legTimeHtml(fromStop, day)}${esc(body)} to next.</p>`;
}

// Shape a standout transaction for the manifest. `amount_usd` is the
// code-computed string the agent must quote VERBATIM into prose — the agent
// never does the money math (the finance review's rule: quote figures verbatim).
function txnForManifest(t) {
  return {
    merchant: t.merchant,
    amount_usd: money(t.amount),
    category: t.category_label || null,
    payment_channel: t.payment_channel || null,
    pending: !!t.pending,
    stop_id: t.stop_id || null,
  };
}

// -------- the agent-facing manifest --------
// txnData = { standouts:[...], byStopId:{<stop_id>:[...]} } from
// daily-summary-transactions.selectStandouts (optional — empty when no bank
// rows / Plaid unavailable; the spine still builds).
// A `riding` leg the pace could not name is bus, cab or subway -- never a
// bike unless a micromobility charge or the user's own words say so (2026-09-08: the
// narrator wrote "biked home" over a riding/uncertain leg with an MTA tap in
// mobility[]). Plaid carries no intra-day time, so a tap settles the mode only
// when the day has exactly ONE such leg to settle; otherwise the taps ride
// along as evidence and the candidates stay listed.
const RIDE_CANDIDATES = ["subway", "bus", "cab"];
const TAP_MODE = { subway: "subway", rideshare: "cab", micromobility: "bike", rail: "train" };
function settleLegModes(spine, mobility) {
  const legs = spine.filter(n => n.type === "leg");
  const uncertain = legs.filter(l => l.mode === "riding" && l.mode_uncertain);
  const taps = (mobility || []).filter(m => TAP_MODE[m.mode]);
  const tapModes = [...new Set(taps.map(m => TAP_MODE[m.mode]))];
  return spine.map(n => {
    if (n.type !== "leg" || !(n.mode === "riding" && n.mode_uncertain)) return n;
    const evidence = taps.map(m => `${m.merchant} ${m.amount_usd || (m.amount != null ? money(m.amount) : "")}`.trim());
    if (uncertain.length === 1 && tapModes.length === 1) {
      return { ...n, mode: tapModes[0], mode_uncertain: false, mode_evidence: evidence, mode_candidates: [] };
    }
    return { ...n, mode_candidates: [...new Set([...tapModes, ...RIDE_CANDIDATES])], mode_evidence: evidence };
  });
}

function buildManifest(resolved, txnData = {}) {
  const { h1 } = dayTitle(resolved.date);
  const byStopId = txnData.byStopId || {};
  const standouts = txnData.standouts || [];
  return {
    date: resolved.date,
    h1,
    wake: resolved.wake || null,
    sleep: resolved.sleep || null,
    // The Watch's night, for `prose.night` (Step 4.2): quote these, never convert.
    night: resolved.night ? nightForNarrator(resolved.night) : null,
    // >1 = a zone-crossing day: each stop's start/end is in ITS OWN local
    // zone (tz_abbr), and any time the prose states must be too.
    ...(isMultiTz(resolved) ? { tzs: resolved.tzs } : {}),
    stops: (resolved.stops || []).map(s => ({
      id: s.id,
      start: s.start, end: s.end,
      ...(isMultiTz(resolved) && s.tz_abbr ? { tz: s.tz, tz_abbr: s.tz_abbr } : {}),
      place_name: placeName(s),
      place_source: s.place && s.place.source,
      // Provenance tier gates the narrator's LANGUAGE: assert a CONFIRMED /
      // CORROBORATED venue; HEDGE a GUESS ("around X"); for a WEAK_GUESS hedge
      // hard, name the alternatives, never add encyclopedic colour. The H3 is
      // already rendered to match — prose must not contradict it.
      // The SETTLED title — this exact string is what the email header shows.
      // Write prose that agrees with it; if you can't, the title is wrong and
      // belongs back in the confirmed map for another settle pass.
      title: s.provenance ? s.provenance.title : null,
      title_certainty: s.provenance ? s.provenance.certainty : null,
      title_kind: s.provenance ? s.provenance.title_kind : null,
      needs_review: s.needs_review || null,
      // Several browse clusters resolve-day joined into one walk (with the POI
      // guesses it dropped). Describe the stretch, never a venue.
      merged_walk: s.merged_walk || null,
      // What the trace measured under this stop: `witnessed_min` is how much of
      // its span the fixes actually SAW, as against inferred from the phone
      // going quiet, and `corroborated_by` names what agreed the user had stopped
      // besides the GPS positions. Thin witnessing is normal for a still phone,
      // not a defect — but a stop whose fixes saw a small slice of it is one to
      // describe rather than to assert a duration for.
      rest_verified: s.rest_verified || null,
      // A walk out from the nightly base and back with nothing named in it.
      // This IS the slot: write about the walk — where it
      // went, who came, what the weather was — and never invent a venue for it.
      // `routed_m` and `away_m` are measured; state them as given, don't round
      // them into a different claim.
      excursion: s.excursion || null,
      // What the user actually said about the stretch, verbatim. The title is only the
      // place out of it — this is the sentence to draw the prose from.
      movement_note: s.provenance ? (s.provenance.movement_note || null) : null,
      // Named from the trip's lodging record rather than a reverse-geocode.
      accommodation: s.accommodation || null,
      provenance: s.provenance
        ? {
            tier: s.provenance.tier,
            hedge: s.provenance.hedge,
            // The user answered "not a stop" for this window: describe the
            // movement, never a venue — and never re-ask about it.
            non_stop: !!s.provenance.non_stop,
            confirmed_name: s.provenance.confirmed_name || null,
            alternatives: s.provenance.alternatives || [],
            sentiment: s.provenance.sentiment || null,
            signals: s.provenance.signals || [],
          }
        : null,
      duration_min: s.duration_min,
      // A raw-GPS silence inside this dwell that's both long and bracketed by
      // real movement (resolve-day's flagUnloggedExcursions) — a possible trip
      // out and back the phone's own visit detection never split into its own
      // stop. Deterministic fact only; phrase it in prose, don't assert it as
      // certain (the gap could just be a dead phone).
      possible_unlogged_excursion: s.possible_unlogged_excursion || null,
      companions: (s.companions || []).map(x => (typeof x === "string" ? x : x && x.name)).filter(Boolean),
      // An event here cleared the GPS/answer bar (see calendarCorroborated
      // above), so prose may name it. Only an event that corroborates this stop
      // rides on it. One that merely
      // overlapped it is in unmatched_calendar_events below, exactly as the email
      // lists it (eventsNotMatched), so the narrator and the reviewer read the
      // same split the reader sees (the reviewer once saw a contractor's visit to
      // another property on three stops and in the email's unmatched list).
      calendar_event: s.calendar_event && calendarCorroborated(s) ? { ...s.calendar_event, corroborated: true } : null,
      photo_count: (s.photos || []).length,
      lat: s.lat, lon: s.lon,
      // Standout purchases matched to THIS stop (by merchant↔place name). The
      // agent weaves these into the stop's prose with the amount quoted verbatim
      // ("had lunch at Bistro Example and spent $120"). A confident merchant name here
      // also names a stop the GPS resolver only guessed.
      transactions: (byStopId[s.id] || []).map(txnForManifest),
    })),
    unmatched_calendar_events: eventsNotMatched(resolved),
    // Calls (prep's `calls`: the user's recurring calls and the call log). The skeleton prints each as its own line at
    // its time, exactly as `line` reads; do NOT re-list them in prose. A stop's
    // prose may mention one as context (it counts toward the 25% non-location
    // share) but must not retell what was discussed: `talk` is the paragraph code
    // prints under the line (2026-10-21), so prose neither repeats nor adds to it, and a `status: "scheduled"` call
    // (nothing read whether it took place) is never said to have happened. They
    // are not stops: no venue, no visit, no place in the stop count.
    calls: (resolved.calls || []).map(c => {
      const p = callParts(resolved, c);
      return { who: c.who, local_time: p.range, minutes: c.minutes, status: c.status, source: c.source,
        where: p.where || null, line: [p.range, p.title, p.len, p.where, p.meta].filter(Boolean).join(" · "),
        ...(c.talk ? { talk: c.talk, talk_source: c.talk_source || null } : {}),
        ...(c.talk_points ? { talk_points: c.talk_points } : {}) };
    }),
    // Instances on the calendar that did not happen (cancelled, declined, inside
    // a flight, or the user's notes/words say so). Not printed; never narrate them as calls.
    calls_left_out: (resolved.calls_left_out || []).map(x => ({ local_time: callParts(resolved, x).range, why: x.why })),
    unknown_stops: resolved.unknown_stops || [],
    corrections: resolved.corrections || [],
    // Google Tasks CLOSED on this day, chronological, with the local time each
    // was checked off. The skeleton already prints them as their own section —
    // do NOT re-list them in prose. They are here because a closed task often
    // explains a stop ("Install 2-way switches" at 09:40 == the hardware-store
    // run), and because prose may reference one that mattered. What it must
    // never do is contradict or omit the list below it.
    tasks_completed: resolved.tasks_completed || [],
    // Set only when the Google Tasks read itself failed — the section says so
    // rather than showing an empty list, because "closed nothing" and "couldn't
    // look" are different days.
    tasks_completed_error: resolved.tasks_completed_error || null,
    // Every standout purchase of the day (matched + unmatched). Unmatched ones
    // (online buys, merchant≠place label) carry stop_id=null — the agent places
    // them on the most plausible activity using calendar/email context (e.g. a
    // "Disclosure Day" movie event → "two tickets for $66"), else a one-line
    // "Other purchases" anchor. Money math is done; quote `amount_usd` verbatim.
    standout_transactions: standouts.map(txnForManifest),
    // Mobility taps (MTA/tolls/rideshare/parking/fuel) — CONFIRMED travel-mode
    // evidence to reflect in the relevant travel leg ("took the subway down"),
    // NOT a purchase to weave in. Empty when no transit charges that day.
    mobility: (txnData.mobility || []).map(m => ({ merchant: m.merchant, mode: m.mode, amount_usd: money(m.amount), pending: !!m.pending })),
    // Volunteered venue statements mined from the day's chat ("we went to Ping's,
    // disappointing"). Each {stop_id, name, sentiment, quote, at}. The agent VETS
    // these: a clean one promotes its stop to CONFIRMED (the H3 already shows the
    // confirmed name) and should be written back via `daily-summary-build
    // confirm-venue` so the permanent location record self-corrects.
    chat_venue_candidates: txnData.chat_venue_candidates || [],
    // Answers to the day's OWN location-enrich asks, mined from the transcript
    // and already applied to the titles above ({stop_id, kind, label, method}).
    // Listed so you can see WHY a stop is titled the way it is — and catch a
    // mis-bound one before it ships.
    ask_answers: txnData.ask_answers || [],
    // ONE reply that answered SEVERAL asks — the shape a catch-up reply takes
    // after a stretch offline. Deterministic attribution of the pieces would
    // invent facts, so each is listed with every candidate ask + its stop and
    // left to you: read it, decide which part answers which stop, and write them
    // into the confirmed map. The stops it covers are flagged `needs_review`.
    multi_answer_replies: txnData.multi_answer_replies || [],
    // Things the user said while a location ask was open that couldn't be bound to
    // one. Surfaced rather than dropped — a silently lost answer is the failure
    // this whole pass exists to prevent.
    unattributed_replies: txnData.unattributed_replies || [],
    // What each settle pass changed. A title that only appeared on pass 3 got
    // there through a cascade; this is where you check that cascade was right.
    settle_passes: txnData.settle_passes || [],
    // The agent writes ONE prose line per stop id (meaning-first, second-person,
    // <=2 sentences) into prose[id], an optional one-line aside into asides[id],
    // and the cross-cutting sections.
    prose_slots: (resolved.stops || []).map(s => s.id),
    section_slots: ["other_anchors"],
    // The day's spine (2026-09-07): dwell -> leg -> dwell, in order, from the
    // GPS trace reconciled against the visit rows. The frame the narrative
    // hangs on. A dwell's `tier` gates language exactly as `title_certainty`
    // does above: assert `user-confirmed`/`corroborated`, describe a
    // `stay-point` by where it is ("stopped 20 min near 8th & 34th"), and
    // never assert a duration for a dwell whose `witnessed_min` is a sliver
    // of its span. A leg's `confidence` says how much of it the phone saw:
    // "partly inferred" legs carry `holes` -- don't narrate the routed guess,
    // and don't narrate the holes either (no "the phone lost you": GPS
    // silence is never prose). `mode` is what the pace says
    // (walking / riding / driving); `mode_uncertain` means bus, cab or subway
    // could each fit. `his_words` on any node are the user's own statements about
    // that stop or stretch, bound by the model that read them.
    spine: settleLegModes(((resolved.path && resolved.path.spine) || []), txnData.mobility || []).map(n => n.type === "dwell"
      ? { type: "dwell", id: n.id, place: n.place.name, tier: n.place.tier, start: n.start, end: n.end,
          mins: n.mins, witnessed_min: n.witnessed_min, major: n.major, his_words: n.his_words || [] }
      : { type: "leg", id: n.id, from: n.from_name, to: n.to_name, start: n.start, end: n.end, mins: n.mins,
          first_fix: n.first_fix, last_fix: n.last_fix, mode: n.mode, mode_uncertain: !!n.mode_uncertain,
          mode_candidates: n.mode_candidates || [], mode_evidence: n.mode_evidence || [],
          miles: Math.round(((n.routed_m || n.straight_m || 0) / M_PER_MILE) * 10) / 10,
          streets: (n.streets || []).slice(0, 4), confidence: n.confidence,
          holes: (n.holes || []).map(h => ({ from: h.t0, to: h.t1, min: h.min })), his_words: n.his_words || [] }),
    // Visit rows the trace never supported (a departed_at written a day
    // late, a geocode of somewhere the user only passed). Not on the map, not in
    // the spine: do not narrate them.
    records_set_aside: ((resolved.path && resolved.path.unsupported_records) || [])
      .map(u => ({ name: u.name, claimed: u.claimed, reason: u.reason })),
  };
}

// -------- the deterministic skeleton --------
// Only MAJOR dwells are listed as stops: the major dwells, 30 minutes or more,
// not every stop. Everything shorter is movement, and movement belongs BETWEEN
// stops -- "walked 1.5 miles around the old town" -- not as a visit block of its own.
const MAIN_STOP_MIN = 30;
const M_PER_MILE = 1609.344;

// A stop whose identity is SETTLED is a main stop no matter what its GPS
// duration says (a known restaurant meal was longer than the GPS data shows).
// The phone stops emitting fixes the moment the user sits still, so a known
// venue's recorded duration is a LOWER BOUND, not a measurement -- a restaurant
// resolved to 6 minutes and was dropped by the 30-minute threshold, which
// punished exactly the stops the user had already told us about.
//
// This originally accepted only `user_confirmed`, and that gap deleted a
// neighborhood store from a day: resolve-day had it at 15 min, `known_recurring`,
// confidence 0.92, provenance tier CONFIRMED / certainty "known" -- and the
// half-hour bar took it out anyway, folding its 15 minutes into a "26 min
// between stops" line. Worse, the `movement_spared_reason` escape hatch below
// could not save it: that flag is only ever set on stops that were CANDIDATES
// for pace-demotion, and markMovementByPace skips `known_recurring` outright.
// Being confidently named was what disqualified it from the rescue written for
// exactly this case. Meanwhile a 1-minute unlabeled sliver with certainty
// "none" kept its block, because it HAD been a demotion candidate.
// Sources where the resolver holds user-grade truth about WHICH PLACE this
// is — the same set daily-summary-confirm calls RESOLVER_CONFIRMED and
// resolve-day calls isSettledIdentity. All of them mean the name is not a
// guess, which is what the duration bar below is actually screening for.
const SETTLED_SOURCES = new Set([
  "user_confirmed", "user_confirmed_via_transcript", "named_location",
  "known_recurring", "confirmed_stop", "wifi_ssid", "accommodation",
  // One of the user's own saved places, rest-verified — see nameFromSavedPlaces.
  // A 20-minute coffee at a place the user saved must not fall to the bar above
  // for the same reason the 15-minute store should not have.
  "saved_place",
  // The sign in the user's own photo (photo-place-name.js), and a physical calendar
  // event whose location matched the place — both settled by evidence, not
  // proximity; a 126-minute movie must not be judged by its GPS duration.
  "photo_text", "calendar_corroborated",
]);
// The user ANSWERED for this window. No floor of any kind applies: the user's
// word is the measurement, and the GPS duration underneath it is frequently a fiction.
// A confirm-venue write can fail to find a backing location_history "visit" row
// (e.g. the underlying samples were classified "transit"), which left a stop
// the user named in chat — provenance.certainty "answered", settled by `prep` —
// with no way to clear the checks below (two named restaurants were both
// silently dropped from the narrative this way).
function isAnswered(s) {
  const src = (s.place && s.place.source) || "";
  return src === "user_confirmed" || src === "user_confirmed_via_transcript"
    || src === "confirmed_stop"
    || (s.provenance && s.provenance.certainty === "answered");
}
// The RESOLVER knows the name (home, a known-recurring venue, the wifi, the
// lodging). Trustworthy, but not the user's word, so it still has to clear the bar the
// rest of the pipeline uses for "was this even a stop" — 10 minutes, the same
// SHORT_STOP_MIN resolve-day drops guesses at. That keeps a 15-minute store
// while still refusing to make a block out of walking past your own front door.
const KNOWN_STOP_MIN = 10;
function isConfirmed(s) {
  if (isAnswered(s)) return true;
  return SETTLED_SOURCES.has((s.place && s.place.source) || "")
    && (s.duration_min || 0) >= KNOWN_STOP_MIN;
}
function isMainStop(s) {
  if (isConfirmed(s)) return true;     // the name is settled — overrides pace/duration guesses
  // A walk out from the base and back IS the slot when nothing named claimed it.
  // It is movement by construction, so it has to be
  // admitted before the is_movement test below.
  if (s.excursion) return true;
  if (s.user_non_stop) return false;   // the user told us this was NOT a stop
  if (s.is_movement) return false;     // routed pace says the user was walking through
  // An errand is short by definition. `movement_spared_reason` is only set on a
  // window that moved at walking pace AND that the routed path proved was a
  // destination — the user ended it where the user started it, or the user arrived and left by
  // car. Both of the stops that went missing on 2026-08-14/15 were exactly this
  // and both sat under the half-hour bar (Target 23 min, the beach 18), which
  // made the duration test the last of three rules to delete them. Direction is
  // better evidence of a destination than duration is.
  if (s.movement_spared_reason) return true;
  return (s.duration_min || 0) >= MAIN_STOP_MIN;
}
// True when the recorded duration is a floor rather than a figure.
function durationIsFloor(s) {
  return isConfirmed(s) && (s.duration_min || 0) < MAIN_STOP_MIN;
}

// Routed metres between two moments, taken from the street-matched path -- real
// distance along streets, not centroid to centroid.
//
// Summed per LEG. Apportioning a segment's total by elapsed time was wrong
// whenever a day collapsed into one coarse segment, and it does that routinely:
// on 2026-08-31 the whole day was a single `observed` segment of 2,590 m
// spanning 00:00-21:12, so a 26-minute walk was credited 26/1272 of it -- 53 m,
// under the 0.1-mile floor -- and the missing 2.5 km was charged to the hours the user
// spent sitting at home. Legs carry their own metres and their own endpoints,
// which is the only honest way to ask "how far did the user go in this window".
// `matched_m` apportionment stays as the fallback for pre-2026-08-16 paths,
// whose legs were written without endpoints.
function routedMetersBetween(resolved, fromMs, toMs) {
  const segs = (resolved.path && resolved.path.segments) || [];
  let m = 0, sawLeg = false;
  for (const seg of segs) {
    for (const leg of seg.legs || []) {
      if (leg.t1 <= fromMs || leg.t0 >= toMs) continue;
      if (!leg.m) continue;
      sawLeg = true;
      const span = leg.t1 - leg.t0;
      if (span <= 0) { m += leg.m; continue; }
      const ov = Math.min(toMs, leg.t1) - Math.max(fromMs, leg.t0);
      if (ov > 0) m += leg.m * (ov / span);
    }
  }
  if (sawLeg) return m;
  for (const seg of segs) {
    if (!seg.matched_m || !seg.start_ms || !seg.end_ms) continue;
    const span = seg.end_ms - seg.start_ms;
    if (span <= 0) continue;
    const ov = Math.min(toMs, seg.end_ms) - Math.max(fromMs, seg.start_ms);
    if (ov <= 0) continue;
    m += seg.matched_m * (ov / span);
  }
  return m;
}

// routes[] (resolve-day's GPS-speed/straightness mode classifier) is the
// authority on HOW a gap was covered; it's keyed by raw pre-consolidation
// stop ids rather than the final stop ids used here, so legs are matched by
// time overlap instead. Returns the dominant non-walk mode (flew/drove/
// cycled/train/e_scooter_likely) when it outweighs any walked distance in
// the same window, else null.
function dominantNonWalkMode(resolved, fromMs, toMs) {
  let walkedKm = 0, bestMode = null, bestKm = 0;
  for (const r of resolved.routes || []) {
    for (const leg of r.legs || []) {
      const legStart = Date.parse(leg.start), legEnd = Date.parse(leg.end);
      if (!(legStart <= toMs && legEnd >= fromMs)) continue;
      const km = leg.distance_km || 0;
      if (leg.mode === "walked") walkedKm += km;
      else if (km > bestKm) { bestKm = km; bestMode = leg.mode; }
    }
  }
  return bestKm > 1 && bestKm > walkedKm ? bestMode : null;
}

// The spine legs that fall inside a window between two stops (2026-09-07).
// day-path's dwells and resolve-day's stops are cut from the same rows but
// not always at the same minute, so a leg counts when most of it lies in
// the window. Legs carry their own streets, metres and holes: nothing here
// apportions a whole-day segment by elapsed time any more.
function spineLegsBetween(resolved, fromMs, toMs) {
  const spine = (resolved.path && resolved.path.spine) || [];
  return spine.filter(n => {
    if (n.type !== "leg" || !n.start_ms || !n.end_ms) return false;
    const span = Math.max(1, n.end_ms - n.start_ms);
    const ov = Math.min(toMs, n.end_ms) - Math.max(fromMs, n.start_ms);
    return ov / span >= 0.5;
  });
}

// The spine legs between two stops, read along the spine itself (2026-10-24).
// A stop and the dwell it was cut from can begin minutes apart, so a leg can lie
// just inside the next stop's window, and the time test above drops it: on Oct 24
// the walk back from the café ended in a 509 m leg that began 5 s after the flat's
// stop did, and the 247 m walk home from the wedding lunch began as the flat's
// stop began, so the lines said "Walked 0.4 miles" and "3 min between stops"
// while the header, summing every walking leg, said 2.2 miles over lines adding
// to 1.7. The gap is every leg after the last dwell that is `a` and before the
// first dwell that is `b`. A stop the spine has no dwell for (a drop-off it never
// saw) keeps the time test.
function spineLegsBetweenStops(resolved, a, b) {
  const spine = (resolved.path && resolved.path.spine) || [];
  const isStop = (n, s) => {
    if (n.type === "leg" || !n.start_ms || !n.end_ms) return false;
    if (!Number.isFinite(s.start_ts_ms) || !Number.isFinite(s.end_ts_ms)) return false;
    const ov = Math.min(s.end_ts_ms, n.end_ms) - Math.max(s.start_ts_ms, n.start_ms);
    // half of the shorter: the night's dwell is the morning's stop though the stop is 50 min of its 8 h
    const shorter = Math.max(1, Math.min(n.end_ms - n.start_ms, s.end_ts_ms - s.start_ts_ms));
    return ov > 0 && ov >= 0.5 * shorter;
  };
  let i = -1;
  spine.forEach((n, k) => { if (isStop(n, a)) i = k; });
  const j = i < 0 ? -1 : spine.findIndex((n, k) => k > i && isStop(n, b));
  if (i < 0 || j < 0) return spineLegsBetween(resolved, a.end_ts_ms, b.start_ts_ms);
  return spine.slice(i + 1, j).filter(n => n.type === "leg");
}

// The metres day-path scaled a leg's walked_m from (its walk_metres): the street
// match, or the straight line where the match is faster than a walk over the
// leg's time and the straight line is not, the router's detour. Measuring walked_m
// against the street match instead called a detoured walk mostly ridden (2026-10-24:
// lunch to the flat, 247 m walked of a 502 m match in 4 min, printed "3 min
// between stops" under a header that counted it).
const WALK_MAX_KMH = 7;   // day-path's WALK_PAIR_MAX_KMH
function walkBasisM(l) {
  const h = (l.end_ms - l.start_ms) / 3_600_000;
  if (l.routed_m && l.straight_m && h > 0 && l.routed_m > l.straight_m
      && l.routed_m / 1000 / h > WALK_MAX_KMH && l.straight_m / 1000 / h <= WALK_MAX_KMH) return l.straight_m;
  return l.routed_m || l.straight_m || 0;
}

// The spine leg a whole gap sits inside (a minute's slack either side).
function spineLegsAround(resolved, fromMs, toMs) {
  const spine = (resolved.path && resolved.path.spine) || [];
  return spine.filter(n => n.type === "leg" && n.start_ms && n.end_ms
    && n.start_ms <= fromMs + 60_000 && n.end_ms >= toMs - 60_000);
}

// The minutes a walk line prints are the gap between the two stops' edges, not
// the walk's own time, and a stop held through a silence leaves only a sliver of
// it. When the distance over that gap is a pace no one walks (over WALK_MAX_KMH),
// the distance stands and the duration is left out ("Walked 0.3 miles ... about
// 4 min" read as 7 km/h, 2026-10-28).
function walkPaceOk(metres, mins) {
  return !(mins > 0 && metres / 1000 / (mins / 60) > WALK_MAX_KMH);
}

// Walking belongs BETWEEN stops, not as a stop of its own.
// `acc`, when given, collects the metres a "Walked N miles" line prints (acc.m),
// so the header can be the sum of the lines under it (printedWalkMeters).
function movementHtml(resolved, a, b, acc = null) {
  const mins = Math.round((b.start_ts_ms - a.end_ts_ms) / 60000);
  if (mins < 1) return "";
  // A gap actually covered by a flight/drive/etc. is not a walk, no matter
  // what the street-matched path guesses (2026-08-13: "Walked 1090.8 miles
  // ... about 7h 44m" for a Paris->Lisbon flight leg). Defer to travelHtml's
  // mode-neutral duration+distance line instead of asserting the wrong mode.
  // The spine's mode is measured on the leg's own fixes (median pace over
  // ~10 fixes up 8th Avenue); routes[] is location-segment's coarser
  // classifier, which on 2026-09-06 spanned one "drove" leg from a 10:11 fix
  // at home to a 13:38 fix near the theatre -- across the three-hour stint at
  // home -- and silenced the walk. When the spine covers the window, it is the
  // authority; routes[] only speaks for windows the spine has no leg in.
  const spineLegs = spineLegsBetweenStops(resolved, a, b);
  if (!spineLegs.length && dominantNonWalkMode(resolved, a.end_ts_ms, b.start_ts_ms)) return "";
  if (spineLegs.length) {
    // The pace on the spine says how the gap was covered; a riding/driving
    // leg is not a walk and gets the mode-neutral line.
    if (spineLegs.some(l => l.mode && l.mode !== "walking")) return "";
    // Only the metres covered at walking pace (walked_m, 2026-10-13). A leg
    // that was mostly covered faster than a walk was ridden or driven, even
    // when its median fix pace says walking (Mamilla → the National Library,
    // 2.8 km in 11 min, printed "Walked 1.8 miles").
    const full = spineLegs.reduce((t, l) => t + walkBasisM(l), 0);
    const m = spineLegs.reduce((t, l) => t + (l.walked_m != null ? l.walked_m : (l.routed_m || l.straight_m || 0)), 0);
    if (full > 0 && m < 0.5 * full) return "";
    const miles = m / M_PER_MILE;
    const streets = [];
    for (const l of spineLegs) for (const st of l.streets || []) if (!streets.includes(st)) streets.push(st);
    const where = streets.length ? ` along ${esc(streets.slice(0, 2).join(" and "))}` : "";
    // A leg's holes are not said (no sentence about missing GPS, anywhere). This
    // line once printed "the phone lost you for 8 min of it" after the prose rule
    // had banned it everywhere else.
    const est = spineLegs.some(l => l.geometry !== "map_matched") ? "at least " : "";
    if (acc && miles >= 0.1) acc.m += m;
    const body = miles >= 0.1
      ? `Walked ${est}${miles.toFixed(1)} miles${where}${walkPaceOk(m, mins) ? `, about ${fmtDur(mins)}` : ""}.`
      : `${fmtDur(mins)} between stops.`;
    return `<p class="travel" style="color:#888;font-style:italic;margin:6px 0 14px;">${legTimeHtml(a, resolved)}${body}</p>`;
  }
  const miles = routedMetersBetween(resolved, a.end_ts_ms, b.start_ts_ms) / M_PER_MILE;
  const streets = [];
  const legSpanMs = Math.max(b.start_ts_ms - a.end_ts_ms, 1);
  for (const seg of (resolved.path && resolved.path.segments) || []) {
    if (!seg.start_ms || seg.end_ms < a.end_ts_ms || seg.start_ms > b.start_ts_ms) continue;
    // A day-path segment sometimes spans the whole day as one coarse blob
    // (sparse GPS collapses everything into a single street-matched run) —
    // its `streets[]` is then a flat aggregate with no per-leg timing, so
    // "first two streets" is really "first two streets of the whole day",
    // repeated identically on every leg regardless of where it actually ran
    // (2026-08-06: "around Rue du Temple and Rue des Haudriettes" printed for
    // a Bastille-to-Rue-de-la-Roquette leg that never went near either). Only
    // trust a segment's street list when it's reasonably scoped to this leg.
    const segSpanMs = seg.end_ms - seg.start_ms;
    if (segSpanMs > legSpanMs * 3 && segSpanMs > 2 * 60 * 60 * 1000) continue;
    // Nor when most of the segment ran before or after this gap: its list has
    // no times, so its first streets are those of the other stretch.
    const insideMs = Math.min(seg.end_ms, b.start_ts_ms) - Math.max(seg.start_ms, a.end_ts_ms);
    if (process.env.JORI_WALK_STREETS_INSIDE !== "0" && insideMs < 0.5 * segSpanMs) continue;
    for (const st of seg.streets || []) if (!streets.includes(st)) streets.push(st);
  }
  const where = streets.length ? ` around ${esc(streets.slice(0, 2).join(" and "))}` : "";
  if (acc && miles >= 0.1) acc.m += miles * M_PER_MILE;
  const body = miles >= 0.1
    ? `Walked ${geometryEstimated(resolved) ? "at least " : ""}${miles.toFixed(1)} miles${where}${walkPaceOk(miles * M_PER_MILE, mins) ? `, about ${fmtDur(mins)}` : ""}.`
    : `${fmtDur(mins)} between stops.`;
  return `<p class="travel" style="color:#888;font-style:italic;margin:6px 0 14px;">${legTimeHtml(a, resolved)}${body}</p>`;
}

// The metres the email prints as walked: every "Walked N miles" line between two
// of `stops` (the stops it draws) plus every walk block's own "· N mi". The
// header's "miles walked" is this sum, so the two can never disagree (2026-10-25:
// "1.0 miles walked" over lines adding to 2.0, the beach walk's leg being moded
// riding and so left out of a header that summed the spine's walking legs, while
// the walk block over it printed its mile).
function printedWalkMeters(resolved, stops) {
  let m = 0;
  for (const s of stops) if (excursionMiles(s) != null) m += s.excursion.routed_m;
  for (let i = 0; i + 1 < stops.length; i++) {
    const acc = { m: 0 };
    movementHtml(resolved, stops[i], stops[i + 1], acc);
    m += acc.m;
  }
  return m;
}

// -------- calendar events no stop accounts for --------
// Every calendar event appears (daily-summary.md Step 2). One that no stop
// overlapped is `unmatched_calendar_events`; one a stop overlapped but whose
// place did not match it (not `corroborated`) is never printed at the stop, by
// design, so it belongs here too. It once vanished: a contractor's 5-8pm visit
// to another property overlapped three stops and appeared nowhere. Timed events on the day only; an event that
// corroborates any stop is that stop. One a model read as the trip to the stop it
// ends at (`trip_to`, lib/calendar-in-words.mjs markCalendarTrips: "Drive to the
// airport" and the airport stop) is the way there, so it is not listed either.
function eventsNotMatched(day) {
  const key = (ev) => `${ev.summary}|${ev.start}`;
  const onDay = (ev) => ev && ev.summary && String(ev.start || "").includes("T")
    && String(ev.start).slice(0, 10) === day.date;
  const stops = day.stops || [];
  const matched = new Set(stops.filter(s => s.calendar_event && calendarCorroborated(s)).map(s => key(s.calendar_event)));
  for (const ev of [...stops.map(s => s.calendar_event), ...(day.unmatched_calendar_events || [])]) {
    if (ev && ev.trip_to) matched.add(key(ev));
  }
  const seen = new Set(), out = [];
  const add = (ev) => {
    if (!onDay(ev) || matched.has(key(ev)) || seen.has(key(ev)) || isCallEvent(day, ev)) return;
    seen.add(key(ev));
    out.push(ev);
  };
  for (const ev of day.unmatched_calendar_events || []) add(ev);
  for (const s of stops) if (s.calendar_event && !calendarCorroborated(s)) add(s.calendar_event);
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
// -------- calls: their own line in the timeline --------
// The user's calls (a recurring call, when it happens, and the call log) are in
// the daily summary. `day.calls` is settled by prep (the installation's call
// reader: the calendar instance, screened, then Zoom's record of the other side
// in the user's room, else a model's reading of whether it took place). This
// file only places and words it. A call is not a visit: it is never a stop, an
// <h3>, a map point or part of the stop count, and no prose slot can rename or
// drop it. Its calendar event is that line, so it leaves "Events not matched".
// Matched on the instant, not the ISO string, so an offset difference can't
// list it twice.
function isCallEvent(day, ev) {
  const t = Date.parse(ev && ev.start);
  return (day.calls || []).some(c => (c.calendar && c.calendar.summary === ev.summary
    && Date.parse(c.calendar.start) === t) || callCoversEvent(c, ev));
}

// A call from the call log (Zoom's record, with no calendar instance of its own)
// is the meeting a timed, non-physical event booked when the two start within 15
// minutes of each other and the call covers at least half the event. Listed both
// as the call line and under "Events not matched", one meeting read as two
// (a 9:32-10:34 Zoom call and its 9:30-10:30 invite).
const CALL_EVENT_START_SLACK_MS = 15 * 60000;
function callCoversEvent(c, ev) {
  if (!c || c.calendar || !ev || ev.physical === true || ev.physical === "true") return false;
  const cs = Date.parse(c.start), ce = Date.parse(c.end);
  const es = Date.parse(ev.start), ee = Date.parse(ev.end);
  if (![cs, ce, es, ee].every(Number.isFinite) || ce <= cs || ee <= es) return false;
  if (Math.abs(cs - es) > CALL_EVENT_START_SLACK_MS) return false;
  return Math.min(ce, ee) - Math.max(cs, es) >= 0.5 * (ee - es);
}

// Where the user took it: the stop the user spent most of the call at. With none, the last
// stop before it when the day's path shows nothing between (no stop, no leg,
// under 3 hours): a still phone stops emitting, so the flat the user was last seen in
// is likely where the call was taken, and it is worded "likely". Without a path
// to check for movement, nowhere.
const CALL_STAYED_MAX_MS = 3 * 3600 * 1000;
function callWhere(day, call) {
  const stops = day.stops || [];
  const s0 = Date.parse(call.start), s1 = Date.parse(call.end);
  let best = null, bestOv = 0;
  for (const s of stops) {
    const ov = Math.min(s1, s.end_ts_ms) - Math.max(s0, s.start_ts_ms);
    if (ov > bestOv) { bestOv = ov; best = s; }
  }
  if (best) return { stop: best, basis: "overlap" };
  const before = stops.filter(s => s.end_ts_ms <= s0).sort((a, b) => b.end_ts_ms - a.end_ts_ms)[0];
  if (!before || !day.path || s0 - before.end_ts_ms > CALL_STAYED_MAX_MS) return null;
  const between = (t) => t >= before.end_ts_ms && t < s1;
  const moved = stops.some(s => s !== before && between(s.start_ts_ms))
    || ((day.path && day.path.spine) || []).some(n => n.type === "leg" && between(n.start_ms));
  return moved ? null : { stop: before, basis: "stayed" };
}

// The place, worded with the certainty its header carries; a walk or a stretch
// that was not a stop names nothing.
function callWhereText(day, call) {
  const w = callWhere(day, call);
  if (!w) return "";
  const s = w.stop, p = s.provenance;
  if (s.excursion || (p && (p.excursion || p.non_stop || p.title_kind === "movement"))) return "";
  if (!p) return SETTLED_SOURCES.has((s.place && s.place.source) || "") ? `${w.basis === "overlap" ? "" : "likely "}at ${placeName(s)}` : "";
  if (!p.title) return "";
  const settled = ["answered", "known", "corroborated"].includes(p.certainty) || p.title_kind === "area";
  if (settled && w.basis === "overlap") return `at ${placeName(s)}`;
  return settled || p.certainty === "guess" ? `likely at ${placeName(s)}` : "";
}

// The line's parts, every clock in the zone the user was in (resolve-day's day tz, or
// the stop's on a zone-crossing day). Calendar times are the slot, not a
// measurement, and say so; with no reading of whether it took place, it is
// worded as on the calendar, never as a fact. Zoom times are measured (the other
// side's time in the user's room), so they read "ran 38 min" and carry no
// caveat. A call from the call log (every call, not only the recurring one) says
// where its points came from ("from Zoom's AI summary"), since Zoom's AI can
// get them wrong.
function callParts(day, call, fmt = fmt12) {
  const { tz, abbr } = eventTz(day, call.start);
  const z = tz || day.tz || defaultTz();
  return {
    key: hhmmInTz(call.start, z),
    range: `${fmt(hhmmInTz(call.start, z))}-${fmt(hhmmInTz(call.end, z))}${abbr}`,
    title: call.who ? `Call with ${call.who}` : "Call",
    len: call.source === "zoom" ? `ran ${fmtDur(call.minutes)}` : fmtDur(call.minutes),
    // lang-regex-ok: strips dashes from our own line for the email-send gate; decides no meaning
    where: callWhereText(day, call).replace(/\s*[—–]\s*/g, ", "),
    meta: call.status === "scheduled" ? "on your calendar, not confirmed"
      : call.source === "calendar" ? "calendar times" : (call.ai_note || ""),
  };
}

// A call is a bullet in the work list, set like the work lines (bold time,
// then plain text), with what was discussed as short sub-bullets: a bullet
// under the stop, a very short one-liner for each topic discussed. Under a
// stop it joins that stop's work list in time order (assemble merges them) and
// drops the "at <place>" its header already says; a call outside any stop gets
// a one-item list of its own. The points are the model's (prep's call reader);
// with none, the paragraph prints under the bullet instead.
function callItemHtml(day, call, { inStop = false } = {}) {
  const p = callParts(day, call);
  const where = inStop ? "" : p.where;
  return `<li class="call"><b>${esc(p.range)}</b> ${esc(p.title)} · ${esc(p.len)}${where ? ` · ${esc(where)}` : ""}`
    + `${p.meta ? ` <span style="color:#999;">· ${esc(p.meta)}</span>` : ""}`
    + callTalkHtml(call) + `</li>`;
}

function callLineHtml(day, call) {
  return `<ul class="worked" style="margin:6px 0 12px;padding-left:20px;color:#444;font-size:14px;">${callItemHtml(day, call)}</ul>`;
}

// What was talked about (the daily summary includes a paragraph on it): written
// by a model from Zoom's transcript or summary, else the user's notes for the
// call, and attached by prep as `call.talk_points` (one-liners) and `call.talk`.
function callTalkHtml(call) {
  const pts = (call.talk_points || []).filter(Boolean);
  if (pts.length) {
    return `<ul class="call-talk" style="margin:2px 0 4px;padding-left:18px;color:#555;">`
      + pts.map(t => `<li>${esc(t)}</li>`).join("") + `</ul>`;
  }
  if (!call.talk) return "";
  return `<p class="call-talk" style="margin:2px 0 4px;color:#555;line-height:1.5;">${esc(call.talk)}</p>`;
}

function callLineMd(day, call, { inStop = false } = {}) {
  const p = callParts(day, call, (hm) => hm);
  // the call log's calls name the person's wiki page (`who_md`, a [[link]]), so the day page links to them
  const title = call.who_md ? `Call with ${call.who_md}` : p.title;
  // a bullet like the work lines (commitsMd), the points as sub-bullets
  const line = `- **${p.range}** ${[title, p.len, inStop ? "" : p.where, p.meta].filter(Boolean).join(" · ")}`;
  const pts = (call.talk_points || []).filter(Boolean);
  if (pts.length) return [line, ...pts.map(t => `  - ${t}`)].join("\n");
  return call.talk ? `${line}\n\n  ${call.talk}` : line;
}

// Each call goes right after the stop it began in (before the walk or drive to
// the next one), after that walk or drive when it began between stops, and
// before the first stop when it began before any. `stops` = the ones shown.
function placeCalls(day, stops) {
  const before = [], inStop = {}, afterLeg = {};
  const calls = (day.calls || []).slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const c of calls) {
    const t = Date.parse(c.start);
    let anchor = null;
    for (const s of stops) if (s.start_ts_ms <= t && (!anchor || s.start_ts_ms >= anchor.start_ts_ms)) anchor = s;
    if (!anchor) { before.push(c); continue; }
    const slot = t < anchor.end_ts_ms ? inStop : afterLeg;
    (slot[anchor.id] = slot[anchor.id] || []).push(c);
  }
  return { before, inStop, afterLeg };
}

// Where it was, as far as the event says: a place, "(virtual)" for a link, and
// nothing at all when it gives no location (it used to say "(virtual)" there).
function eventWhere(ev, escape = (x) => x) {
  if (ev.location) return ev.physical ? escape(ev.location) : "(virtual)";
  return ev.physical === false ? "(virtual)" : "";
}

// -------- closed tasks: one line each, chronological --------
// A task closed on a day is a first-class fact about that day, so it is emitted by CODE into its own section rather than left
// to prose, where it could be summarized away. `due` is shown only when it
// differs from the day it was closed — that gap is the interesting part.
function taskLineParts(t, date) {
  const bits = [];
  if (t.list && t.list !== "My Tasks") bits.push(t.list);
  if (t.due && t.due !== date) bits.push(`due ${t.due}`);
  return { time: t.completed_at || "", title: String(t.title || "").trim(), meta: bits.join(" · ") };
}

// travel_legs join each stop to the next one in the whole day, but the email
// prints only the main stops. Two printed stops with a short dwell between them
// (a halt in traffic) had no leg between them, so the gap printed nothing: a
// 2h 41m drive between an afternoon at the flat and an evening stop had no line
// at all (2026-10-29). The leg over the hidden stops runs from the end of one
// printed stop to the start of the next, and its distance is the sum of the legs
// it spans; travelHtml then reads the trace over the same window as for any gap.
// JORI_TRAVEL_OVER_HIDDEN=0 prints nothing there again.
function legOverHidden(allStops, legs, fromId, toId) {
  if (process.env.JORI_TRAVEL_OVER_HIDDEN === "0") return undefined;
  const i = allStops.findIndex(s => s.id === fromId);
  const j = allStops.findIndex(s => s.id === toId);
  if (i < 0 || j <= i + 1) return undefined;
  const chain = [];
  for (let k = i; k < j; k++) {
    const l = legs.find(x => x.from === allStops[k].id && x.to === allStops[k + 1].id);
    if (!l) return undefined;
    chain.push(l);
  }
  const a = allStops[i], b = allStops[j];
  const mins = Number.isFinite(a.end_ts_ms) && Number.isFinite(b.start_ts_ms)
    ? Math.round((b.start_ts_ms - a.end_ts_ms) / 60_000)
    : chain.reduce((t, l) => t + (l.duration_min || 0), 0);
  const km = chain.every(l => l.distance_km != null) ? chain.reduce((t, l) => t + l.distance_km, 0) : null;
  return { from: fromId, to: toId, duration_min: mins, distance_km: km, mode: null, over_hidden: j - i - 1 };
}

function buildSkeleton(resolved, photoHtmlById = {}) {
  const { h1 } = dayTitle(resolved.date);
  const allStops = resolved.stops || [];
  // Short dwells are not dropped from the day -- they are on the map, and their
  // time is inside the movement line that spans them.
  const stops = allStops.filter(isMainStop);
  const legs = resolved.travel_legs || [];
  const legBetween = (fromId, toId) => legs.find(l => l.from === fromId && l.to === toId)
    || legOverHidden(allStops, legs, fromId, toId);

  const out = [];
  out.push(`<div style="max-width:600px;margin:0 auto;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#222;line-height:1.5;">`);
  out.push(`<h1 style="font-size:22px;margin:0 0 4px;">${esc(h1)}</h1>`);

  // The map is the first thing in the summary. It is a
  // static PNG because email cannot run Leaflet; `day-path --png --upload`
  // renders the same HTML the interactive view uses and stores it in Supabase.
  if (resolved.map_url) {
    const st = (resolved.path && resolved.path.stats) || {};
    // path.stats.walked_km is actually the day's total street-MATCHED distance
    // (every mode included, mislabeled) -- on a flight day it reads "1161
    // miles walked" (2026-08-13). Rebuild it the same way the per-leg travel
    // lines do: sum routedMetersBetween() over consecutive stop gaps, but only
    // where routes[] doesn't say the gap was actually flown/driven/cycled --
    // keeps the caption consistent with the "Walked N miles" lines below it.
    let walkedKm = null;
    const spineLegs = ((resolved.path && resolved.path.spine) || []).filter(n => n.type === "leg");
    if ((spineLegs.length || (resolved.routes && resolved.routes.length)) && stops.length >= 2
        && process.env.JORI_WALKED_FROM_LINES !== "0") {
      // what the lines and walk blocks below print, summed (printedWalkMeters);
      // a day of one stop has no lines to agree with and keeps the legs' sum
      walkedKm = printedWalkMeters(resolved, stops) / 1000;
    } else if (spineLegs.length) {
      // one sum, from the same nodes the header and the travel lines read
      walkedKm = spineLegs.filter(l => l.mode === "walking")
        // walked_m (2026-10-13): only the metres covered at walking pace — a
        // leg moded "walking" by its median can still hold a drive.
        .reduce((t, l) => t + (l.walked_m != null ? l.walked_m : (l.routed_m || l.straight_m || 0)), 0) / 1000;
    } else if (resolved.routes && resolved.routes.length) {
      walkedKm = 0;
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i], b = stops[i + 1];
        if (dominantNonWalkMode(resolved, a.end_ts_ms, b.start_ts_ms)) continue;
        walkedKm += routedMetersBetween(resolved, a.end_ts_ms, b.start_ts_ms) / 1000;
      }
    } else {
      walkedKm = st.walked_km;
    }
    // ...and a figure that rounds to nothing is not a measurement. The user once
    // walked from the flat to two cafés and back, about 500 m inside one spine
    // dwell, so no leg was moded walking and the caption
    // said "0.0 miles walked". Walking the spine never saw is not no walking.
    if (walkedKm != null && walkedKm / 1.609344 < 0.05) walkedKm = null;
    const cap = [
      walkedKm != null
        ? `${geometryEstimated(resolved) ? "at least " : ""}${(walkedKm / 1.609344).toFixed(1)} miles walked`
        : null,
      stops.length ? `${stops.length} stops` : null,
      st.dwell_h_reconciled != null ? `${st.dwell_h_reconciled}h at stops` : null,
    ].filter(Boolean).join(" · ");
    // The map is re-rendered to the SAME storage path on every rebuild, and
    // Gmail's image proxy caches by URL — a regenerated summary showed the
    // morning's map (2026-09-07). A version query makes each build's map a
    // new URL to the proxy while the object stays one file.
    const mapVersion = Date.parse(resolved.generated_at || "") || Date.now();
    const mapSrc = `${resolved.map_url}${resolved.map_url.includes("?") ? "&" : "?"}v=${mapVersion}`;
    out.push(`<img src="${esc(mapSrc)}" width="600" alt="Map of the day" style="width:100%;max-width:600px;height:auto;border-radius:8px;margin:10px 0 4px;display:block;">`);
    if (cap) out.push(`<p style="color:#999;font-size:12px;margin:0 0 16px;">${esc(cap)}</p>`);
  }

  if (resolved.night) {
    // Code's sentence and the facts that judge the narrator's, carried to
    // assemble() like a {{QUESTION:}} default.
    const slot = b64(JSON.stringify({ text: nightSentence(resolved.night), night: resolved.night }));
    out.push(`<p style="margin:0 0 16px;">{{NIGHT:${slot}}} {{SLEEP}} {{WAKE}}</p>`);
  } else {
    const night = nightLine(resolved, stops, (hm) => fmt12(hm));
    if (night) out.push(`<p style="color:#555;margin:0 0 16px;">${esc(night)}. {{SLEEP}} {{WAKE}}</p>`);
  }
  // What the user worked on before the first stop (and what Jori did while the user
  // slept): a diary runs in time order, so it sits here, ahead of the first
  // stop's header, and not under it. Filled at assemble from the commits slot.
  out.push(`{{COMMITS_PRE}}`);

  // Calls, each its own line at its time — never a stop (see placeCalls).
  const calls = placeCalls(resolved, stops);
  for (const c of calls.before) out.push(callLineHtml(resolved, c));
  stops.forEach((s, i) => {
    out.push(`<div class="visit" style="margin:0 0 4px;">`);
    out.push(stopHeaderHtml(s, resolved));
    out.push(`<p style="margin:0 0 6px;">{{PROSE:${s.id}}}</p>`);
    out.push(`{{ASIDE:${s.id}}}`);
    out.push(`{{WORKED:${s.id}}}`);
    const inStop = (calls.inStop[s.id] || []).map(c => ({ key: callParts(resolved, c).key, html: callItemHtml(resolved, c, { inStop: true }) }));
    if (inStop.length) out.push(`{{CALLITEMS:${s.id}:${Buffer.from(JSON.stringify(inStop), "utf8").toString("base64")}}}`);
    const ph = photoHtmlById[s.id];
    if (ph && ph.trim()) out.push(`<div class="photos">${ph}</div>`);
    out.push(`</div>`);
    const next = stops[i + 1];
    if (next) {
      const mv = movementHtml(resolved, s, next);
      out.push(mv || travelHtml(legBetween(s.id, next.id), s, next, resolved));
    }
    // Work that landed after this stop ended: after its travel line (placeCommits).
    out.push(`{{WORKED_AFTER:${s.id}}}`);
    for (const c of calls.afterLeg[s.id] || []) out.push(callLineHtml(resolved, c));
  });

  // The day's commits — what the user worked on — go under the stop the user was at
  // ({{WORKED:id}} above). Which commits and where is code's (placed again here
  // against the stops this email shows); the plain-language words are the
  // narrator's prose.commits, so the lists are filled at assemble time.
  if ((resolved.commits || []).length || resolved.commits_error) {
    const commits = placeCommits(resolved.commits, stops);
    const slot = Buffer.from(JSON.stringify({ commits, multi: isMultiTz(resolved),
      error: resolved.commits_error || null }), "utf8").toString("base64");
    out.push(`{{COMMITS:${slot}}}`);
  }

  const closedTasks = resolved.tasks_completed || [];
  if (closedTasks.length || resolved.tasks_completed_error) {
    out.push(`<h2 style="font-size:17px;margin:22px 0 6px;">Tasks closed today</h2>`);
    if (resolved.tasks_completed_error) {
      out.push(`<p style="color:#a00;font-size:13px;margin:0 0 6px;">Couldn't read Google Tasks for this day (${esc(String(resolved.tasks_completed_error).slice(0, 120))}) — this list may be incomplete.</p>`);
    }
    if (closedTasks.length) {
      out.push(`<ul style="margin:0;padding-left:20px;">`);
      for (const t of closedTasks) {
        const { time, title, meta } = taskLineParts(t, resolved.date);
        // 12-hour like every other time in the email (2026-10-08 review note).
        out.push(`<li><b>${esc((time ? fmt12(time) : "") + tzTag(resolved, t))}</b> ${esc(title)}`
          + (meta ? ` <span style="color:#999;">· ${esc(meta)}</span>` : "") + `</li>`);
      }
      out.push(`</ul>`);
    }
  }

  // resolve-day's calendar fetch window is wider than the target day (it
  // covers the sleep tail past midnight), so unmatched_calendar_events can
  // include events dated the NEXT day — scope this section to the target
  // date only, or a "tomorrow" event reads as if scheduled for today.
  const unmatched = eventsNotMatched(resolved);
  if (unmatched.length) {
    out.push(`<h2 style="font-size:17px;margin:22px 0 6px;">Events not matched to a location</h2><ul style="margin:0;padding-left:20px;">`);
    for (const ev of unmatched) {
      const { tz: evTz, abbr } = eventTz(resolved, ev.start);
      const { t0, t1 } = eventClock(ev, evTz);
      const loc = eventWhere(ev, esc);
      out.push(`<li><b>${fmt12(t0)}${t1 ? `–${fmt12(t1)}` : ""}${esc(abbr)}</b> ${escNoDash(ev.summary)}${loc ? ` · ${loc}` : ""}</li>`);
    }
    out.push(`</ul>`);
  }

  out.push(`{{OTHER_ANCHORS}}`);

  const unknown = resolved.unknown_stops || [];
  const corr = resolved.corrections || [];
  if (unknown.length || corr.length) {
    out.push(`<h2 style="font-size:17px;margin:22px 0 6px;">Corrections &amp; follow-ups</h2><ul style="margin:0;padding-left:20px;">`);
    for (const u of unknown) {
      // A named shortlist the user can answer with one word beats "Tell me?" — the
      // 2026-09-02 Mama's TOO! line offered nothing to pick from. With a
      // shortlist, the "near ..." clause is dropped unless we have a real place
      // to name: coordinates tell the user nothing the list doesn't.
      const cands = (u.candidates || []).filter(c => c && c.name);
      const where = u.hint || (cands.length ? null : `${(u.lat || 0).toFixed(3)}, ${(u.lon || 0).toFixed(3)}`);
      const nearPart = where ? ` near ${esc(where)}` : "";
      const ask = cands.length
        ? ` — ${cands.map(c => `<b>${esc(c.name)}</b>${c.distance_m != null ? ` (${c.distance_m}m)` : ""}`).join(", ")}, or somewhere else?`
        : `, but I didn't capture a label. Tell me?`;
      const defaultLi = `~${u.start}-${u.end}${esc(tzTag(resolved, u))}${nearPart}${ask}`;
      out.push(`<li>{{QUESTION:${u.id}:${b64(defaultLi)}}}</li>`);
    }
    for (const c of corr) {
      const snip = esc(String(c.text || c.body || "").slice(0, 80));
      out.push(`<li>Your message said "${snip}". Is that a correction? I'll update memory if you confirm.</li>`);
    }
    out.push(`</ul>`);
  }

  out.push(`</div>`);
  return out.join("\n");
}

// -------- markdown: the same day, rendered for the wiki --------
//
// The resulting JSON is stored in the database and the wiki renders from it.
//
// The wiki page used to be produced by converting the EMAIL HTML back to
// markdown (`lib/episode-html-to-md.js`), which made a presentation format
// the source of truth and every wiki page a lossy derivative of it. Worse, it
// froze history: a renderer improvement applied only to days rendered after it
// shipped. Rendering markdown from the same settled JSON the HTML comes from
// means one set of decisions, two outputs, and a re-render that can be replayed
// over stored days.
//
// Deliberately NOT a markdown-ification of the HTML — it reads the same fields
// and re-decides nothing, exactly like buildSkeleton.

function mdTitle(stop) {
  const p = stop.provenance;
  const name = placeName(stop);
  if (!p) return `**${name}**`;
  if (p.excursion) {
    const mi = excursionMiles(stop);
    return `**${name}**${mi == null ? "" : ` · ${mi.toFixed(1)} mi`}`;   // day-level estimate note lives in the caption
  }
  if (p.non_stop || p.title_kind === "movement") {
    const doing = p.movement_verb || (p.merged_walk ? "moving" : "not a stop");
    if (p.certainty === "none" || !p.title) return doing === "not a stop" ? doing : `${doing}, not a stop`;
    return `${name} · ${doing}`;
  }
  if (p.certainty === "none" || !p.title) return "unlabeled";
  if (p.probable) return `probably ${name}`;
  switch (p.certainty) {
    case "answered":
    case "known":
    case "corroborated":
      return `**${name}**`;
    case "weak_guess": {
      const alts = (p.alternatives || []).filter(Boolean).slice(0, 2);
      return `~${name}?` + (alts.length ? ` · unconfirmed (also: ${alts.join(", ")})` : " · unconfirmed");
    }
    case "guess":
    default:
      return p.title_kind === "area" ? `**${name}**` : `${name} · likely`;
  }
}

/**
 * Render the settled day + the agent's prose as wiki markdown.
 *   day    the settled day JSON (stops carry `provenance` and, for photos to
 *          appear, `photo_urls` — stamped at publish time by `daily-summary-build
 *          publish`, since the JSON itself only holds photo uuids).
 *   prose  the agent's slots: { prose: {stop_id: text}, asides, other_anchors, … }
 */
function buildMarkdown(day, prose = {}) {
  const { h1 } = dayTitle(day.date);
  const p = prose.prose || {};
  const a = prose.asides || {};
  const stops = day.stops || [];
  const legs = day.travel_legs || [];
  const out = [`# ${h1}`, ""];

  const caveats = [prose.sleep_caveat, prose.wake_caveat].filter(Boolean).join(" ");
  if (day.night) {
    out.push(`${nightText(prose.night, day.night, nightSentence(day.night))}${caveats ? " " + caveats : ""}`, "");
  } else {
    const night = nightLine(day, stops, (hm) => hm);
    if (night) out.push(`${night}.${caveats ? " " + caveats : ""}`, "");
  }

  const calls = placeCalls(day, stops);
  const worked = commitsMd(day, prose.commits);
  out.push(...worked.pre);
  for (const c of calls.before) out.push(callLineMd(day, c), "");
  stops.forEach((s, i) => {
    const dur = s.duration_min != null ? ` · ${fmtDur(s.duration_min)}` : "";
    const comps = (s.companions || []).map(x => (typeof x === "string" ? x : x && x.name)).filter(Boolean);
    out.push(`### ${s.start}-${s.end}${tzTag(day, s)} · ${mdTitle(s)}${dur}${comps.length ? ` · with ${comps.join(" + ")}` : ""}`, "");
    if (p[s.id]) out.push(p[s.id], "");
    if (a[s.id]) out.push(`*${a[s.id]}*`, "");
    const callMd = (calls.inStop[s.id] || []).map(c => callLineMd(day, c, { inStop: true }));
    if (worked.byStop[s.id] || callMd.length) out.push(...(worked.byStop[s.id] || []), ...callMd, "");
    for (const url of (s.photo_urls || [])) out.push(`![](${url})`);
    if ((s.photo_urls || []).length) out.push("");
    const next = stops[i + 1];
    const leg = next && legs.find(l => l.from === s.id && l.to === next.id);
    // Same zero-length-leg artefact travelHtml suppresses — see there.
    if (leg && (leg.duration_min || 0) >= 1) {
      const dist = leg.distance_km != null
        ? ` (${leg.distance_km < 1 ? Math.round(leg.distance_km * 1000) + " m" : leg.distance_km.toFixed(1) + " km"})` : "";
      const d = leg.duration_min != null ? fmtDur(leg.duration_min) : "";
      if (d || dist) out.push(`${s.end}${tzTag(day, s)} · ${d}${dist} to next.`, "");
    }
    for (const c of calls.afterLeg[s.id] || []) out.push(callLineMd(day, c), "");
  });

  out.push(...worked.rest);

  const closedTasks = day.tasks_completed || [];
  if (closedTasks.length || day.tasks_completed_error) {
    out.push("## Tasks closed today", "");
    if (day.tasks_completed_error) {
      out.push(`_Couldn't read Google Tasks for this day (${String(day.tasks_completed_error).slice(0, 120)}) — this list may be incomplete._`, "");
    }
    for (const t of closedTasks) {
      const { time, title, meta } = taskLineParts(t, day.date);
      out.push(`- **${time}${tzTag(day, t)}** ${title}${meta ? ` · ${meta}` : ""}`);
    }
    out.push("");
  }

  const unmatched = eventsNotMatched(day);
  if (unmatched.length) {
    out.push("## Events not matched to a location", "");
    for (const ev of unmatched) {
      // Raw ISO digits on a single-zone day (unchanged); a zone-crossing day
      // converts like the email does — see eventTz.
      const { tz: evTz, abbr } = isMultiTz(day) ? eventTz(day, ev.start) : { tz: null, abbr: "" };
      const { t0, t1 } = eventClock(ev, evTz);
      const loc = eventWhere(ev);
      out.push(`- **${t0}${t1 ? `-${t1}` : ""}${abbr}** ${String(ev.summary || "").replace(/\s*[—–]\s*/g, ", ")}${loc ? ` · ${loc}` : ""}`);
    }
    out.push("");
  }

  if (prose.other_anchors) {
    out.push("## Day's other anchors", "", String(prose.other_anchors).replace(/<[^>]+>/g, "").trim(), "");
  }

  const unknown = day.unknown_stops || [];
  const corr = day.corrections || [];
  const q = prose.questions || {};
  if (unknown.length || corr.length) {
    out.push("## Corrections & follow-ups", "");
    for (const u of unknown) {
      // The agent's context-aware hypothesis overrides the coordinate-dump
      // default when supplied — see buildSkeleton's {{QUESTION:}} slot and
      // jobs/daily-summary.md Step 4.2.
      if (q[u.id]) { out.push(`- ${q[u.id]}`); continue; }
      const cands = (u.candidates || []).filter(c => c && c.name);
      const where = u.hint || (cands.length ? null : `${(u.lat || 0).toFixed(3)}, ${(u.lon || 0).toFixed(3)}`);
      const nearPart = where ? ` near ${where}` : "";
      const ask = cands.length
        ? ` — ${cands.map(c => `${c.name}${c.distance_m != null ? ` (${c.distance_m}m)` : ""}`).join(", ")}, or somewhere else?`
        : `, but I didn't capture a label.`;
      out.push(`- ~${u.start}-${u.end}${tzTag(day, u)}${nearPart}${ask}`);
    }
    for (const c of corr) {
      out.push(`- Your message said "${String(c.text || c.body || "").slice(0, 80)}". Is that a correction?`);
    }
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// -------- the day's commits (daily-summary-commits.js) --------
// Listed under the stop where the user worked; only a day with no stop to hang them
// on (or a git read that failed) gets a section of its own.
const COMMITS_H2 = "What you worked on";

// `calls` = the stop's call items ({key: "HH:MM", html: "<li ...>"}), merged
// into the list in time order.
function workedListHtml(lines, multi, calls = []) {
  if (!lines.length && !calls.length) return "";
  const items = lines.map(l => ({ key: l.time || "",
    html: `<li><b>${esc(fmt12(l.time) + (multi && l.tz_abbr ? ` ${l.tz_abbr}` : ""))}</b> ${esc(l.text)}</li>` }))
    .concat(calls).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return `<ul class="worked" style="margin:0 0 6px;padding-left:20px;color:#444;font-size:14px;">`
    + items.map(i => i.html).join("") + `</ul>`;
}

// -> { byStop: {stop_id: html}, pre: html for the sections ahead of the first
//      stop, rest: html for lines with no stop at all + the error note }
function commitsHtml(d, written, stopIds, afterIds = new Set()) {
  const { lines, parts } = commitLines(d.commits, written);
  const byStop = {}, afterStop = {}, preLines = {}, loose = [];
  for (const l of lines) {
    if (l.stop_id && l.after_stop && afterIds.has(l.stop_id)) (afterStop[l.stop_id] = afterStop[l.stop_id] || []).push(l);
    else if (l.stop_id && stopIds.has(l.stop_id)) (byStop[l.stop_id] = byStop[l.stop_id] || []).push(l);
    else if (l.pre) (preLines[l.pre] = preLines[l.pre] || []).push(l);
    else loose.push(l);
  }
  const html = {}, after = {};
  for (const [id, ls] of Object.entries(byStop)) html[id] = workedListHtml(ls, d.multi);
  for (const [id, ls] of Object.entries(afterStop)) after[id] = workedListHtml(ls, d.multi);
  const pre = PRE_GROUPS.filter(g => (preLines[g.key] || []).length)
    .map(g => `<h2 style="font-size:17px;margin:22px 0 6px;">${esc(g.label)}</h2>${workedListHtml(preLines[g.key], d.multi)}`).join("");
  const rest = [];
  if (loose.length || d.error) {
    rest.push(`<h2 style="font-size:17px;margin:22px 0 6px;">${COMMITS_H2}</h2>`);
    if (d.error) rest.push(`<p style="color:#a00;font-size:13px;margin:0 0 6px;">Couldn't read the day's commits (${esc(String(d.error).slice(0, 120))}) — this list may be incomplete.</p>`);
    const looseSet = new Set(loose);
    for (const p of parts) {
      const ls = p.lines.filter(l => looseSet.has(l));
      if (ls.length) rest.push(`<p style="margin:8px 0 2px;color:#666;font-size:13px;">${esc(p.label)}</p>${workedListHtml(ls, d.multi)}`);
    }
  }
  return { byStop: html, lines: byStop, after, multi: d.multi, pre, rest: rest.length ? `<div class="commits">${rest.join("")}</div>` : "" };
}

function commitsMd(day, written) {
  const commits = placeCommits(day.commits, day.stops || []);
  const { lines } = commitLines(commits, written);
  const tag = (l) => `- **${l.time}${isMultiTz(day) && l.tz_abbr ? ` ${l.tz_abbr}` : ""}** ${l.text}`;
  const byStop = {}, preLines = {}, loose = [];
  for (const l of lines) {
    if (l.stop_id) (byStop[l.stop_id] = byStop[l.stop_id] || []).push(tag(l));
    else if (l.pre) (preLines[l.pre] = preLines[l.pre] || []).push(tag(l));
    else loose.push(tag(l));
  }
  const pre = [];
  for (const g of PRE_GROUPS) if ((preLines[g.key] || []).length) pre.push(`## ${g.label}`, "", ...preLines[g.key], "");
  const rest = [];
  if (loose.length || day.commits_error) {
    rest.push(`## ${COMMITS_H2}`, "");
    if (day.commits_error) rest.push(`_Couldn't read the day's commits (${String(day.commits_error).slice(0, 120)}) — this list may be incomplete._`, "");
    if (loose.length) rest.push(...loose, "");
  }
  return { byStop, pre, rest };
}

// -------- assemble: substitute the agent's prose into the skeleton --------
function assemble(skeleton, prose = {}) {
  let html = skeleton;
  const p = prose.prose || {};
  const a = prose.asides || {};
  const q = prose.questions || {};
  // per-stop prose
  html = html.replace(/\{\{PROSE:([^}]+)\}\}/g, (_, id) => esc(p[id] || "").replace(/&lt;br&gt;/g, "<br>") || "");
  // per-stop aside (optional italic line)
  html = html.replace(/\{\{ASIDE:([^}]+)\}\}/g, (_, id) => {
    const t = a[id];
    return t ? `<p class="aside" style="margin:0 0 6px;"><em style="color:#666;">${esc(t)}</em></p>` : "";
  });
  // per-unknown-stop follow-up question: the agent's context-aware hypothesis
  // ("did you visit Dominick again at Bellevue hospital before the show?")
  // overrides the deterministic coordinate-dump default when supplied — see
  // jobs/daily-summary.md Step 4.2. The default is carried base64-encoded
  // rather than recomputed here so this file doesn't duplicate the
  // near/candidates logic in buildSkeleton.
  html = html.replace(/\{\{QUESTION:([^:}]+):([^}]+)\}\}/g, (_, id, b64default) => {
    const override = q[id];
    if (override) return esc(override);
    try { return Buffer.from(b64default, "base64").toString("utf8"); }
    catch { return ""; }
  });
  html = html.replace(/\{\{NIGHT:([^}]+)\}\}/g, (_, slot) => {
    let d;
    try { d = JSON.parse(Buffer.from(slot, "base64").toString("utf8")); } catch { return ""; }
    return esc(nightText(prose.night, d.night, d.text));
  });
  // The day's commits: read the data slot first, then fill each stop's list.
  let worked = { byStop: {}, pre: "", rest: "" };
  const cm = /\{\{COMMITS:([^}]+)\}\}/.exec(html);
  if (cm) {
    try {
      const d = JSON.parse(Buffer.from(cm[1], "base64").toString("utf8"));
      const ids = new Set([...html.matchAll(/\{\{WORKED:([^}]+)\}\}/g)].map(m => m[1]));
      const afterIds = new Set([...html.matchAll(/\{\{WORKED_AFTER:([^}]+)\}\}/g)].map(m => m[1]));
      worked = commitsHtml(d, prose.commits, ids, afterIds);
    } catch {}
  }
  // A stop's calls join its work list (callItemHtml); the slot is our own.
  const callItems = {};
  html = html.replace(/\{\{CALLITEMS:([^:}]+):([^}]+)\}\}/g, (_, id, slot) => {
    try { callItems[id] = JSON.parse(Buffer.from(slot, "base64").toString("utf8")); } catch {}
    return "";
  });
  html = html.replace(/\{\{WORKED:([^}]+)\}\}/g, (_, id) => (callItems[id]
    ? workedListHtml((worked.lines || {})[id] || [], worked.multi, callItems[id])
    : worked.byStop[id] || ""));
  html = html.replace(/\{\{WORKED_AFTER:([^}]+)\}\}/g, (_, id) => (worked.after || {})[id] || "");
  html = html.replace(/\{\{COMMITS:([^}]+)\}\}/g, () => worked.rest);
  html = html.replace(/\{\{COMMITS_PRE\}\}/g, () => worked.pre);
  html = html.replace(/\{\{WAKE\}\}/g, esc(prose.wake_caveat || ""));
  html = html.replace(/\{\{SLEEP\}\}/g, esc(prose.sleep_caveat || ""));
  html = html.replace(/\{\{OTHER_ANCHORS\}\}/g,
    prose.other_anchors ? `<h2 style="font-size:17px;margin:22px 0 6px;">Day's other anchors</h2>${prose.other_anchors}` : "");
  return html;
}

/**
 * Which of a stop's photos `photos embed-uuids` could not show, from its exit
 * status and stderr: one `[embed-uuids] thumb failed <uuid>: <reason>` line per
 * photo it dropped, or every photo when the step itself failed. Until
 * 2026-10-17 those lines went to the build's stderr and nowhere else, so two of
 * Friday Oct 16's photos (Milk Bakery, August) were in the day and silently
 * absent from both emails. Pure.
 */
function photosNotShown(stop, run) {
  const photos = ((stop && stop.photos) || []).filter((p) => p && p.uuid);
  if (!photos.length) return [];
  const row = (p, reason) => ({ uuid: p.uuid, taken_at: p.ts || p.taken_at || null, reason });
  if (!run || run.status !== 0) return photos.map((p) => row(p, "the photo embed step failed"));
  const byUuid = new Map(photos.map((p) => [p.uuid, p]));
  const out = [];
  for (const line of String(run.stderr || "").split("\n")) {
    const m = line.match(/^\[embed-uuids\] thumb failed (\S+): (.*)$/); // lang-regex-ok: bin/photos' own stderr line
    if (m && byUuid.has(m[1])) out.push(row(byUuid.get(m[1]), m[2].trim().slice(0, 160)));
  }
  return out;
}

module.exports = { buildManifest, buildSkeleton, buildMarkdown, assemble, dayTitle, photosNotShown, attachNearMissEvents, _internal: { settleLegModes, nightLine, nightSentence, nightForNarrator, nightTimesOk, nightText, esc, placeName, stopHeaderHtml, geometryEstimated, taskLineParts, calendarCorroborated, eventsNotMatched, eventWhere, isCallEvent, callCoversEvent, eventClock, walkPaceOk, callWhere, callWhereText, callParts, fmtDur, callLineHtml, callItemHtml, callTalkHtml, callLineMd, placeCalls, isMainStop, isConfirmed, isAnswered, routedMetersBetween, movementHtml, printedWalkMeters, travelHtml, legOverHidden, mdTitle, MAIN_STOP_MIN, KNOWN_STOP_MIN } };
