"use strict";
/**
 * calendar-presence — "the calendar beats the travel database": the calendar
 * check supersedes the travel timeline, which may be outdated. Applied inside
 * presence resolution so every reader of `travel in-city` / `travel where` /
 * `resolvePresence` inherits it — all the location-gated lanes, not only the
 * ones that once checked the calendar by hand.
 *
 * The motivating kind of day: the timeline says the home city all day; the
 * calendar says "Train to <town>" 15:00-17:10, "Dinner with <friends>" 18:45,
 * "Train back" 20:45-23:00 — every `location` null. Only the TITLES say where,
 * so deciding it is language (Rule #0b): a model reads the day's events and
 * says whether they show the user away from the timeline's city and which
 * events are the evidence. Code owns everything else — which days are asked,
 * the away WINDOW (from the evidence events' own start/end), and applying it.
 *
 * Three properties (settled in the design, before the build):
 *   (a) WEAKEN-ONLY. An override turns an IN into an AWAY, never the reverse.
 *       It only ever applies on top of a resolved city (or an ambiguous stay);
 *       an unknown or in-transit instant is left exactly as it was.
 *   (b) NO FILE, NO INTERPRETATION. A missing, unreadable or too-old file means
 *       behaviour byte-identical to having no override at all. Never a regex
 *       fallback over event titles.
 *   (c) AN INSTANT, NOT A DATE. The window is the evidence events' span, so a
 *       10am home-city item on the day-trip day still reads IN.
 *
 * Days are the installation's home-zone days (instance().tz).
 *
 * This file is the pure half (CommonJS, so presence.js can require it): the
 * file format, grouping a calendar into per-day questions, deriving windows,
 * and applying them. The producer that asks the model and writes the file is
 * lib/calendar-presence-refresh.mjs; `bin/travel` runs it lazily
 * (refresh on read) when the file is older than REFRESH_TTL_MS — chosen over
 * an hourly cron because a same-day trip is often put on the calendar minutes
 * before it starts.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { installTools } = require("./root.cjs");

const OVERRIDE_FILE = process.env.CALENDAR_PRESENCE_FILE
  || installTools("data", "calendar-presence-overrides.json");

/** The installation's home zone (instance().tz), read once. */
let _tz = null;
function homeTz() {
  return (_tz ||= require("./instance.cjs").instance().tz);
}
const OFF_FILE = path.join(path.dirname(OVERRIDE_FILE), ".calendar-presence-off");

/** Rebuild on read when the file is older than this. */
const REFRESH_TTL_MS = 30 * 60 * 1000;
/** Ignore the file entirely past this age (refresh broken for hours → today's behaviour). */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** How far ahead the calendar is read. Event lanes look out 60+ days. */
const HORIZON_DAYS = 60;
/** The metro value an overridden instant resolves to. Not a city: "not where the timeline said". */
const ELSEWHERE = "elsewhere";

function disabled() {
  return process.env.CALENDAR_PRESENCE === "off" || fs.existsSync(OFF_FILE);
}

/** The base key an override is decided against: a metro, or the canonical ambiguous list. */
function baseKeyOf(res) {
  if (!res) return null;
  if (res.ambiguous && Array.isArray(res.candidates) && res.candidates.length) return [...res.candidates].sort().join("|");
  if (!res.metro || res.metro === "transit" || res.metro === ELSEWHERE) return null;
  return res.metro;
}

/**
 * The override file, or null when there is none to use (missing, unreadable,
 * malformed, older than maxAgeMs, or switched off). Never throws.
 */
function loadOverrides({ file = OVERRIDE_FILE, nowMs = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  if (disabled()) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const gen = Date.parse(j.generated_at);
    if (!Number.isFinite(gen) || nowMs - gen > maxAgeMs || !Array.isArray(j.windows)) return null;
    return j;
  } catch {
    return null;
  }
}

/** Age of the override file in ms (Infinity when missing). */
function overrideAgeMs({ file = OVERRIDE_FILE, nowMs = Date.now() } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const gen = Date.parse(j.generated_at);
    return Number.isFinite(gen) ? nowMs - gen : Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * Apply the override to one resolved presence. Pure.
 * `res` is resolvePresenceAt's result; returns it unchanged unless a window
 * covers `instantMs` AND was decided against the same base metro.
 */
function applyCalendarOverride(res, instantMs, overrides) {
  const windows = overrides && Array.isArray(overrides.windows) ? overrides.windows : [];
  const base = baseKeyOf(res);
  if (!base || !windows.length) return res;
  const w = windows.find((x) => x.base === base
    && Date.parse(x.from) <= instantMs && instantMs < Date.parse(x.to));
  if (!w) return res;
  const titles = (w.evidence || []).map((e) => e.title).filter(Boolean);
  return {
    metro: ELSEWHERE,
    label: `away from ${base} per calendar${titles.length ? `: ${titles.join(", ")}` : ""}`,
    source: "calendar",
    base_metro: base,
    base_source: res.source,
    calendar_override: { date: w.date, from: w.from, to: w.to, evidence: w.evidence || [] },
  };
}

// ── Producer helpers (pure) ────────────────────────────────────────────────

/** Home-zone calendar date of an epoch ms. */
function etDate(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: homeTz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** Epoch ms of local midnight on a home-zone date (DST-aware, two passes). */
function etMidnightMs(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0);
  const off = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: homeTz(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  let ms = guess - off(guess);
  ms = guess - off(ms);
  return ms;
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** gog/Google event part ({dateTime}|{date}) → epoch ms, or null. */
function partMs(part) {
  if (!part) return null;
  if (part.dateTime) { const t = Date.parse(part.dateTime); return Number.isFinite(t) ? t : null; }
  if (part.date) return etMidnightMs(part.date);
  return null;
}

/** A calendar event worth reading: not cancelled, not one the user declined. */
function usableEvent(e) {
  if (!e || e.status === "cancelled") return false;
  const self = (e.attendees || []).find((a) => a && a.self);
  if (self && self.responseStatus === "declined") return false;
  return partMs(e.start) != null;
}

/**
 * Group calendar events into per-(home-zone day, base metro) questions.
 * `resolveBase(ms)` → resolvePresenceAt result WITHOUT any override.
 * Returns [{key, date, base, dayStart, dayEnd, events:[{title, start, end, location, all_day, free}]}].
 * An event spanning several days joins every day it touches (capped at 14).
 */
function groupDays(events, resolveBase, { fromDate, toDate } = {}) {
  const groups = new Map();
  for (const e of events || []) {
    if (!usableEvent(e)) continue;
    const s = partMs(e.start);
    let en = partMs(e.end);
    if (en == null || en <= s) en = s + 60 * 60 * 1000;
    const ev = {
      title: String(e.summary || "(untitled)").slice(0, 200),
      start: new Date(s).toISOString(),
      end: new Date(en).toISOString(),
      location: e.location ? String(e.location).slice(0, 200) : null,
      // The description's opening lines tell a guest's reservation at a
      // property the user lets out (a booking-platform confirmation with a
      // guest count) from a stay of the user's own, which the title alone does
      // not: guest stays read as the user being there hid home-city events.
      note: e.description ? String(e.description).slice(0, 160) : null,
      all_day: !(e.start && e.start.dateTime),
      free: e.transparency === "transparent",
    };
    let day = etDate(s);
    for (let i = 0; i < 14; i++) {
      const dayStart = etMidnightMs(day);
      const dayEnd = etMidnightMs(addDays(day, 1));
      if (dayStart >= en) break;
      if ((!fromDate || day >= fromDate) && (!toDate || day <= toDate)) {
        const probe = Math.max(s, dayStart) + 1;
        const base = baseKeyOf(resolveBase(probe));
        if (base) {
          const key = `${day}|${base}`;
          if (!groups.has(key)) groups.set(key, { key, date: day, base, dayStart, dayEnd, events: [] });
          groups.get(key).events.push(ev);
        }
      }
      day = addDays(day, 1);
    }
  }
  for (const g of groups.values()) g.events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Stable hash of what the model would see for a group (base + events). */
function groupHash(g) {
  return crypto.createHash("sha1").update(JSON.stringify([g.base, g.events])).digest("hex").slice(0, 16);
}

/**
 * The away window for a group from the indexes of its evidence events: from
 * the earliest evidence start to the latest evidence end, clipped to the day.
 * null when nothing is flagged.
 */
function deriveWindow(g, flagged) {
  const ev = (flagged || []).map((i) => g.events[i]).filter(Boolean);
  if (!ev.length) return null;
  const from = Math.max(Math.min(...ev.map((e) => Date.parse(e.start))), g.dayStart);
  const to = Math.min(Math.max(...ev.map((e) => Date.parse(e.end))), g.dayEnd);
  if (!(to > from)) return null;
  return {
    date: g.date, base: g.base,
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    evidence: ev.map((e) => ({ title: e.title, start: e.start, end: e.end })),
  };
}

module.exports = {
  OVERRIDE_FILE, OFF_FILE, REFRESH_TTL_MS, MAX_AGE_MS, HORIZON_DAYS, ELSEWHERE,
  disabled, baseKeyOf, loadOverrides, overrideAgeMs, applyCalendarOverride,
  homeTz, etDate, etMidnightMs, addDays, partMs, usableEvent, groupDays, groupHash, deriveWindow,
};
