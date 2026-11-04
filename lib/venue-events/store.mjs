// venue-events/store.mjs — the shared venue-events store (every configured
// venue source, home metro and regional feeds alike).
//
// One file, written by `venue-ingest` (daily), read by every watch lane
// (`venue-watch <lane>`), so the same rooms are fetched once, by code, instead
// of by a model in each lane.
//
//   data/venue-events-state.json
//   { updated_at, sources: { <key>: { kind, last_ok, last_nonzero, last_count,
//                                     last_error, zero_streak, error_streak,
//                                     listed_through, zero_since } },
// `last_ok` is the last attempt that did not throw — it is set even when the
// fetch came back EMPTY, so it cannot tell "this source is healthy" from "this
// source answers and has nothing". `last_nonzero` is the one that can.
// `listed_through` is the latest show date on the source's last non-empty run,
// or null if any row on that run was undated (an undated row never "happens");
// `zero_since` is the run date (home zone) its current empty streak began. Together
// they tell a calendar that ran out from a feed that broke (sourceHealthVerdict).
//     events: { <eventKey>: { ...event, groups[], first_seen, last_seen } } }
//
// The per-lane "already evaluated" sets live in each lane's own *-seen.json;
// cross-lane "already surfaced to the user" lives in venue-surfaced-state.json.

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { REPO } from "./fetchers.mjs";
import { todayLocal, addDays } from "./normalize.mjs";
import { venueConfig, homeMetro, nearZone } from "./config.mjs";

export const STORE_PATH = process.env.VENUE_EVENTS_STORE || path.join(REPO, "data/venue-events-state.json");
export const SURFACED_PATH = process.env.VENUE_SURFACED_STORE || path.join(REPO, "data/venue-surfaced-state.json");

export function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

// The shared helper (lib/atomic-write.js, D15); kept as an export for callers.
export function writeJsonAtomic(p, obj) {
  writeFileAtomic(p, JSON.stringify(obj, null, 2) + "\n");
}

export function loadStore(p = STORE_PATH) {
  const s = readJson(p, null) || {};
  return { updated_at: s.updated_at || null, sources: s.sources || {}, events: s.events || {} };
}

/**
 * Latest show date among `evs`, but only when EVERY row is dated; otherwise
 * null. An undated row (an article, a residency, an ongoing exhibit) never
 * happens, so its disappearance can never be put down to a calendar running
 * out (a guide source listing many undated rows and one dated one would
 * otherwise read as ran-out once that date passed).
 */
function fullyDatedThrough(evs) {
  let max = null;
  for (const ev of evs) {
    if (!ev?.date) return null;
    if (!max || ev.date > max) max = ev.date;
  }
  return max;
}

/**
 * Merge one source's fresh fetch into the store. A source that errors keeps
 * its previous events (a flaky page must not make shows "disappear" and then
 * re-appear as new tomorrow); a source that returns zero rows bumps
 * zero_streak, which venue-ingest reports. `ref` is the run's local date
 * (YYYY-MM-DD); it stamps `zero_since` when an empty streak begins.
 */
export function mergeSource(store, src, { events, error, ref }, nowIso) {
  const prev = store.sources[src.key] || {};
  const runDate = ref || String(nowIso).slice(0, 10);
  const h = { kind: src.kind, last_attempt: nowIso, last_ok: prev.last_ok || null,
    last_nonzero: prev.last_nonzero || null,
    last_count: prev.last_count ?? null, last_error: null,
    zero_streak: prev.zero_streak || 0, error_streak: prev.error_streak || 0,
    listed_through: prev.listed_through || null, zero_since: prev.zero_since || null };
  // Backfill for rows written before listed_through / zero_since existed
  // (2026-10-20). It must run before prune drops the source's past shows, and
  // venue-ingest merges before it prunes; doing it on error runs too means an
  // errored first run after the upgrade cannot lose the evidence.
  if (!h.listed_through) {
    h.listed_through = fullyDatedThrough(Object.values(store.events).filter((ev) => ev.source === src.key));
  }
  if (!h.zero_since && h.zero_streak > 0 && prev.last_nonzero) {
    h.zero_since = addDays(todayLocal(new Date(prev.last_nonzero)), 1);
  }
  if (error) {
    h.last_error = String(error).slice(0, 300);
    h.error_streak += 1;
    store.sources[src.key] = h;
    return { added: 0, updated: 0 };
  }
  h.error_streak = 0;
  // Backfill for rows written before `last_nonzero` existed: a row whose last
  // fetch returned events plainly HAS produced one, and without this seed the
  // first run after the upgrade would call every such source "never produced".
  if (!h.last_nonzero && (prev.last_count || 0) > 0) h.last_nonzero = prev.last_ok || null;
  h.last_ok = nowIso;
  h.last_count = events.length;
  if (events.length) {
    h.last_nonzero = nowIso;
    h.zero_since = null;
    h.listed_through = fullyDatedThrough(events);
  } else if (h.zero_streak === 0) {
    h.zero_since = runDate;
  }
  h.zero_streak = events.length ? 0 : h.zero_streak + 1;
  store.sources[src.key] = h;
  let added = 0, updated = 0;
  for (const ev of events) {
    const cur = store.events[ev.key];
    const groups = [...new Set([...(cur?.groups || []), ...(src.groups || [])])];
    if (cur) {
      store.events[ev.key] = { ...cur, ...ev, groups, first_seen: cur.first_seen, last_seen: nowIso };
      updated++;
    } else {
      store.events[ev.key] = { ...ev, groups, first_seen: nowIso, last_seen: nowIso };
      added++;
    }
  }
  return { added, updated };
}

/**
 * What a streak of bad runs actually means. The counter cannot distinguish two
 * conditions that are not the same thing, and conflating them produced a false
 * alert on 2026-10-06: a source that USED to return rows and stopped is a real
 * blind spot, while a source that has NEVER returned one is a source whose
 * configuration was never verified — the venue may not sell through this feed
 * at all, or another configured source may already carry the same room.
 * (E.g. an empty Ticketmaster parent record whose shows are filed under a room
 * record, or a venue whose only listings sit beyond the ingest horizon.)
 *
 * "ran-out" is the next split down (2026-10-20). A seasonal venue whose last
 * shows have simply happened (log counts 4, 4, 2 … 1, 0, 0, 0) and whose next
 * listing is past the horizon was once paged as "a genuine blind spot" while
 * its API answered 200. When every show the source listed
 * (`listed_through`) is dated before its empty streak began (`zero_since`),
 * the calendar ran out; nothing vanished while still in the future, so there
 * is nothing for anyone to fix and venue-ingest logs it instead of paging.
 * A source whose last non-empty run had any undated row is never judged
 * ran-out (its `listed_through` is null), so such a source going dark still
 * pages: that is the backstop skill-repair relies on when a same-day repair fails.
 */
export function sourceHealthVerdict(h, streak = 3) {
  if ((h?.error_streak || 0) >= streak) return "failing";
  if ((h?.zero_streak || 0) >= streak) {
    if (!h?.last_nonzero) return "never-produced";
    if (h.listed_through && h.zero_since && h.listed_through < h.zero_since) return "ran-out";
    return "went-quiet";
  }
  return "ok";
}

/** ONE system-channel row for every unhealthy source in a run, not one per source. */
export function venueHealthNote(flagged, streak = 3) {
  const lines = flagged.map(({ key, health, groups }) => {
    const lanes = (groups || []).length ? ` Lanes reading it: ${groups.join(", ")}.` : "";
    switch (sourceHealthVerdict(health, streak)) {
      case "failing":
        return `• ${key} — errored ${health.error_streak} runs running. Last error: ${health.last_error || "unknown"}.${lanes}`;
      case "went-quiet":
        return `• ${key} — came back empty ${health.zero_streak} runs running, having had events as recently as ${String(health.last_nonzero).slice(0, 10)}. This one is a genuine blind spot.${lanes}`;
      case "ran-out":
        // venue-ingest does not send these; worded as not-a-fault in case a caller does.
        return `• ${key} — came back empty ${health.zero_streak} runs running, but every show it listed (the last on ${health.listed_through}) has already happened. Its calendar ran out; nothing is broken, and it will fill again when new dates are announced.${lanes}`;
      default:
        return `• ${key} — has never returned a row since it was configured, so nothing here regressed; it has simply never worked. Either its fetcher is wrong, or it points at a record with no events (a venue that does not sell through this feed, or a room another configured source already covers). Needs a look at the source itself to tell those apart.${lanes}`;
    }
  });
  const head = flagged.length === 1
    ? "venue-ingest: one venue source needs a look"
    : `venue-ingest: ${flagged.length} venue sources need a look`;
  return `${head} — they are configured in the venue-events sources (agent/local/config/venue-events.json, sources / sources_file).\n\n${lines.join("\n")}`;
}

// Same-day repair signal (2026-10-16, lib/skill-repair.mjs). The 3-run
// streak above is the backstop; this fires on the FIRST bad run of a source
// whose fetcher reads a site's own markup or private feed (every kind but the
// Ticketmaster API, where an empty answer usually means nothing is listed).
//   - came back empty after a run with >= 5 events  -> went_quiet
//   - threw something that is not transport (HTTP status, timeout, DNS,
//     connection reset)                             -> parse_failed
// Returns {error, diagnostic} or null. Pure, so the rule is testable.
const API_KINDS = new Set(["tm"]);
const TRANSPORT = /\bHTTP \d{3}\b|\b(4\d\d|5\d\d)\b|timed? ?out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|fetch failed|aborted|AbortError|cdp unreachable|no TICKETMASTER/i; // lang-regex-ok: Node/HTTP error strings, machine-generated
export function repairSignal(src, prevCount, { events, error }) {
  if (API_KINDS.has(src.kind)) return null;
  if (error) {
    if (TRANSPORT.test(String(error))) return null;
    return { error: "parse_failed", diagnostic: String(error).slice(0, 300) };
  }
  if (!events.length && (prevCount || 0) >= 5) {
    return { error: "went_quiet", diagnostic: `returned 0 events; the previous run had ${prevCount}` };
  }
  return null;
}

/** Drop shows already past (2-day grace) and rows no source has listed for 21 days. */
export function prune(store, today) {
  const cutoffSeen = Date.parse(`${today}T00:00:00Z`) - 21 * 86400e3;
  let removed = 0;
  for (const [k, ev] of Object.entries(store.events)) {
    const past = ev.date && ev.date < shiftDays(today, -2);
    const stale = ev.last_seen && Date.parse(ev.last_seen) < cutoffSeen;
    if (past || stale) { delete store.events[k]; removed++; }
  }
  return removed;
}

function shiftDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Metros the store has a feed for (the morning brief's EVENTS section says so elsewhere). */
export const EVENT_METROS = [...(venueConfig().metros || [])];

/**
 * One day's store events in the metro the user is in, for the morning brief. A
 * row from a regional feed that carries `gate_metro` belongs to that metro, and
 * only its near-base rows (zone = venue-events `near_zone`) count as tonight;
 * every other row is a home-metro venue (`city` defaults to home_metro in makeEvent).
 */
export function eventsInMetroOn(store, metro, date, { home = homeMetro(), near = nearZone() } = {}) {
  return Object.values(store.events).filter((ev) => ev.date === date
    && (ev.gate_metro ? ev.gate_metro === metro && ev.zone === near : (ev.city || home) === metro));
}

/** Events a lane may consider: in one of its groups, dated within the horizon (undated kept), not cancelled. */
export function eventsForGroups(store, groups, { today, horizonDays = 120 }) {
  const want = new Set(groups);
  const end = shiftDays(today, horizonDays);
  return Object.values(store.events).filter((ev) =>
    (ev.groups || []).some((g) => want.has(g))
    && (!ev.date || (ev.date >= today && ev.date <= end))
    && ev.status !== "cancelled" && ev.status !== "postponed");
}
