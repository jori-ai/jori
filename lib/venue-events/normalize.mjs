// venue-events/normalize.mjs — turn whatever a venue source hands back into
// one event shape, and give every event a stable key.
//
// Everything here operates on VENDOR-GENERATED strings (a venue's calendar
// markup, an ICS DTSTART, a ticketing API's date field), never on anything
// the user wrote. Date parsing is structure: "Sat, Oct 4", "2026-10-04T20:00",
// "10/04/2026" are machine formats, and an unparseable one stays null — the
// ranking model sees the raw string and can still read it.
//
// Event shape:
//   { key, source, venue, city, title, performers[], date (YYYY-MM-DD|null),
//     time (HH:MM|null), url, category, status, raw_date, price_min, first_seen }
//
// "Today" and a row's default metro are the installation's (instance().tz,
// venue-events home_metro — see config.mjs).

import { homeMetro, homeTz } from "./config.mjs";

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Lowercase, strip accents and punctuation — for KEYS, never for meaning.
 * Hebrew letters are kept (2026-10-07, the Israel feed): without them every
 * Hebrew title slugged to "" and all of a day's Israeli shows shared one key.
 * Latin-only strings slug exactly as before, so existing seen files still match.
 */
export function slug(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // lang-regex-ok: accent stripping on vendor event titles for a dedup key
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\u05d0-\u05ea]+/g, "-") // lang-regex-ok: key normalization of vendor titles (Latin + Hebrew letters)
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Stable dedup key: venue + date + title. Two sources listing the same show collide on purpose. */
export function eventKey({ venue, date, title }) {
  return `${slug(title)}|${slug(venue)}|${date || "undated"}`;
}

function pad(n) { return String(n).padStart(2, "0"); }

function ymd(y, m, d) {
  if (!(y > 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Parse a vendor date string. `ref` is the run date (YYYY-MM-DD); a date with
 * no year is placed on the next occurrence on/after ref - 7d (calendars list
 * "Oct 4" meaning the coming one; the 7-day slack keeps last week's show from
 * jumping a year ahead).
 */
export function parseVendorDate(raw, ref) {
  if (!raw) return null;
  const s = String(raw).trim();
  // ISO / ISO-ish (also ICS 20261004T200000)
  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/); // lang-regex-ok: ISO/ICS machine date
  if (m) return ymd(+m[1], +m[2], +m[3]);
  // US numeric 10/04/2026 or 10/4/26
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/); // lang-regex-ok: numeric vendor date
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return ymd(y, +m[1], +m[2]);
  }
  // "Oct 4", "October 4, 2026", "Sat, Oct 4 2026", "4 Oct 2026"
  const lower = s.toLowerCase();
  m = lower.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4})|\s*['\u2018\u2019](\d{2})\b)?/); // lang-regex-ok: vendor calendar date format ("Oct 8 ’26" included)
  let mon, day, year;
  if (m) { mon = MONTHS[m[1]]; day = +m[2]; year = m[3] ? +m[3] : m[4] ? 2000 + +m[4] : null; }
  else {
    m = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/); // lang-regex-ok: vendor calendar date format
    if (m) { day = +m[1]; mon = MONTHS[m[2]]; year = m[3] ? +m[3] : null; }
  }
  if (!mon) return null;
  if (year) return ymd(year, mon, day);
  const refD = new Date(`${ref || todayLocal()}T12:00:00Z`);
  const floor = new Date(refD.getTime() - 7 * 86400e3);
  let y = floor.getUTCFullYear();
  let cand = new Date(Date.UTC(y, mon - 1, day, 12));
  if (cand < floor) cand = new Date(Date.UTC(y + 1, mon - 1, day, 12));
  return ymd(cand.getUTCFullYear(), mon, day);
}

/** "8:00 PM", "20:00", "8pm", "T200000" → "HH:MM" (vendor time strings). */
export function parseVendorTime(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  let m = s.match(/t(\d{2})(\d{2})\d{2}/); // lang-regex-ok: ICS time
  if (m) return `${m[1]}:${m[2]}`;
  m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/); // lang-regex-ok: vendor showtime
  if (m) {
    let h = +m[1] % 12;
    if (m[3] === "pm") h += 12;
    return `${pad(h)}:${m[2] || "00"}`;
  }
  m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/); // lang-regex-ok: 24h vendor time
  if (m) return `${pad(+m[1])}:${m[2]}`;
  return null;
}

/** Today's date (YYYY-MM-DD) in the installation's home zone. */
export function todayLocal(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: homeTz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
// The historical name, kept for callers.
export const todayET = todayLocal;

export function addDays(ymdStr, n) {
  const d = new Date(`${ymdStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Build a normalized event; returns null when there is no title. */
export function makeEvent(src, fields, ref) {
  const title = String(fields.title || "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  const rawDate = fields.date ?? null;
  const date = parseVendorDate(rawDate, ref) || (fields.text_date ? parseVendorDate(fields.text_date, ref) : null);
  const time = fields.time ? (parseVendorTime(fields.time) || null) : (rawDate ? parseVendorTime(rawDate) : null);
  const venue = fields.venue || src.venue || null;
  return {
    key: eventKey({ venue, date, title }),
    source: src.key,
    venue,
    city: fields.city || src.city || homeMetro(),
    title,
    performers: (fields.performers || []).filter(Boolean),
    date,
    time,
    url: fields.url || src.url || null,
    category: fields.category || src.category || "music",
    status: fields.status || null,
    raw_date: rawDate ? String(rawDate).slice(0, 120) : null,
    description: fields.description ? String(fields.description).replace(/\s+/g, " ").trim().slice(0, 400) : null,
    price_min: fields.price_min ?? null,
  };
}
