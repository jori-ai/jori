#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { readStdinJson, emit, emitNull, stampRun, GOG_ACCOUNT, localConfig } from "./_common.mjs";
import { eventPeopleLine } from "../../../lib/meeting-event.mjs";

import { installTools } from "../../../lib/root.cjs";
const HUM_STATE_FILE = installTools("data/hum-state.json");

/**
 * Return true if the two [start,end) intervals overlap by more than 1s.
 * Touching edges (end == start) do NOT count as a conflict — a standard
 * back-to-back calendar layout shouldn't emit a conflict signal.
 */
export function overlaps(s1, e1, s2, e2) {
  if (!s1 || !e1 || !s2 || !e2) return false;
  const start = Math.max(s1, s2);
  const end = Math.min(e1, e2);
  return end - start > 1000;
}

// Summary prefixes that mark someone else's events on the user's calendar
// (agent/local/config/hum-calendar.json `ignore_summary_prefixes`).
const CALENDAR_CFG = localConfig("hum-calendar", { ignore_summary_prefixes: [] });

/**
 * Filter out events that shouldn't participate in conflict detection:
 *   - transparency === "transparent" (shown as "free" on the calendar — e.g.,
 *     maintenance blocks, other people's events marked free, workout placeholders)
 *   - summary starting with one of the configured ignore prefixes (e.g. a
 *     someone-else's-event tag per the local calendar-scheduling convention — they
 *     don't block the user's time even if they accidentally default to opaque
 *     transparency)
 * Also filters events without valid start/end so downstream code can rely
 * on numeric timestamps.
 */
export function filterScannableEvents(events) {
  return (events || [])
    .map((e) => {
      const start = new Date(e?.start?.dateTime || e?.start?.date || 0).getTime();
      const end = new Date(e?.end?.dateTime || e?.end?.date || 0).getTime();
      return { ...e, _start: start, _end: end };
    })
    .filter((e) => {
      if (!e._start || !e._end) return false;
      if (e.transparency === "transparent") return false;
      const summary = String(e.summary || "").trim();
      if (CALENDAR_CFG.ignore_summary_prefixes.some((p) => summary.startsWith(p))) return false;
      return true;
    });
}

/**
 * Stable pair key: lowercase both summaries, trim, sort alphabetically.
 * Ensures (a,b) and (b,a) dedup to the same key regardless of ordering.
 */
export function pairKey(a, b) {
  const na = String(a || "").trim().toLowerCase();
  const nb = String(b || "").trim().toLowerCase();
  return [na, nb].sort().join("::");
}

/**
 * Read the hum-state.json dedup map for today, pruning any older-date keys.
 * Returns { state, todayKey, todayList } — callers mutate todayList in place
 * then pass state back to writeDedup.
 */
export function readDedup(nowDate = new Date()) {
  const todayKey = nowDate.toISOString().slice(0, 10);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(HUM_STATE_FILE, "utf8"));
  } catch {
    state = {};
  }
  const map = state.calendar_conflict_dedup;
  const pruned = {};
  if (map && typeof map === "object") {
    for (const k of Object.keys(map)) {
      if (k === todayKey && Array.isArray(map[k])) pruned[k] = map[k].slice();
    }
  }
  state.calendar_conflict_dedup = pruned;
  if (!Array.isArray(state.calendar_conflict_dedup[todayKey])) {
    state.calendar_conflict_dedup[todayKey] = [];
  }
  return { state, todayKey, todayList: state.calendar_conflict_dedup[todayKey] };
}

export function writeDedup(state) {
  try {
    fs.writeFileSync(HUM_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[calendar] dedup state write failed: ${e.message}`);
  }
}

/**
 * A scheduled departure (ferry, train, bus, flight) whose time was never checked
 * against a timetable or a booking. `jori-calendar --transit` stamps a departure
 * with private extended properties (jori_transit=1, and jori_transit_verified=1
 * only when it was given a source); `gog calendar list --json` returns each event
 * whole, so they arrive with it. A departure with no verified stamp counts as
 * unverified. Not a departure, or a verified one: false.
 */
export function transitTimeUnverified(e) {
  const priv = e?.extendedProperties?.private || {};
  return priv.jori_transit === "1" && priv.jori_transit_verified !== "1";
}

// The departure's clock time in the event's own zone ("14:00"), the zone its
// timetable is written in. Google renders dateTime's offset in the calendar's
// zone, not the event's, so the string is never sliced: the instant is formatted
// in start.timeZone. No usable zone (or an all-day event): null, and the signal
// names no time rather than a time that may be hours off.
function listedTime(start) {
  const t = Date.parse(start?.dateTime || "");
  const tz = start?.timeZone;
  if (!Number.isFinite(t) || !tz) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
  } catch {
    return null;
  }
}

/**
 * Events starting 10–60 minutes from now. A countdown to an unverified departure
 * is how a boat or a train gets missed (the wrong time looks just as sure as the
 * right one, and the outbound gate checks the ping against the same entry), so
 * such an entry carries no `minsToStart`: it says the time is unverified and
 * gives the time as listed. Every other event is exactly as before.
 */
export function upcomingSoon(events, now = Date.now()) {
  const soon = [];
  for (const e of events || []) {
    const minsToStart = Math.round((e._start - now) / 60000);
    if (minsToStart >= 10 && minsToStart <= 60) {
      if (transitTimeUnverified(e)) {
        soon.push({
          summary: e.summary,
          time_verified: false,
          listed_time: listedTime(e.start),
          location: e.location || null,
          ...peopleField(e),
        });
      } else {
        soon.push({
          summary: e.summary,
          minsToStart,
          location: e.location || null,
          ...peopleField(e),
        });
      }
    }
  }
  return soon;
}

/**
 * Who the event is actually with, from its own organizer and guests (never its
 * title). A composer may name a person, or say how the user knows them, only
 * from this line, from the event's notes, or from a page matched on one of
 * these e-mail addresses; a first name in the title identifies nobody.
 */
function peopleField(e) {
  const people = eventPeopleLine(e);
  return people ? { people } : {};
}

/** The candidate's signal for one `upcomingSoon` entry. */
export function soonSignal(s) {
  const who = s.people ? ` [the event itself lists: ${s.people}]` : "";
  if (s.time_verified === false) {
    return `"${s.summary}" is on the calendar${s.listed_time ? " for " + s.listed_time : ""}, but that departure time was never checked against a timetable or a booking: check the timetable before counting on it${
      s.location ? " (" + s.location + ")" : ""
    }${who}`;
  }
  return `"${s.summary}" starts in ${s.minsToStart}min${
    s.location ? " at " + s.location : ""
  }${who}`;
}

// ── main (skip when imported for tests) ───────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { situation: sit } = await readStdinJson();

  try {
    // --json returns each event whole, extendedProperties included: the
    // departure stamps (transitTimeUnverified) are read from there, so never
    // narrow this call with --fields / --select without keeping them.
    const json = execFileSync(
      process.env.GOG_BIN || "/opt/homebrew/bin/gog",
      ["calendar", "list", ...(GOG_ACCOUNT ? ["--account", GOG_ACCOUNT] : []), "--days", "2", "--max", "30", "--json"],
      { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "ignore"] },
    );
    const data = JSON.parse(json);
    const rawEvents = data?.events || data?.items || data || [];
    const events = filterScannableEvents(rawEvents);

    const now = Date.now();
    const conflicts = [];

    // Strict O(n^2) overlap over all pairs (n ≤ 30 here; trivial cost).
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const a = events[i];
        const b = events[j];
        if (overlaps(a._start, a._end, b._start, b._end)) {
          conflicts.push({ a: a.summary, b: b.summary });
        }
      }
    }

    const soon = upcomingSoon(events, now);

    // Dedup pairs already emitted today.
    const { state, todayKey, todayList } = readDedup(new Date());
    const newConflicts = [];
    for (const c of conflicts) {
      const key = pairKey(c.a, c.b);
      if (todayList.includes(key)) continue;
      newConflicts.push({ ...c, _key: key });
    }

    if (newConflicts.length === 0 && soon.length === 0) {
      stampRun("calendar", false);
      emitNull(
        conflicts.length > 0
          ? `all ${conflicts.length} conflict(s) already deduped for ${todayKey}`
          : "no conflicts or imminent",
      );
      process.exit(0);
    }

    let signal, urgency, dedupKey;
    if (newConflicts.length > 0) {
      const c = newConflicts[0];
      signal = `Calendar conflict: "${c.a}" overlaps "${c.b}"`;
      urgency = 0.8;
      dedupKey = `calendar:${(c.a || "").slice(0, 40)}`;
      // Record ALL new pairs so subsequent ticks today don't re-emit any of them.
      for (const nc of newConflicts) {
        if (!todayList.includes(nc._key)) todayList.push(nc._key);
      }
      writeDedup(state);
    } else {
      const s = soon[0];
      signal = soonSignal(s);
      const awayFromEvent =
        s.location && sit?.where?.place && !s.location.includes(sit.where.place);
      urgency = awayFromEvent ? 0.7 : 0.4;
      dedupKey = `calendar:${(s.summary || "").slice(0, 40)}`;
    }

    stampRun("calendar", true);
    emit({
      topic: "calendar",
      signal,
      urgency,
      freshness_min: 0,
      dedup_key: dedupKey,
      supporting_data: {
        conflicts: newConflicts.map(({ a, b }) => ({ a, b })),
        soon,
      },
    });
  } catch (e) {
    emitNull(`gog calendar failed: ${e.message}`);
  }
}
