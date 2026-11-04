// festival-watch.mjs — the code half of the festival watch (bin/festival-watch-run).
//
// Presence windows from the travel timeline, the deep/weekly horizon decision,
// the deferred queue, dedup keys and the email render. An agent turn once did
// all of this by hand (a 91-iteration `travel where` loop in bash, the window
// collapsing in its head, the "is this the first run of the month" question it
// once got wrong at real cost). The only model work left is finding and
// verifying festivals, in ONE capped web-search call.
//
// Config: agent/local/config/festival-watch.json (lib/instance.cjs localConfig)
//   enabled          true turns the watch on (default off: a fresh install runs nothing)
//   audience         who the festivals are for, in the search brief ("the user")
//   fallback_metros  metro slugs scanned for the next 30 days when the travel
//                    timeline is empty (default none: an empty timeline = nothing to scan)
//   metro_names      {metro slug: city name} where the slug does not spell the
//                    city ("far_city" reads as "Far City" without an entry)
//   cap              festivals emailed per run; the rest are deferred (default 10)

import { createRequire } from "node:module";
import { slug } from "./venue-events/normalize.mjs";

const require = createRequire(import.meta.url);
const { localConfig } = require("./instance.cjs");

const DEFAULTS = { enabled: false, audience: "the user", fallback_metros: [], metro_names: {}, cap: 10 };

/** This installation's festival-watch settings (off without a config). */
export function festivalConfig() {
  return localConfig("festival-watch", DEFAULTS);
}

export const CATEGORIES = ["music-food", "art-culture", "street-market", "sports-outdoor"];

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * days: [{date, metro, label}] (one per day, gaps allowed) → windows
 * [{metro, city_label, start, end}]. A single day of one metro sandwiched
 * between two days of another metro is transit and is absorbed; a window
 * needs at least one full day.
 */
export function collapseWindows(days) {
  const d = days.filter((x) => x && x.metro && x.metro !== "transit");
  // absorb isolated one-day blips between the same metro on both sides
  for (let i = 1; i < d.length - 1; i++) {
    if (d[i].metro !== d[i - 1].metro && d[i - 1].metro === d[i + 1].metro) d[i] = { ...d[i], metro: d[i - 1].metro, label: d[i - 1].label };
  }
  const out = [];
  for (const x of d) {
    const last = out[out.length - 1];
    if (last && last.metro === x.metro && addDays(last.end, 1) === x.date) last.end = x.date;
    else out.push({ metro: x.metro, city_label: x.label || x.metro, start: x.date, end: x.date });
  }
  // a lone 1-day window between two different metros is a travel day
  return out.filter((w, i) => !(w.start === w.end && out[i - 1] && out[i + 1] && out[i - 1].metro !== out[i + 1].metro));
}

/** Deep 31–90 band runs once per calendar month, decided from the marker, never from last_run. */
export function deepDue(state, monthYm) {
  const marker = state.last_deep_sweep_month || (state.last_run ? String(state.last_run).slice(0, 7) : "");
  return marker !== monthYm;
}

/** Trim windows to the band scanned this run: always days 0–30, plus 31–90 when deep. */
export function scanWindows(windows, today, deep) {
  const nearEnd = addDays(today, 30);
  const farEnd = addDays(today, 90);
  const out = [];
  for (const w of windows) {
    const start = w.start < today ? today : w.start;
    const end = deep ? (w.end > farEnd ? farEnd : w.end) : (w.end > nearEnd ? nearEnd : w.end);
    if (start <= end) out.push({ ...w, start, end, band: end > nearEnd ? "deep" : "near" });
  }
  return out;
}

export function festKey(ev) {
  return `${ev.metro}|${slug(ev.name)}|${ev.start}`;
}

export function pruneSeen(seen, today) {
  const cut = addDays(today, -7);
  return seen.filter((e) => (e.end || e.start || "9999") >= cut);
}

/** Split survivors into this run's ≤cap emailed set (soonest first) and the deferred rest. */
export function capAndDefer(events, cap = 10) {
  const sorted = [...events].sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { emailed: sorted.slice(0, cap), deferred: sorted.slice(cap) };
}

/** A metro slug as a city name: a configured name, else the slug title-cased. */
export function metroCity(metro, names = festivalConfig().metro_names || {}) {
  if (names[metro]) return names[metro];
  return String(metro).split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}
