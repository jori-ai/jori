"use strict";
// daily-summary-review (lib) — the review pieces that are arithmetic or schema,
// kept apart from the CLI (bin/daily-summary-review) so they can be tested
// without a model.
//
// Rule #0b split: code compares times, applies edits to named slots and keeps
// score; a model (Opus, 2026-10-15) reads the report and decides what is wrong
// and how to say it better. Nothing here interprets language: the only string
// inspection is of our OWN generated markup.
//
// Origin: a summary opened "7:00am · Café Example" while its own night
// paragraph said the Watch had the user asleep until 7:29. The review then ran
// on Sonnet at medium effort over the report text alone, with none of the facts
// that would have shown the two disagreed. So before sending, another model
// review (Opus level) catches issues and inconsistencies and repairs them.

// A stop the user named themself, the user's homes and the lodging base legitimately begin
// before the user woke (the user slept there). Mirrors resolve-day `widensThroughSleep`.
const SLEEP_EXEMPT_SOURCES = new Set(["user_confirmed", "named_location", "known_recurring", "accommodation"]);
const ONSET_SLACK_MIN = 20; // a stop that began as the user was dropping off is not a contradiction
const WOKE_SLACK_MIN = 10;  // nor one that began as the Watch's wake time rounds
const OVERLAP_SLACK_MIN = 2;

const { defaultTz } = require("./day-window.js");
const { companionNames } = require("./companions.js");

const SEVERITY_WEIGHT = { high: 3, medium: 1, low: 0 };

const MIN_MS = 60000;

function clock(ms, tz) {
  const t = new Intl.DateTimeFormat("en-US", { timeZone: tz || defaultTz(), hour: "numeric", minute: "2-digit" })
    .format(new Date(ms));
  return t.toLowerCase().split(" ").join("");
}

// A day-JSON stop carries its settled title in provenance.title; place.name is the
// resolver's name before the settle (2026-10-22: the photo lines called the Oct 21
// walk "Walk in גן הכובשים" while the report and the stop list said "Walk back to
// the apartment from הקוסם", and the reviewer flagged two names for one walk).
const titleOf = (s) => (s && (s.title || (s.provenance && s.provenance.title) || (s.place && s.place.name))) || "a stop";

/**
 * Stops that begin while the Watch has the user asleep. The day JSON carries the
 * night's own instants (`night.onset_at`, `night.wake_at`); a venue stop whose
 * start falls strictly between them is a stop that began before the user woke. This
 * is the 2026-10-14 defect, caught here whatever produced it. Pure.
 */
function stopsBeforeWake(day) {
  const n = day && day.night;
  if (!n || n.woke_range) return [];
  const onset = Date.parse(n.onset_at), woke = Date.parse(n.wake_at);
  if (!Number.isFinite(onset) || !Number.isFinite(woke) || woke <= onset) return [];
  const out = [];
  for (const s of (day.stops || [])) {
    if (SLEEP_EXEMPT_SOURCES.has(s.place && s.place.source)) continue;
    if (s.user_non_stop) continue;
    const st = s.start_ts_ms;
    if (!Number.isFinite(st)) continue;
    if (st > onset + ONSET_SLACK_MIN * MIN_MS && st < woke - WOKE_SLACK_MIN * MIN_MS) {
      const tz = s.tz || n.tz;
      out.push({
        kind: "contradiction", severity: "high", from: "code", stop_id: s.id,
        detail: `"${titleOf(s)}" begins at ${clock(st, tz)}, but the Watch had the user asleep until ${clock(woke, tz)}`,
        fix: "not repairable in prose: the stop's start is code. Publish, list it under Corrections & follow-ups, "
          + "and note that resolve-day's sleep guard (visits_held_at_wake) missed it",
      });
    }
  }
  return out;
}

/** Stops that overlap each other by more than a couple of minutes. Pure. */
function overlappingStops(day) {
  const stops = (day.stops || [])
    .filter((s) => Number.isFinite(s.start_ts_ms) && Number.isFinite(s.end_ts_ms))
    .sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  const out = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    const over = (a.end_ts_ms - b.start_ts_ms) / MIN_MS;
    if (over > OVERLAP_SLACK_MIN) {
      out.push({
        kind: "impossible", severity: "medium", from: "code", stop_id: b.id,
        detail: `"${titleOf(a)}" and "${titleOf(b)}" overlap by ${Math.round(over)} min`,
        fix: "not repairable in prose: the stop windows are code; list it under Corrections & follow-ups",
      });
    }
  }
  return out;
}

/**
 * One stay cut into several headers: consecutive stops with the same title
 * whose gap is a few minutes. The CLI's header-based duplicate check exempts
 * accommodation (going home twice is real), which is exactly how one day
 * shipped the rented flat as four back-to-back stops (05:39-05:49, 05:49-14:17,
 * 14:17-15:38) and called it 9 stops. A gap this short is not a return. Pure.
 */
const SPLIT_STAY_GAP_MIN = 15;
function splitStays(day) {
  const stops = (day.stops || [])
    .filter((s) => Number.isFinite(s.start_ts_ms) && Number.isFinite(s.end_ts_ms))
    .sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const tz = run[0].tz;
      out.push({
        kind: "duplicate", severity: "high", from: "code", fix_by: "fork", stop_id: run[1].id,
        headline: `Your time at ${titleOf(run[0])} was split into ${run.length} separate stops`,
        detail: `"${titleOf(run[0])}" is one stay shown as ${run.length} back-to-back stops `
          + `(${run.map((x) => `${clock(x.start_ts_ms, tz)}-${clock(x.end_ts_ms, tz)}`).join(", ")}), each gap ${SPLIT_STAY_GAP_MIN} min or less`,
        fix: "merge them into one stop in code (resolve-day / the day spine) and recount the stops; prose cannot fix this",
      });
    }
    run = [];
  };
  for (const s of stops) {
    const prev = run[run.length - 1];
    const same = prev && titleOf(prev) === titleOf(s) && (s.start_ts_ms - prev.end_ts_ms) / MIN_MS <= SPLIT_STAY_GAP_MIN;
    if (prev && !same) flush();
    run.push(s);
  }
  flush();
  return out;
}

/**
 * A photo in the day that the email could not show. `daily-summary-build
 * render` records each on its manifest stop (`photos_not_shown`, with the
 * reason); such a photo used to vanish with only a stderr line, leaving a
 * summary missing photos the user had. Pure.
 */
function photosNotShown(manifest, day) {
  const tzOf = new Map(((day && day.stops) || []).map((s) => [s.id, s.tz]));
  const out = [];
  for (const s of (manifest && manifest.stops) || []) {
    for (const p of s.photos_not_shown || []) {
      const t = Date.parse(p.taken_at);
      const at = Number.isFinite(t) ? ` at ${clock(t, tzOf.get(s.id) || (day && day.tz))}` : "";
      out.push({
        kind: "missing", severity: "medium", from: "code", fix_by: "fork", stop_id: s.id,
        headline: `A photo from ${titleOf(s)}${at} could not be shown in the summary`,
        detail: `photo ${p.uuid} (${titleOf(s)}${at}) is in the day but not in the email: ${p.reason || "no thumbnail"}`,
        fix: "give it a thumbnail (photos thumb-url <uuid> where the Photos library is readable, or re-probe the phone "
          + "for its window), then render + assemble; prose cannot fix this",
      });
    }
  }
  return out;
}

/** The same closed task listed more than once (one mailbox task twice at 11:39pm). Pure. */
function duplicateTasks(tasks) {
  const seen = new Map();
  for (const t of (tasks || [])) {
    const k = `${String(t.title || "").trim()}|${t.completed_at || ""}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k, n]) => ({
    kind: "duplicate", severity: "medium", from: "code", fix_by: "fork",
    headline: `A closed task was listed ${n} times`,
    detail: `the closed task "${k.split("|")[0]}" is listed ${n} times`,
    fix: "dedupe tasks_completed in daily-summary-build prep (same title + completion time = one task)",
  }));
}

/**
 * The user's own chat messages that day, verbatim, with the local clock and the stop
 * they were sent during — the harvest already attaches them (manifest.harvest).
 * The reviewer used to see only `day-statements`, a model's extraction of the
 * PLACES in them; one day that file was never written, so the review ran
 * blind to "had dinner here ... with Sam and Alex" and defended the wrong stop.
 *
 * A message that opens an exchange (the user's first after CONTEXT_GAP_MS of silence)
 * carries `before`: the last two things Jori said to the user since the user's previous
 * message, within CONTEXT_LOOKBACK_MS. 2026-10-23: the user's 7:35am "At the Asufa
 * shop to get cards ..." answered Jori's 4:32am question about Thursday's
 * summary; shown alone it read as a Friday stop, and the review demanded a
 * 7:35am shop visit while the user's phone sat at the flat. Messages sent between two
 * stops (`facts_by_leg`) are the user's words too; they were left out until then.
 * Pure: reads our own manifest.
 */
const CONTEXT_GAP_MS = 30 * 60 * 1000;
const CONTEXT_LOOKBACK_MS = 6 * 60 * 60 * 1000;
function hisMessages(manifest, tz) {
  const h = (manifest && manifest.harvest) || {};
  const win = h.window || {};
  const out = [];
  const jori = [];
  const add = (x, stopId) => {
    if (!x || x.kind !== "chat" || !x.text) return;
    const ms = Date.parse(x.at);
    if (!Number.isFinite(ms)) return;
    if (x.role === "assistant") {
      jori.push({ ms, id: x.id || null, text: String(x.text).replace(/\s+/g, " ").trim().slice(0, 220) });
      return;
    }
    if (x.role !== "user") return;
    if (win.start && ms < Date.parse(win.start)) return;
    if (win.end && ms >= Date.parse(win.end)) return;
    out.push({ ms, at: clock(ms, tz), stop: stopId || null, reply_to: x.reply_to || null,
      text: String(x.text).replace(/\s+/g, " ").trim().slice(0, 400) });
  };
  for (const [sid, facts] of Object.entries(h.facts_by_stop || {})) for (const x of facts || []) add(x, sid);
  for (const leg of (h.facts_by_leg || [])) for (const x of (leg && leg.facts) || []) add(x, null);
  for (const x of (h.orphan_facts || [])) add(x, null);
  const seen = new Set();
  const msgs = out.sort((a, b) => a.ms - b.ms).filter((m) => { const k = `${m.ms}|${m.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const said = jori.sort((a, b) => a.ms - b.ms)
    .filter((g, i, all) => i === 0 || g.ms !== all[i - 1].ms || g.text !== all[i - 1].text);
  let prev = -Infinity;
  for (const m of msgs) {
    if (m.ms - prev >= CONTEXT_GAP_MS) {
      const before = said.filter((g) => g.ms < m.ms && g.ms > prev && m.ms - g.ms <= CONTEXT_LOOKBACK_MS).slice(-2);
      if (before.length) m.before = before.map((g) => ({ at: clock(g.ms, tz), text: g.text }));
    }
    prev = m.ms;
  }
  // A message the user sent with the app's Reply action names the Jori message it
  // answers (`reply_to`). The context above keeps only the last two Jori lines
  // before an exchange, and the question the user answered can be older than both (other
  // pings in between), so the user's answer read as being about the stop it was sent
  // during. Show the message the user replied to, wherever in the day it was sent.
  const byId = new Map(said.filter((g) => g.id).map((g) => [g.id, g]));
  for (const m of msgs) {
    if (!m.reply_to) continue;
    const g = byId.get(m.reply_to);
    if (!g) { m.replying_to = { at: null, text: null }; continue; }
    const at = clock(g.ms, tz);
    if (m.before) {
      m.before = m.before.filter((b) => !(b.at === at && b.text === g.text));
      if (!m.before.length) delete m.before;
    }
    m.replying_to = { at, text: g.text };
  }
  return msgs;
}

/**
 * The user's photos as evidence lines. The reviewer "doesn't
 * appear to have access to photos and their data. the cafe antilia in the
 * morning would be confirmed because i provided a photo - same for the milk
 * bakery." Friday's 10:18 photo sat on the real Café Antilia spot, with the
 * phone's own venue reading "Antilia" (33 m), a plate, a glass and a table in
 * frame, and the reviewer never saw it. Each line: local time, the stop whose
 * window holds it and how far the camera was from that stop, the phone's venue
 * reading with its nearest places, legible text, scene labels, people, and
 * whether the user's phone took it. Pure: formats rows the CLI fetched.
 */
// A face tag under the name the day knows the person by. Photos can tag a
// relative by a full legal name ("Jane Example") while the day, the user's words
// and the companions use a family name for her ("Nana") (lib/companions.js, the
// table resolve-day maps the tags with). Shown the bare tag beside "with Nana +
// Sam + ...", the review flagged her as missing from the dinner, and its repair
// wrote "with Jane Example there too" into the prose as if she were someone
// else. A tag the table renames reads `Nana (tagged "Jane Example")`; one it
// keeps, or does not know, reads as tagged.
let COMPANION_ALIASES = null;
function personAsKnown(tag) {
  if (COMPANION_ALIASES === null) {
    try { COMPANION_ALIASES = companionNames().aliases || {}; } catch { COMPANION_ALIASES = {}; }
  }
  const known = typeof tag === "string" ? COMPANION_ALIASES[tag] : null;
  return known && !String(tag).split(" ").includes(known) ? `${known} (tagged "${tag}")` : tag;
}

function photoLines(photos, day, tz) {
  const stops = ((day && day.stops) || []).filter((s) => Number.isFinite(s.start_ts_ms) && Number.isFinite(s.end_ts_ms));
  const R = 6371000, rad = (d) => d * Math.PI / 180;
  const dist = (a, b, c, d) => {
    const x = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(x)));
  };
  const out = [];
  for (const p of (photos || [])) {
    const ms = Date.parse(p.taken_at);
    if (!Number.isFinite(ms)) continue;
    const st = stops.find((s) => ms >= s.start_ts_ms && ms <= s.end_ts_ms);
    const slat = st && (st.lat ?? (st.place && st.place.lat)), slon = st && (st.lon ?? (st.place && st.place.lon));
    const far = st && Number.isFinite(p.latitude) && Number.isFinite(slat) ? dist(p.latitude, p.longitude, slat, slon) : null;
    const v = p.device_venue || {};
    const pois = (v.pois || []).slice(0, 3).map((x) => `${x.name}${x.category ? ` (${x.category})` : ""} ${x.distance_m != null ? x.distance_m + " m" : ""}`.trim());
    const parts = [
      st ? `during ${st.id} "${titleOf(st)}"${far != null ? `, ${far} m from that stop` : ""}` : "during no stop (between stops)",
      v.name ? `phone's venue reading: "${v.name}"${v.confidence != null ? ` (${v.confidence})` : ""}` : null,
      pois.length ? `nearest places: ${pois.join("; ")}` : null,
      p.detected_text ? `text in frame: "${String(p.detected_text).replace(/\s+/g, " ").slice(0, 80)}"` : null,
      Array.isArray(p.labels) && p.labels.length ? `in frame: ${p.labels.slice(0, 8).join(", ")}` : null,
      Array.isArray(p.persons) && p.persons.length ? `people: ${p.persons.map(personAsKnown).join(", ")}` : null,
      p.self_captured === false ? "not taken on the user's phone (shared or saved)" : null,
    ].filter(Boolean);
    out.push(`- ${clock(ms, tz)}: ${parts.join("; ")}`);
  }
  return out;
}

// What each place source means, in the reviewer's terms. The confirmed tier
// covers sources of very different strength: "user_confirmed" is the user's own answer
// about THIS visit; "confirmed_stop" is an automatic match to a place the user named
// on some EARLIER day, within 30 m — on 2026-10-16 it named a 3-hour evening
// "Café Antilia" (a café by the flat) across the dinner the user had just named.
const SOURCE_MEANING = {
  user_confirmed: "the user's own answer about this visit",
  user_confirmed_via_transcript: "the user's own words about this visit",
  confirmed_stop: "auto-matched to a place the user confirmed on an earlier day (within 30 m) — NOT the user's words about this visit",
  accommodation: "the lodging on the user's travel bookings",
  named_location: "a place the user saved as a named location",
  known_recurring: "a place the user goes to regularly, matched by proximity",
  saved_place: "matched to a place the user saved in Google Maps",
  photo_text: "read from a sign in the user's own photo",
  wifi_ssid: "matched by the Wi-Fi network",
};

/** 3 per high, 1 per medium, 0 per low. A repair is kept only if this goes DOWN. */
function scoreFindings(findings) {
  return (findings || []).reduce((t, f) => t + (SEVERITY_WEIGHT[f.severity] || 0), 0);
}

// ---- places the user named: code clears, the model judges what code cannot ----------
//
// Code checks whether each place the user named is a stop in the report by
// comparing words (or, for a place with no name, a time). A match clears it. A
// non-match used to be a high "missing" finding on its own, and it was wrong more
// often than right: in one week, 11 of the 19 fixes for Jori misdescribing
// itself were this kind of check calling something missing that the report
// carried ("The Old Man & The Sea" for the user's "the old man and the sea", the
// user's "the hotel" answer saved under the hotel's full name, a home named by
// the people who live there saved as their street address). Each was patched with one more
// word rule. Whether two wordings are one place is language (Rule #0b), so a
// non-match is now a CANDIDATE: it rides the review call that already reads the user's
// messages, photos and the report, and becomes a finding only from the model's
// answer. Nothing new is called; a candidate is a few lines of prompt. The model
// can clear a place only by quoting the heading of a stop that names a venue;
// which headings those are is our own markup and stop data, so code checks it.

/** The candidates as the review prompt lists them. Pure. */
function candidateLines(candidates) {
  const q = (x, n) => String(x || "").replace(/\s+/g, " ").trim().slice(0, n);   // lang-regex-ok: whitespace only, for display in our own prompt
  return (candidates || []).map((c) => {
    const what = c.type === "place_time" ? "a stop the user described (no place name)" : "a place the user named";
    return `- ${c.id} · ${what}: "${q(c.label, 120)}"`
      + `${c.evidence && c.evidence !== c.label ? ` · the user's words: "${q(c.evidence, 160)}"` : ""}`
      + `${c.when ? ` · about ${c.when}` : ""}`
      + `${c.type === "place_time" ? " · code found no stop covering that time" : ""}`;
  });
}

// A model's quote, and our own report text, flattened only so an exact-substring
// test survives typography: case, curly quotes, dashes, spaces. Pure.
function flatForQuote(s) {
  return String(s || "").toLowerCase()
    .split("’").join("'").split("‘").join("'").split("“").join('"').split("”").join('"')
    .split("–").join("-").split("—").join("-").split(" ").join(" ").split("&amp;").join("&")
    .replace(/\s+/g, " ").trim();   // lang-regex-ok: whitespace of a model's verbatim quote and our own report, for an exact-substring test
}

// The pieces of a quote (an ellipsis may join them), or null when together they
// are too short to point at anything (a word fragment, a lone separator).
function quotePieces(quote) {
  if (typeof quote !== "string") return null;
  const trimQuotes = (p) => {
    let a = 0, b = p.length;
    while (a < b && "\"'".includes(p[a])) a++;
    while (b > a && "\"'".includes(p[b - 1])) b--;
    return p.slice(a, b).trim();
  };
  const pieces = flatForQuote(quote).split("…").join("...").split("...").map(trimQuotes).filter((p) => p.length >= 3);
  return pieces.length && pieces.join("").length >= 6 ? pieces : null;
}

/** Is the quote really somewhere in the report (any section)? Pure. */
function quotedInReport(quote, reportText) {
  const hay = flatForQuote(reportText);
  const pieces = quotePieces(quote);
  return Boolean(hay && pieces && pieces.every((p) => hay.includes(p)));
}

/**
 * Does the quote sit inside one stop heading AND cover that stop's title? Our
 * header is "<time> · <title> · with <companions>" (daily-summary-render
 * stopHeaderHtml), so the title is the segment after the first "·". A quote of
 * the clock alone ("7:17pm") or of the companions alone points at no place, and a
 * sentence of prose is in no heading. The quote must cover at least 4 characters
 * of the title, or all of a shorter one. Structure of our own markup. Pure.
 */
const TITLE_COVER_MIN = 4;
function quoteInStopTitle(quote, headings) {
  const pieces = quotePieces(quote);
  if (!pieces) return false;
  for (const h of headings || []) {
    const parts = String(h || "").split("·").map(flatForQuote);
    const line = parts.join(" · ");
    const from = parts.length > 1 ? parts[0].length + 3 : 0;
    const to = from + (parts.length > 1 ? parts[1].length : line.length);
    if (to <= from) continue;
    let covered = 0, all = true;
    for (const p of pieces) {
      let at = line.indexOf(p), best = -1;
      while (at >= 0) {
        best = Math.max(best, Math.max(0, Math.min(to, at + p.length) - Math.max(from, at)));
        at = line.indexOf(p, at + 1);
      }
      if (best < 0) { all = false; break; }
      covered += best;
    }
    if (all && covered >= Math.min(TITLE_COVER_MIN, to - from)) return true;
  }
  return false;
}

// A heading names a place only when its stop does (2026-10-27). The renderer
// prints an unnamed stop as "unlabeled", a stretch the user said was not a stop as "not a
// stop" or "<street> · walking", and a walk out and back as a walk block
// (daily-summary-render venueHeaderHtml); none of those is a place the user named, and a
// model quoting "7:17pm · unlabeled · with …" must not clear one. The test reads
// the stop data the report was rendered from, never the words in the heading.
function isNamedVenueStop(s) {
  if (!s || s.excursion || s.is_movement || s.user_non_stop) return false;
  const p = s.provenance;
  if (!p) return Boolean(s.place && s.place.name);   // else the renderer prints "unknown near <lat>, <lon>"
  if (p.excursion || p.non_stop || p.title_kind === "movement") return false;
  return p.certainty !== "none" && Boolean(p.title);
}

// Our own HTML escapes, decoded, with the tags stripped: a heading as the reviewer reads it.
const headingTextOf = (html) => String(html || "").replace(/<[^>]*>/g, "")   // lang-regex-ok: strips our own markup
  .split("&lt;").join("<").split("&gt;").join(">").split("&quot;").join('"').split("&#39;").join("'")
  .split("&nbsp;").join(" ").split("&amp;").join("&").trim();

/**
 * The report's stop headings, sorted by the stop that produced them: `named` (the
 * stop names a venue) and `unnamed` (unlabeled, not a stop, a walking stretch, a
 * walk). Each shown stop's heading is rendered again with the renderer's own
 * stopHeaderHtml from the day the report was built from, and a report heading is
 * one of these only if it is exactly that text (checked on the live reports of
 * Oct 22-26: all 43 headings matched their stop). A heading no stop renders (a
 * report out of step with its day file) is in neither list and clears nothing.
 * Pure but for the renderer require.
 */
function classifyStopHeadings(day, headingLines) {
  let H;
  try { H = require("./daily-summary-render.js")._internal; } catch { return { named: [], unnamed: [] }; }
  const kind = new Map();
  for (const s of (day && day.stops) || []) {
    if (!H.isMainStop(s)) continue;
    let text;
    try { text = flatForQuote(headingTextOf(H.stopHeaderHtml(s, day))); } catch { continue; }   // a stop that cannot render clears nothing
    if (kind.get(text) !== "named") kind.set(text, isNamedVenueStop(s) ? "named" : "unnamed");
  }
  const lines = headingLines || [];
  return { named: lines.filter((h) => kind.get(flatForQuote(h)) === "named"),
    unnamed: lines.filter((h) => kind.get(flatForQuote(h)) === "unnamed") };
}

const inSomeHeading = (pieces, headings) => (headings || []).some((h) => {
  const line = String(h || "").split("·").map(flatForQuote).join(" · ");
  return pieces.every((p) => line.includes(p));
});

/**
 * What a "present" answer's quote shows, from our own report structure:
 *   named_title  inside a heading whose stop names a venue, covering its title → clears
 *   no_title     inside a named heading but not its title (a clock time, the
 *                companions)                                                     → absent
 *   placeholder  inside a heading whose stop names no place (unlabeled, not a stop,
 *                a walking stretch, a walk block)                                → absent
 *   unmatched    inside a heading no stop in the day file renders               → absent
 *   elsewhere    in the report but in no stop heading (prose, Day's other
 *                anchors, a travel line, the task list)                          → absent
 *   too_short    too short to point at one heading                               → unsettled
 *   not_found    not in the report at all                                         → unsettled
 * `headings` are all the report's stop headings; `namedHeadings` and
 * `unnamedHeadings` those classifyStopHeadings sorted.
 */
function quoteShows(quote, { headings = [], namedHeadings = [], unnamedHeadings = [], reportText = "" } = {}) {
  const pieces = quotePieces(quote);
  if (!pieces) return "too_short";
  if (quoteInStopTitle(quote, namedHeadings)) return "named_title";
  if (inSomeHeading(pieces, namedHeadings)) return "no_title";
  if (inSomeHeading(pieces, unnamedHeadings)) return "placeholder";
  if (inSomeHeading(pieces, headings)) return "unmatched";
  return quotedInReport(quote, reportText) ? "elsewhere" : "not_found";
}

const QUOTE_ABSENT_WHY = {
  placeholder: "its quote is a heading that names no place (an unlabeled stop, a walk, or a stretch that was not a stop)",
  no_title: "its quote is part of a stop heading but not the stop's name",
  unmatched: "its quote is a heading that no stop in the day's data produces, so it cannot be checked against one",
  elsewhere: "its evidence is in no stop heading",
};
const QUOTE_UNSETTLED_WHY = {
  too_short: "the review said it is there, but its quote is too short to point at one stop heading",
  not_found: "the review said it is there but quoted text the report does not have",
};

/**
 * Turn the model's answers into findings. Each candidate carries `missing`, the
 * high finding code used to emit on its own:
 *   - "absent" → that high finding, as before.
 *   - "present" whose quote is a named stop's heading, covering its title → cleared.
 *   - "present" whose quote is in the report but not a named stop's title (a
 *     placeholder heading, a heading the day's stops do not produce, a clock time,
 *     a sentence of prose, Day's other anchors, a task line) → the same high finding: by the rubric that place is not a stop,
 *     and a repair that names a missing place must not turn it into a clean day.
 *   - anything else (the model did not run, gave no answer, was unsure, or quoted
 *     too little or text the report does not have) → a MEDIUM "unconfirmed"
 *     finding, never silence: not high, because a word mismatch is no evidence of
 *     absence (11 of 19 such findings in a week were false); not low, because low
 *     lets the day count as confirmed with nobody having looked. Medium keeps the
 *     day unconfirmed, so the fix loop looks at it, and says it could not be
 *     confirmed rather than that it is missing.
 * `headings` are the report's stop headings as text; `namedHeadings` and
 * `unnamedHeadings` are classifyStopHeadings' sort of them. `record` lists every
 * candidate and what became of it, for the review result. Pure.
 */
function settleCandidates(candidates, answers, { judged = false, reportText = "", headings = [], namedHeadings = [], unnamedHeadings = [], why = null } = {}) {
  const byId = new Map();
  for (const a of Array.isArray(answers) ? answers : []) {
    if (a && typeof a.id === "string" && !byId.has(a.id)) byId.set(a.id, a);
  }
  const findings = [], record = [];
  for (const c of candidates || []) {
    const a = judged ? byId.get(c.id) : null;
    let where = a && typeof a.where === "string" && a.where.trim() ? a.where.trim().slice(0, 400) : null;
    let outcome = "unconfirmed", reason, shows = null;
    if (!judged) reason = why || "the review did not run";
    else if (!a) reason = "the review gave no answer for it";
    else if (a.verdict === "absent") outcome = "missing";
    else if (a.verdict === "present") {
      shows = quoteShows(a.quote, { headings, namedHeadings, unnamedHeadings, reportText });
      if (shows === "named_title") outcome = "cleared";
      else if (QUOTE_ABSENT_WHY[shows]) {
        outcome = "missing";
        where = `the review called it present, but ${QUOTE_ABSENT_WHY[shows]}: "${String(a.quote).slice(0, 160)}"`;
      } else reason = QUOTE_UNSETTLED_WHY[shows];
    } else reason = "the review could not tell";
    record.push({ id: c.id, type: c.type, label: c.label, verdict: a ? a.verdict || null : null,
      quote: a && typeof a.quote === "string" ? a.quote.slice(0, 200) : null, ...(shows ? { quote_shows: shows } : {}), where, outcome });
    if (outcome === "missing") {
      findings.push({ ...c.missing, from: "code", settled_by: "model", ...(where ? { checked: where } : {}) });
    } else if (outcome === "unconfirmed") {
      const named = c.type === "place_time" ? `"${c.label}"` : c.label;
      const said = c.evidence && c.evidence !== c.label ? ` ("${String(c.evidence).slice(0, 80)}")` : "";
      findings.push({
        kind: "missing", severity: "medium", fix_by: "fork", from: "code", unconfirmed: true,
        headline: `I couldn't confirm that ${named}, which you mentioned, is in the summary`,
        detail: `a word check could not find "${c.label}", which the user ${c.type === "place_time" ? "described" : "named"}${said}, `
          + `among the report's stops, and ${reason}${where ? `: ${where}` : ""}`,
        fix: "check whether a stop carries it under other words; if none does, add it as a stop (the user's own statement outranks every resolver)",
      });
    }
  }
  return { findings, record };
}

// ---- the slots a repair may touch -------------------------------------------

/**
 * Slot ids the skeleton actually has. A repair can only fill a slot that exists;
 * it cannot create a stop, a header or a time.
 */
function slotIds(skeleton) {
  const grab = (re) => new Set([...String(skeleton).matchAll(re)].map((m) => m[1]));
  return {
    prose: grab(/\{\{PROSE:([^}]+)\}\}/g),            // lang-regex-ok: our own template markers
    aside: grab(/\{\{ASIDE:([^}]+)\}\}/g),            // lang-regex-ok: our own template markers
    question: grab(/\{\{QUESTION:([^:}]+):[^}]+\}\}/g), // lang-regex-ok: our own template markers
  };
}

const SLOT_TO_KEY = { prose: "prose", aside: "asides", question: "questions" };
const MAX_LEN = { prose: 700, aside: 400, question: 300, other_anchors: 2500, night: 700 };
const ALLOWED_ANCHOR_TAGS = new Set(["ul", "li", "em", "strong", "a", "br", "b", "i", "p"]);

// other_anchors is inserted into the email as raw HTML, so an edit to it may use
// only plain list markup; anything else (a script, an iframe, a stray div) is
// refused rather than sanitised.
function anchorsMarkupOk(html) {
  const tags = [...String(html).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()); // lang-regex-ok: checks our own markup
  return tags.every((t) => ALLOWED_ANCHOR_TAGS.has(t));
}

/**
 * Apply a model's edits to a COPY of the prose JSON. An edit is
 * `{slot, id, text}`; empty `text` clears the slot. Anything that names a slot
 * the skeleton lacks, a type that is not allowed, a non-string, or text over
 * the cap is refused and reported, never partially applied. Pure.
 *
 * @returns {{prose:object, applied:Array, rejected:Array}}
 */
function applyEdits(prose, edits, slots) {
  const next = JSON.parse(JSON.stringify(prose || {}));
  const applied = [], rejected = [];
  for (const e of Array.isArray(edits) ? edits : []) {
    const slot = e && e.slot, id = e && e.id, text = e && e.text;
    const refuse = (reason) => rejected.push({ slot, id: id || null, reason });
    if (typeof text !== "string") { refuse("text is not a string"); continue; }
    if (!Object.prototype.hasOwnProperty.call(MAX_LEN, slot)) { refuse("unknown slot type"); continue; }
    if (text.length > MAX_LEN[slot]) { refuse(`over ${MAX_LEN[slot]} characters`); continue; }
    if (slot === "other_anchors" || slot === "night") {
      if (slot === "other_anchors" && text && !anchorsMarkupOk(text)) { refuse("markup other than plain list tags"); continue; }
      if (slot === "night" && /[<>]/.test(text)) { refuse("markup in a plain-text slot"); continue; } // lang-regex-ok: guards our own plain-text slot
      next[slot] = text;
      applied.push({ slot, id: null });
      continue;
    }
    if (typeof id !== "string" || !slots[slot] || !slots[slot].has(id)) { refuse("no such slot in the skeleton"); continue; }
    if (/[<>]/.test(text)) { refuse("markup in a plain-text slot"); continue; } // lang-regex-ok: guards our own plain-text slot
    const key = SLOT_TO_KEY[slot];
    next[key] = next[key] && typeof next[key] === "object" ? next[key] : {};
    if (text) next[key][id] = text; else delete next[key][id];
    applied.push({ slot, id });
  }
  return { prose: next, applied, rejected };
}

// ---- what the model is shown ------------------------------------------------

/**
 * The facts the report was built from, as plain text, so the reviewer can check
 * the report against them instead of only against itself. Everything here is
 * already computed by code; the reviewer is told it is authoritative.
 *
 * Health: the night is Watch data. It goes to this Max-session `claude -p` only,
 * the same boundary the narrator runs in (CLAUDE.md § Health Data).
 */
// The calls of the night before. A day cut at midnight can open with a note
// about a call that ran the evening before: at 12:38am the user wrote "We spoke
// about the team, fundraise and product", about the previous day's 11pm call,
// and the reviewer, shown only that day's 11:34pm call (Zoom: the other side in
// the room 11:34pm to 12:03am), called that call misdated and wanted it moved to the night before. Code
// hands it the previous day's calls as that day's summary published them, those that
// ended in the last PRIOR_CALL_WINDOW_MS before this day began: context for the user's
// messages, never part of this report.
const PRIOR_CALL_WINDOW_MS = 6 * 3600_000;
function priorNightCalls(calls, dayStartIso) {
  const day0 = Date.parse(dayStartIso);
  if (!Array.isArray(calls) || !Number.isFinite(day0)) return [];
  return calls.filter((c) => {
    const s = Date.parse(c && c.start), e = Date.parse((c && c.end) || (c && c.start));
    return Number.isFinite(s) && Number.isFinite(e) && s < day0 && e >= day0 - PRIOR_CALL_WINDOW_MS;
  });
}

function factPack({ date, manifest, day, statements, corrections, photos = null, priorCalls = null }) {
  const L = [];
  const m = manifest || {}, d = day || {};
  const tz = (d.path && d.path.tz) || d.tz || defaultTz();
  L.push(`DAY: ${date}. The day runs midnight to midnight in ${tz}; `
    + `every time in the report is the local clock where the user was (zone labels appear when a day crosses zones).`);
  if (m.night) {
    const n = m.night;
    L.push(`NIGHT (Apple Watch): fell asleep ${n.fell_asleep || "?"}, woke ${n.woke || (n.woke_range ? `between ${n.woke_range.from} and ${n.woke_range.to}` : "?")}`
      + `${n.asleep ? `, ${n.asleep} asleep` : ""}.`
      + `${(n.wakeups || []).length ? ` Wake-ups: ${n.wakeups.map((w) => `${w.at} (${w.min} min)`).join(", ")}.` : ""}`);
  } else if (m.wake) {
    L.push(`WAKE: ${m.wake.at || JSON.stringify(m.wake)}.`);
  }
  L.push("STOPS AS BUILT BY CODE. A prose repair cannot change a stop's times, title or existence, but code can be wrong: "
    + "when a stop contradicts the user's messages or the movement evidence, that is a finding (slot \"none\"). Each line: id, window, title, "
    + "[tier, source = what the name rests on], companions on record, calendar event, movement evidence:");
  for (const s of (m.stops || [])) {
    const src = s.place_source;
    const meaning = SOURCE_MEANING[src] ? ` = ${SOURCE_MEANING[src]}` : "";
    const rv = s.rest_verified;
    const movement = [
      rv && typeof rv === "object" && rv.witnessed_min != null ? `fixes saw ${rv.witnessed_min} of ${s.duration_min || "?"} min` : null,
      s.excursion ? "an excursion (walk) block" : null,
      s.merged_walk ? "a merged walk" : null,
      s.movement_note ? `movement: ${String(s.movement_note).slice(0, 120)}` : null,
      s.possible_unlogged_excursion ? "possible unlogged excursion" : null,
    ].filter(Boolean).join("; ");
    L.push(`- ${s.id}: ${s.start}-${s.end}${s.tz_abbr ? " " + s.tz_abbr : ""} "${s.title}" `
      + `[${s.provenance ? s.provenance.tier : s.title_certainty}${src ? `, source ${src}${meaning}` : ""}${s.needs_review ? ", needs review" : ""}]`
      + ` companions on record: ${(s.companions || []).length ? s.companions.join(", ") : "none"}`
      + `${s.calendar_event ? `; calendar: "${String(s.calendar_event.summary || s.calendar_event).slice(0, 100)}"` : ""}`
      + `${movement ? `; ${movement}` : ""}`);
  }
  // The walked figure the header prints, from the same walking legs the renderer
  // sums (daily-summary-render.js), plus the day's travel. This used to print
  // `m.mobility` first, the day's transit charges, and an empty list of them hid
  // the path totals (2026-10-16: "0.7 miles walked" judged unsupported against
  // "MOVEMENT TOTALS: []").
  const st = (d.path && d.path.stats) || null;
  const legs = ((d.path && d.path.spine) || []).filter((n) => n.type === "leg");
  let walkedM = legs.filter((l) => l.mode === "walking")
    .reduce((t, l) => t + (l.walked_m != null ? l.walked_m : (l.routed_m || l.straight_m || 0)), 0);
  // Since 2026-10-25 the header is the sum of the walking lines and walk blocks the
  // report prints (printedWalkMeters), so that is the figure stated here.
  let walkedBasis = "summed over the walking legs";
  if (legs.length && process.env.JORI_WALKED_FROM_LINES !== "0") {
    try {
      const R = require("./daily-summary-render.js")._internal;
      const shown = (d.stops || []).filter(R.isMainStop);
      if (shown.length >= 2) {   // the renderer's own rule: one stop keeps the legs' sum
        walkedM = R.printedWalkMeters(d, shown);
        walkedBasis = "the walking lines and walk blocks in the report, summed";
      }
    } catch { /* keep the legs' sum */ }
  }
  // All travel is every metre of the day's legs, seen or inferred. matched_km is only
  // the map-matched part: on 2026-10-15 two of four segments were not matched, and
  // "all travel 1.4 km" sat beside a 24.3 km evening drive, which the review then
  // called a contradiction in the report. A path without the two totals keeps the
  // matched figure.
  const allKm = st && st.observed_km != null && st.inferred_km != null
    ? Math.round((st.observed_km + st.inferred_km) * 10) / 10 : (st ? st.matched_km : null);
  if (legs.length || (st && st.walked_km != null)) {
    L.push(`MOVEMENT TOTALS (code): ${legs.length ? `walked ${(walkedM / 1609.344).toFixed(1)} miles (the header's figure: ${walkedBasis})` : `walked ${st.walked_km} km`}`
      + `${allKm != null ? `; all travel ${allKm} km, any mode${st.matched_km != null && st.matched_km < allKm ? ` (${st.matched_km} km of it map-matched)` : ""}` : ""}`
      + `${st && st.geometry_source ? `; geometry ${st.geometry_source}` : ""}.`);
  }
  if ((m.mobility || []).length) L.push(`TRANSIT, TOLL AND RIDE CHARGES (code): ${JSON.stringify(m.mobility).slice(0, 400)}`);
  if ((m.unmatched_calendar_events || []).length) {
    L.push("CALENDAR EVENTS NOT MATCHED TO A STOP: " + m.unmatched_calendar_events.map((e) => `"${e.summary}" ${e.start || ""}`).join("; "));
  }
  // Calls: code prints each as its own timeline line, not a stop. "calendar
  // times" = the scheduled slot; status "scheduled" = no reading of whether it
  // took place, so prose must not say it happened. source "zoom" = the other
  // side's measured time in the user's room ("ran 38 min").
  if ((m.calls || []).length) {
    // talk = the paragraph code prints under the line (the daily summary includes
    // a paragraph on what was talked about), written from Zoom's
    // transcript/summary or the user's notes for the call. It is a
    // record, not prose to check against the day's GPS.
    // POINTS = the one-liners the report prints under the call instead of the
    // paragraph (a call once printed six points written
    // from Zoom's summary, and the reviewer, shown only the paragraph, called four
    // of them invented). A call inside a stop is printed in that stop's list
    // without "at <place>", which the stop's header already says.
    L.push("CALLS (code; each is its own line in the report, never a stop or a visit; a call inside a stop is listed under that stop without its 'at <place>', which the stop's header names; the paragraph or points under a call are code-attached from Zoom's record of the call or the user's notes for the call and are facts as printed: when a call has POINTS, the report prints those as sub-bullets instead of the paragraph; the stop prose must not retell or add to them): "
      + m.calls.map((c) => `${c.line} [status ${c.status}${c.source === "zoom" ? ", measured by Zoom" : ""}]${c.talk ? ` TALK (${c.talk_source || "?"}): ${c.talk}` : ""}`
        + `${(c.talk_points || []).filter(Boolean).length ? ` POINTS (same record): ${c.talk_points.filter(Boolean).join(" | ")}` : ""}`).join("; "));
  }
  if ((priorCalls || []).length) {
    const clock = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
      .toLowerCase().replace(/\s/g, "");   // lang-regex-ok: our own formatted clock
    const day1 = (iso) => new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
    L.push("CALLS THE NIGHT BEFORE (from the previous day's summary; not this day's calls and not printed in this report; "
      + "a message the user sent after midnight about a call can be about one of these): "
      + priorCalls.map((c) => `${day1(c.start)} ${clock(c.start)}-${clock(c.end || c.start)} ${c.who ? `Call with ${c.who}` : "Call"}`
        + ` [status ${c.status || "?"}, ${c.source === "zoom" ? "Zoom times" : "calendar times"}]`).join("; "));
  }
  if (d.calls_error) L.push(`CALLS: the calendar could not be read for calls (${String(d.calls_error).slice(0, 120)}); any such call stays in the unmatched list.`);
  if ((m.calls_left_out || []).length) {
    L.push("CALENDAR CALLS LEFT OUT (code; did not happen, must not be narrated as calls): "
      + m.calls_left_out.map((c) => `${c.local_time} (${c.why})`).join("; "));
  }
  // Each fact as the report prints it, with what the report prints beside it: a
  // task's list and its due date when that differs from the day (render's
  // taskLineParts), a charge the bank still lists as pending. 2026-10-20: the
  // reviewer was shown neither, and called "· due 2026-10-22" and "still pending"
  // invented although both were in the records.
  const taskMeta = (t) => [t.list && t.list !== "My Tasks" ? t.list : null,
    t.due && t.due !== date ? `due ${t.due}` : null].filter(Boolean).join(" · ");
  if ((m.tasks_completed || []).length) {
    L.push("TASKS THE USER CLOSED (listed verbatim by the report): " + m.tasks_completed
      .map((t) => `${t.completed_at} ${t.title}${taskMeta(t) ? ` · ${taskMeta(t)}` : ""}`).join("; "));
  }
  // The commits section's plain-language lines must say what these did, no more.
  if ((m.commits || []).length) {
    L.push("COMMITS THAT DAY (the report restates each in plain language, under the stop the user was at, or ahead of the first stop when it landed before it; an autonomous one is kept to a few words): " + m.commits
      .map((c) => `${c.local} ${c.sha}${c.autonomous ? " [Jori's own]" : ""} ${c.subject}`).join("; "));
  }
  // Jori's own daily fixes are left out on purpose; the
  // reviewer must not call their absence a missing item.
  if ((m.commits_left_out || []).length) {
    L.push(`COMMITS LEFT OUT ON PURPOSE (${m.commits_left_out.length}): Jori's own routine daily fixes (tags ${(m.commits_routine_tags || []).join(", ")}). The user asked that anything Jori does every day not be mentioned; their absence is correct, never a missing item.`);
  }
  if ((m.standout_transactions || []).length) {
    L.push("STANDOUT PURCHASES (amounts are code-computed): " + m.standout_transactions
      .map((t) => `${t.merchant} ${t.amount_usd}${t.pending ? " (pending at the bank)" : ""}${t.stop_id ? "" : " (no stop)"}`).join("; "));
  }
  const msgs = hisMessages(m, tz);
  if (msgs.length) {
    L.push("THE USER'S OWN MESSAGES THAT DAY (verbatim, local time, and the stop whose window they were sent in; the strongest evidence there is). "
      + "Under a message that opens an exchange is what Jori had last said to the user: the user often answers a question about another day, and then the user's message is about that day, not this one. "
      + "A message the user sent with the app's Reply action also shows the exact Jori message it answers, however much earlier; it is an answer to that message:");
    for (const x of msgs.slice(0, 80)) {
      L.push(`- ${x.at}${x.stop ? ` [during ${x.stop}]` : ""}: "${x.text}"`);
      if (x.replying_to) {
        L.push(x.replying_to.text
          ? `    (the user sent this with Reply on Jori's message of ${x.replying_to.at}: "${x.replying_to.text}")`
          : "    (the user sent this with Reply on a Jori message from outside this day)");
      }
      for (const g of x.before || []) L.push(`    (Jori had said at ${g.at}: "${g.text}")`);
    }
  }
  const pl = photoLines(photos, d, tz);
  if (pl.length) {
    L.push("THE USER'S PHOTOS THAT DAY (where the user's camera was and what was in frame; a photo taken at a place is strong evidence the user was there, and a photo outside every stop can be a stop the day is missing):");
    L.push(...pl.slice(0, 60));
  } else if (photos === null) {
    L.push("THE USER'S PHOTOS THAT DAY: not available to this review (the photo fetch failed); do not read the absence as no photos.");
  }
  const places = (statements && statements.places) || [];
  if (places.length) {
    L.push("PLACES EXTRACTED FROM THE USER'S WORDS: " + places.map((p) => `${p.name} ("${String(p.evidence || "").slice(0, 90)}")`).join("; "));
  } else if (msgs.length) {
    L.push("PLACES EXTRACTED FROM THE USER'S WORDS: none (the extraction did not run or found nothing; read the user's messages above directly).");
  }
  if ((corrections || []).length) {
    // The fix loop records the user's chat answers here too. Shown as bare text,
    // "Just Sam" (the user's threaded reply to "Were you dropping Sam and Alex off
    // at a friend's?") said nothing, and the repair cut the drop-off
    // it established. Each entry now carries the stretch it is about and the
    // recording turn's reading, kept apart from the user's words.
    const at = (iso) => { const ms = Date.parse(iso || ""); return Number.isFinite(ms) ? clock(ms, tz) : null; };
    L.push("CORRECTIONS THE USER GAVE about this day (by email, or in chat answering Jori's questions). The user's words are in quotes; "
      + "\"Jori's reading\" is how the turn that recorded them understood them, including the question a short answer replied to. "
      + "Weigh the reading as evidence; where it and the user's words disagree, the user's words win:\n"
      + corrections.map((c) => {
        const from = at(c.applies_from), to = at(c.applies_to);
        const win = from && to ? `, about ${from}-${to}` : "";
        const reading = c.reading ? ` Jori's reading: ${String(c.reading).slice(0, 300)}` : "";
        return `- ${c.channel || "email"}${win}: "${String(c.text).slice(0, 240)}"${reading}`;
      }).join("\n"));
  }
  return L.join("\n");
}

const ISSUE_KINDS = ["duplicate", "invented", "missing", "contradiction", "impossible", "quality"];
const SLOT_TYPES = ["prose", "aside", "question", "other_anchors", "night", "none"];
const CANDIDATE_VERDICTS = ["present", "absent", "unsure"];

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["publish", "revise"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ISSUE_KINDS },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          detail: { type: "string" },
          headline: { type: "string" },
          fix: { type: "string" },
          slot: {
            type: "object",
            properties: { type: { type: "string", enum: SLOT_TYPES }, id: { type: "string" } },
            required: ["type"],
          },
        },
        required: ["kind", "severity", "detail", "fix"],
      },
    },
    // One answer per CANDIDATE (see settleCandidates): code could not match it to
    // the report word for word, so the model says whether the report carries it.
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: CANDIDATE_VERDICTS },
          quote: { type: "string" },
          where: { type: "string" },
        },
        required: ["id", "verdict", "where"],
      },
    },
  },
  required: ["issues", "verdict", "candidates"],
};

const REPAIR_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slot: { type: "string", enum: ["prose", "aside", "question", "other_anchors", "night"] },
          id: { type: "string" },
          text: { type: "string" },
          why: { type: "string" },
        },
        required: ["slot", "text", "why"],
      },
    },
    unfixable: { type: "array", items: { type: "string" } },
  },
  required: ["edits", "unfixable"],
};

// The review prompt in two parts (2026-10-27). REVIEW_RUBRIC is the same text on
// every call, for every day: who the reviewer is, the evidence order, checks A-F,
// the issue format and how to settle candidates. The day's FACTS, THE REPORT, what
// code already caught and the CANDIDATES come after it. The CLI sends the rubric
// as an appended system prompt, because `claude -p` caches the system prompt and
// not a prefix of stdin (measured 2026-10-27: the same 23k-token text was written
// to cache afresh on every call at the top of stdin, and read from cache on the
// second call as a system prompt). On Opus the next review call then read 5.5k
// tokens from cache instead of 2.9k. Before this the whole prompt went on stdin,
// the rubric after the day's facts, so all of it was cache-written on every call.
// Who is usually with the user (agent/local/config/daily-summary.json
// `usual_companion`: { name, relation }), so "we" in the user's messages is read
// right. Absent: the rubric says nothing about it.
const USUAL_COMPANION = (() => {
  const { localConfig } = require("./instance.cjs");
  const u = localConfig("daily-summary", { usual_companion: null }).usual_companion;
  return u && u.name
    ? `(${u.name}, the user's ${u.relation || "companion"}, is usually with the user; "we" in the user's messages includes them)`
    : `("we" in the user's messages names who was there)`;
})();
const REVIEW_RUBRIC = `You are the independent reviewer of the user's daily report, about to be emailed to the user as the record of the user's day. Another model wrote it from facts that code computed. You did not write it. Find everything that is wrong, and say exactly how to fix it and who can fix it.

After these instructions come the day's FACTS (the inputs the report was built from), THE REPORT, anything code checks already caught, and any CANDIDATES for you to settle.

EVIDENCE, STRONGEST FIRST. Use this order whenever two sources disagree:
1. The user's own messages that day and corrections the user emailed. What the user said about where the user was, what the user did and who the user was with is the truth.
2. The user's own photos (where the camera was, the phone's venue reading, signs and things in frame, people) and the movement evidence and the Watch: the night, where the phone placed the user, the walking totals.
3. Stops built by code. A stop resting on "the user's own answer about this visit" is strong. A stop resting on an automatic match ("NOT the user's words about this visit", a proximity match, a resolver guess) is only as good as its fit with 1 and 2.
4. The prose.
Code-built stops are final for the PROSE REPAIR only. They are not proof. When a stop contradicts the user's messages or the movement evidence, report it as a code-owned defect (slot "none", usually high). Never ask for prose to be deleted or softened because it agrees with the user's words or the movement evidence and disagrees with a stop: a sentence that flags such a conflict is doing its job.

CHECK EVERY ONE OF THESE, IN ORDER:

A. THE USER'S WORDS ARE ALL THERE AND RIGHT.
- Every place the user named that day (by name or by link) is a stop at the right time, with the user's name for it. A place the user named that appears only in "Day's other anchors", or not at all, is a defect.
- Every stop whose window contains a message where the user says where the user is or was carries that place, not a different one.
- Every time, activity, meal or detail the user stated appears as the user said it: not contradicted, not misattributed to another stop.
- A question the report asks the user that the user already answered in the user's messages, or that the user's photos already answer.
- A stop whose photos place the user somewhere other than its title says (a photo at a café inside a block titled as the flat; the phone's venue reading or a sign naming a different place).

B. WHO WAS THERE. For each stop, work out who was with the user from the user's messages, the calendar, the people in the user's photos and the companions on record ${USUAL_COMPANION}. Then check:
- A person the user said was there who is missing from that stop (header companions or prose).
- A person named at a stop with no evidence they were there.
- The same group at consecutive or repeated stops treated inconsistently (named at one visit to a place and not at the next) without a reason in the facts.
- A person's relationship stated wrongly, or a group described in a way the user's messages contradict.
Missing companions in a header are code-owned (slot "none"); prose that omits or invents a person is prose.

C. THE SHAPE OF THE DAY.
- One stay shown as several back-to-back stops, or one place listed twice under any wording.
- A stop or walk that cannot be real: an outing at an hour the user was asleep, a long "walk" that covers almost no distance, a travel time or distance impossible for the gap, implied walking speed over about 7 km/h.
- A stop count or a total (stops, miles walked) that the stops and movement totals do not support.
- A meaningful event (a meal out, a visit, a show) present in the user's messages, the calendar or the user's photos with no stop of its own; a photo taken away from the stop it falls in (100 m+) is a likely missing stop.

D. TIMES AND ORDER.
- A stop beginning before the user woke or after the user fell asleep; overlapping stops; a first stop on a suspicious round hour; a clock time in prose that disagrees with its own header or with the user's messages; the wrong zone.

E. NAMES AND CERTAINTY.
- A venue asserted that the user never confirmed and the evidence does not support; a header that hedges while its prose states the place plainly, or the reverse.
- A generic or geocoded name ("a café by the flat", a street address) standing in for a place the user named.

F. PROSE ACCURACY.
- Prose about one stop narrating another stop's event; any number, name, person, amount, food or detail not in the facts.
- System, pipeline or debugging narration (emails "dropped by a list", commits, jobs, Jori's own fixes) presented as part of the user's day: report as "quality", delete.
- Any sentence about missing GPS, a silent or gappy phone, or the user possibly having "stepped out": these are banned. Kind "quality", severity "medium", fix "delete the sentence or clause".
- Garbled, repetitive, contradictory or obviously machine-written text; a task, item or line listed twice.

FOR EACH ISSUE give: kind; severity; detail quoting the report AND the fact or message it contradicts; headline, ONE plain sentence for the user (it may appear in the user's email: no stop ids, no "FACTS", no tiers or jargon, e.g. "Dinner at the trattoria was shown as the café"); fix; and the slot that carries the text: "prose" or "aside" with the stop id, "question" with the stop id, "other_anchors", "night", or "none" when the defect is in code-owned content (a header, a time, a title, a stop's existence or merging, header companions, the task list).

Rules:
- A code-owned defect is reported ONCE with slot "none". Do not also ask for prose to be changed to agree with it.
- Be specific and sure: quote both sides. Do not report a hunch.
- "high": the user would be misled, or would see at a glance that the user's own day is wrong (a wrong place, a missing meal the user named, a wrong companion, a split stay inflating the count). "medium": a real flaw the user would notice. "low": polish; leave it out unless clearly an error.
- Fixes may use anything in the user's messages and the facts. Do not suggest places, people, times or details found in neither.
- A clean report with verdict "publish" is a good outcome. Verdict "revise" if any high issue exists.

CANDIDATES (places the user named) are questions, not findings. Code compared their words, or their time, with the stop headers and found no match, but a word test cannot tell that two wordings are one place: "&" for "and", a possessive, a nickname, a home named by the people who live there, a street address for a home, the user's answer saved under the venue's own or Hebrew name. Settle every candidate from the user's messages, the facts and the report, and answer each id once in "candidates":
- "present": a stop in the report is that place, or the stop the user described, under any name. Copy into "quote" that stop's header line from THE REPORT, character for character and including its title (for example "7:17pm · The Example home"), and say in "where" why it is the same place. Only the header of a stop that names a place counts: an "unlabeled" stop, a stretch marked "not a stop" or "walking", or a walk is not that place (a place the user named that the report leaves unlabeled is absent), and a mention in a sentence of prose, in "Day's other anchors", in a travel line or in the task list does not make a place present.
- "absent": no stop in the report is that place. Say in "where" where you looked (the stops around that time) and what the report shows there instead.
- "unsure": only when the facts truly cannot tell you; say in "where" what is missing.
Answer a candidate only in "candidates", never again under "issues": an absent candidate becomes a finding from your answer. With no candidates, return an empty "candidates" list.`;

/**
 * The per-day part of the review prompt: the facts, the report, what code already
 * caught, and the candidates to settle. `candidates` are the CLI's unmatched
 * presence checks ({id, type, label, evidence, when}); see settleCandidates.
 */
function reviewDayPart({ facts, reportText, known = [], candidates = [] }) {
  const c = candidateLines(candidates);
  return `FACTS (the inputs the report was built from):
${facts}

THE REPORT (text only; photos and the map are not shown):
${reportText}
${known.length ? `\nALREADY CAUGHT BY CODE CHECKS (do not report these again):\n${known.map((k) => `- ${k}`).join("\n")}\n` : ""}${c.length ? `\nCANDIDATES TO SETTLE (answer every id in "candidates"):\n${c.join("\n")}\n` : ""}
Now review THE REPORT against the FACTS with every check in your instructions${c.length ? ", and settle every candidate" : ""}.`;
}

/** The whole review prompt, static rubric first: what a single-message caller sends. */
function reviewPrompt({ facts, reportText, known = [], candidates = [] }) {
  return `${REVIEW_RUBRIC}\n\n${reviewDayPart({ facts, reportText, known, candidates })}`;
}

function repairPrompt({ facts, prose, issues }) {
  return `You are repairing a daily report before it is emailed to the user. An independent review found the issues below. You may change ONLY the prose slots, and only as far as an issue requires.

FACTS (the user's own messages in them outrank everything else):
${facts}

THE PROSE SLOTS AS THEY ARE NOW (JSON; "prose", "asides" and "questions" are keyed by stop id):
${JSON.stringify(prose, null, 1)}

ISSUES TO REPAIR:
${issues.map((i, n) => `${n + 1}. [${i.kind}/${i.severity}] ${i.detail}\n   suggested fix: ${i.fix}\n   slot: ${i.slot ? `${i.slot.type}${i.slot.id ? " " + i.slot.id : ""}` : "unspecified"}`).join("\n")}

Return edits as {slot, id, text, why}: slot is "prose", "aside", "question", "other_anchors" or "night"; id is the stop id (omit for other_anchors and night); text is the COMPLETE new text for that slot, empty to delete it. Rules:
- The smallest change that resolves the issue. Deleting a wrong sentence beats rewriting it; a rewrite beats an addition.
- Use only what the FACTS and the existing text support. Never add a place, person, time, number or amount that is not already there. Never compute a time: quote it from the facts.
- Keep the voice: second person, warm, specific, at most two sentences per stop, no photo counts, nothing about GPS or a silent phone.
- Never delete or soften a sentence that agrees with the user's own messages or the movement evidence, even when it disagrees with a stop's header: that sentence is the honest one. If an issue asks you to, list it in "unfixable" instead.
- Titles, headers and times belong to code. If an issue is about one of them, do not touch prose to paper over it: list it in "unfixable" with a plain sentence saying what is wrong. If a time in the prose is right and the header's is wrong, leave the prose alone.
- Plain text only in prose, aside, question and night. other_anchors may use <ul>, <li>, <em>, <strong> and <a> only.
- If nothing needs changing, return no edits.`;
}

module.exports = {
  stopsBeforeWake, overlappingStops, splitStays, duplicateTasks, photosNotShown, hisMessages, photoLines, SOURCE_MEANING, scoreFindings, slotIds, applyEdits, anchorsMarkupOk,
  factPack, priorNightCalls, reviewPrompt, reviewDayPart, REVIEW_RUBRIC, repairPrompt, REVIEW_SCHEMA, REPAIR_SCHEMA,
  candidateLines, quotedInReport, quoteInStopTitle, quoteShows, isNamedVenueStop, classifyStopHeadings, headingTextOf, settleCandidates,
  SLEEP_EXEMPT_SOURCES, SEVERITY_WEIGHT,
};
