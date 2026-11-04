"use strict";
// watching-projection.js — forecast when an in-progress show will finish
// based on a default TV pacing (one episode an evening, 20:00-22:00 local),
// with days blocked whenever the calendar has an event overlapping that window.
//
// Exports:
//   projectFinaleDate({ last_watched_date, started_at, episodes_remaining,
//                        tz = instance().tz, now = new Date() })
//     → Promise<{ projected_finale_date, blocked_dates[], free_days_used,
//                  days_between_now_and_finale }>

const { fetchCalendarJson } = require("./location-calendar-fuse.js");
const { instance } = require("./instance.cjs");

function pad(n) { return n.toString().padStart(2, "0"); }

// Walk day-by-day in the target TZ; skip days with calendar event overlapping
// the evening window (local). Stop after `episodesRemaining` free days and return that
// date as the projected finale.
async function projectFinaleDate({
  last_watched_date,
  started_at,
  episodes_remaining,
  tz = instance().tz,
  now = new Date(),
  window_start_hour = 20,
  window_end_hour = 22,
}) {
  if (!episodes_remaining || episodes_remaining <= 0) {
    return {
      projected_finale_date: last_watched_date || started_at || null,
      blocked_dates: [],
      free_days_used: 0,
      days_between_now_and_finale: 0,
    };
  }

  const startFrom = last_watched_date || started_at;
  if (!startFrom) throw new Error("need last_watched_date or started_at");

  // Search window: generous upper bound so blocked days don't exhaust it.
  // A typical month has ~8-10 blocked evenings → allow 3× the remaining.
  const searchSpanDays = Math.max(episodes_remaining * 3, 14);
  const base = new Date(startFrom + "T00:00:00Z");
  const endDate = new Date(base.getTime() + searchSpanDays * 86400000);
  const endStr = `${endDate.getUTCFullYear()}-${pad(endDate.getUTCMonth() + 1)}-${pad(endDate.getUTCDate())}`;

  let events = [];
  try {
    const cal = await fetchCalendarJson(startFrom, endStr, { tz });
    events = cal.events || [];
  } catch (e) {
    // Calendar fetch failed — fall back to "no blocks" (optimistic projection).
    events = [];
  }

  // For each event, compute start+end as JS Dates.
  // Timed events have `dateTime`; all-day events have `date`. All-day events
  // block the whole day (including 20-22 window) → flag.
  function isBlockedDate(dateStr) {
    const dayStart = new Date(`${dateStr}T${pad(window_start_hour)}:00:00${offsetFor(tz, dateStr)}`);
    const dayEnd = new Date(`${dateStr}T${pad(window_end_hour)}:00:00${offsetFor(tz, dateStr)}`);
    for (const ev of events) {
      if (ev.start.date && !ev.start.dateTime) {
        // All-day event. Does it cover this dateStr?
        const ad_start = ev.start.date;
        const ad_end = ev.end?.date || ev.start.date;
        if (ad_start <= dateStr && dateStr < ad_end) return true;
      } else if (ev.start.dateTime && ev.end?.dateTime) {
        const s = new Date(ev.start.dateTime);
        const e = new Date(ev.end.dateTime);
        // Overlap check: event overlaps [dayStart, dayEnd)?
        if (s < dayEnd && e > dayStart) return true;
      }
    }
    return false;
  }

  const blocked_dates = [];
  let cursor = new Date(base.getTime() + 86400000); // start counting the day AFTER last_watched_date
  let freeDays = 0;
  let projected = null;
  for (let i = 0; i < searchSpanDays; i++) {
    const dateStr = `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`;
    if (isBlockedDate(dateStr)) {
      blocked_dates.push(dateStr);
    } else {
      freeDays++;
      if (freeDays === episodes_remaining) {
        projected = dateStr;
        break;
      }
    }
    cursor = new Date(cursor.getTime() + 86400000);
  }

  // Days between `now` and projected finale (0 = today, 1 = tomorrow, etc.)
  let days_between_now_and_finale = null;
  if (projected) {
    const nowTzStr = toTzDate(now, tz);
    days_between_now_and_finale = daysBetween(nowTzStr, projected);
  }

  return {
    projected_finale_date: projected,
    blocked_dates,
    free_days_used: freeDays,
    days_between_now_and_finale,
  };
}

// Helper: current TZ offset in ±HH:MM form for a given date.
function offsetFor(tz, dateStr) {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
  const parts = fmt.formatToParts(probe);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+0";
  const m = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return "+00:00";
  return `${m[1]}${pad(m[2])}:${(m[3] || "00").padStart(2, "0")}`;
}

function toTzDate(d, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}

function daysBetween(aStr, bStr) {
  const a = new Date(aStr + "T00:00:00Z");
  const b = new Date(bStr + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

module.exports = { projectFinaleDate, toTzDate, daysBetween };
