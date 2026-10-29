// ticket-lottery.mjs — config and pure helpers shared by the ticket-lottery
// entry script (bin/ticket-lottery-run), the day-of rush watcher
// (bin/ticket-rush-run) and the curated-list CLI (bin/ticket-shows).
//
// Everything here parses MACHINE-GENERATED strings — platform listing titles,
// "Wednesday, May 27, 2026 at 7:00PM" / "05/27/26, 7:00 PM" date stamps,
// templated confirmation emails and URLs. None of it reads anything the user
// wrote, so the regexes below are structure, not language (Rule #0b).
//
// Which platforms are entered, where their browsing skills live, which
// mailboxes confirm an entry and where the state files are: all this
// installation's, from agent/local/config/ticket-lottery.json (optionally a
// private `catalogue_file` holding the same keys — the platform names and
// URLs stay out of the config the kernel guard derives tokens from). No config:
// no platforms and no rush source — the scripts exit without doing anything.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { instance, localConfig } = require("./instance.cjs");
const { installTools } = require("./root.cjs");

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * agent/local/config/ticket-lottery.json (keys may instead live in the private
 * `catalogue_file`, repo-relative; the local config wins key by key):
 *
 *   metro          the metro every performance date is gated against (metro-presence)
 *   tz             the zone "today" is read in (default: the instance zone)
 *   title          the summary's name ("Ticket lottery")
 *   intent         the send intent of the summary / rush ping
 *   cdp_host       the owner's automation Chrome (default localhost:9222)
 *   tickets        tickets per entry (default 2)
 *   shows_file     the curated list {shows:[{title, aliases?, note?}], retired:[…]}
 *   files          {state, pause_all, pauses, exemptions, guest, profile, error_classes}
 *   soft_block     {meeting: <lib/meetings.mjs id>, note} — overlapping only that
 *                  meeting never blocks an entry; the row gets `note`
 *   close_tabs     URL substrings whose automation-Chrome tabs are closed after a run
 *   platforms      {<key>: platform} in run order; per platform:
 *     kind         "list-enter" (list the open drawings, enter each by event id;
 *                  optional `mirror` entrants on their own Chrome) or
 *                  "form-email" (list performances with ids, submit the entry form
 *                  from the profile file, finalise from the confirmation email)
 *     label, site  display name; the browsing-skill directory (browsing-skills/skills/<site>)
 *     url          the listing page
 *     date_format  "long" ("Wednesday, May 27, 2026 at 7:00PM") | "slash" ("05/27/26, 7:00 PM")
 *     mirror       [{entrant, label, cdp_host}]                       (list-enter)
 *     entry_url    "…{perfId}…" when a performance has no popup url    (form-email)
 *     emails       {verify: <gmail query>, received: <gmail query>,
 *                   received_marker: <subject text>, wait_min}        (form-email)
 *   rush           {site, action, url, label, intent, state_file, pause_file, close_tabs[]}
 */
const DEFAULTS = {
  catalogue_file: null,
  metro: "",
  tz: "",
  title: "Ticket lottery",
  intent: "ticket-lottery",
  cdp_host: "localhost:9222",
  tickets: 2,
  shows_file: "data/lottery-shows.json",
  files: {},
  soft_block: null,
  close_tabs: [],
  platforms: {},
  rush: null,
};

const FILE_DEFAULTS = {
  state: "data/ticket-lottery-state.json",
  pause_all: "data/ticket-lottery-all-paused.json",
  pauses: "data/ticket-lottery-pauses.json",
  exemptions: "data/ticket-lottery-exemptions.json",
  guest: "data/ticket-lottery-guest-mode.json",
  profile: "data/lottery-profile.json",
  error_classes: "data/ticket-lottery-error-classes.json",
};

/** An installation path: absolute as given, else under the installation (read per call, so tests can move HOME). */
export function installPath(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : installTools(p);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** The resolved config: defaults ← catalogue_file ← local config; file paths absolute. */
export function lotteryConfig() {
  const local = localConfig("ticket-lottery", {});
  const cat = local.catalogue_file ? readJson(installPath(local.catalogue_file), {}) || {} : {};
  const cfg = { ...DEFAULTS, ...cat, ...local };
  cfg.files = Object.fromEntries(Object.entries({ ...FILE_DEFAULTS, ...(cat.files || {}), ...(local.files || {}) })
    .map(([k, v]) => [k, installPath(v)]));
  cfg.shows_file = installPath(cfg.shows_file);
  cfg.tz = cfg.tz || instance().tz || "UTC";
  cfg.platforms = cfg.platforms && typeof cfg.platforms === "object" ? cfg.platforms : {};
  return cfg;
}

/** Owner entrant id (rows without `entrant` belong to the owner). */
export const ownerEntrant = () => instance().owner_id || "owner";

export function localDate(tz, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || instance().tz || "UTC" }).format(d);
}

// ── Titles ──────────────────────────────────────────────────────────────────

/** Normalise a platform listing title for comparison: "SOME SHOW (NY)" → "some show". */
export function normTitle(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // lang-regex-ok: diacritic strip on a listing title
    .toLowerCase()
    .replace(/&/g, " and ")                              // lang-regex-ok: listing-title normalisation
    .replace(/\([^)]*\)/g, " ")                          // lang-regex-ok: drop "(NY)"-style venue tags
    .replace(/[^a-z0-9]+/g, " ")                         // lang-regex-ok: punctuation → space
    .trim()
    .replace(/^the /, "")                                // lang-regex-ok: leading article
    .replace(/\s+/g, " ");                               // lang-regex-ok: collapse whitespace
}

/**
 * Same production? Equal after normalisation, or one is a whole-word prefix of
 * the other ("Some Show" on one platform vs "Some Show: The Sequel" on our
 * list; "SIX" vs "SIX the Musical").
 */
export function sameTitle(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y + " ") || y.startsWith(x + " ");
}

/** Find the curated entry ({title, aliases?}) a listing title belongs to, or null. */
export function matchShow(listingTitle, entries) {
  for (const e of entries || []) {
    const names = [e.title, ...(e.aliases || [])];
    if (names.some((n) => sameTitle(listingTitle, n))) return e;
  }
  return null;
}

export function loadShows(file = lotteryConfig().shows_file) {
  const j = readJson(file, null);
  if (!j || !Array.isArray(j.shows)) throw new Error(`cannot read curated list ${file}`);
  return { shows: j.shows, retired: j.retired || [], raw: j };
}

// ── Dates ───────────────────────────────────────────────────────────────────

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

function to24(h, m, ampm) {
  let hh = Number(h) % 12;
  if (String(ampm).toLowerCase() === "pm") hh += 12;
  return `${pad(hh)}:${pad(Number(m || 0))}`;
}

/** "Wednesday, May 27, 2026 at 7:00PM" → {date:"2026-05-27", time:"19:00"} */
export function parseLongDate(s) {
  // lang-regex-ok: a platform's fixed performance-date stamp
  const m = String(s || "").match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})(?:\s+at\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  return { date: `${m[3]}-${pad(mon)}-${pad(m[2])}`, time: m[4] ? to24(m[4], m[5], m[6]) : null };
}

/** "ENTER NOW FOR SOME SHOW (NY) ON 05/27/26, 7:00 PM" → {date, time} */
export function parseSlashDate(s) {
  // lang-regex-ok: a platform's fixed ENTER-NOW anchor text
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:,?\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?/);
  if (!m) return null;
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
  return { date: `${yr}-${pad(m[1])}-${pad(m[2])}`, time: m[4] ? to24(m[4], m[5], m[6]) : null };
}

/** A platform's date stamp by its configured format. */
export function parseStamp(s, format) {
  return format === "slash" ? parseSlashDate(s) : parseLongDate(s);
}

/** Calendar window to test a performance against: evenings 3.5h, matinees 3.5h (2:00–5:30). */
export function showWindow(time) {
  return { time: time || "19:00", hours: 3.5 };
}

// ── Pauses ──────────────────────────────────────────────────────────────────

/**
 * pause-all file → "none" | "exempt-only" | "all" | "expired".
 * A `weekly cap` reason is the only bypassable one: the exemptions list then
 * keeps entering. Any other reason (travel, manual) stops everything.
 */
export function pauseAllMode(pauseAll, today, exemptions) {
  if (!pauseAll || !pauseAll.paused_until) return "none";
  if (pauseAll.paused_until < today) return "expired";
  const weekly = String(pauseAll.reason || "").toLowerCase().startsWith("weekly cap");
  if (weekly && (exemptions || []).length) return "exempt-only";
  return "all";
}

/** pauses file {entries:[{show, removed, paused_until}]} → {active:[titles], kept:[...], changed} */
export function activePauses(pauses, today) {
  const entries = Array.isArray(pauses?.entries) ? pauses.entries : Array.isArray(pauses) ? pauses : [];
  const kept = entries.filter((e) => e && e.paused_until && e.paused_until >= today);
  const active = kept.filter((e) => e.removed).map((e) => e.show);
  return { active, kept, changed: kept.length !== entries.length };
}

// ── Confirmation emails (form-email platforms) ──────────────────────────────

/** All http(s) URLs in a plain-text email body. */
export function urlsIn(text) {
  // lang-regex-ok: URL extraction from a machine-generated email body
  return [...String(text || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => m[0].replace(/[.,;]+$/, ""));
}

/** The "confirm your email" verify link (action=verify, a verification_code) for a given performance id, or null. */
export function verifyLink(text, perfId) {
  for (const u of urlsIn(text)) {
    let url;
    try { url = new URL(u); } catch { continue; }
    if (url.searchParams.get("action") !== "verify") continue;
    if (!url.searchParams.get("verification_code")) continue;
    const lot = url.searchParams.get("lottery");
    if (perfId == null || String(lot) === String(perfId)) return url.href;
  }
  return null;
}

/** "Quantity Requested: 2" in an entry-received template → 2 (or null). */
export function quantityRequested(text) {
  // lang-regex-ok: entry-received template field
  const m = String(text || "").match(/Quantity\s+Requested\s*:?\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

export const RECEIVED_MARKER = "lottery entry received";

/**
 * Does an entry-received subject belong to this row?
 * Subject shape: "<SHOW> <date>, <time>: <marker>".
 */
export function receivedMatches(subject, row, marker = RECEIVED_MARKER) {
  const s = String(subject || "");
  const idx = s.toLowerCase().indexOf(String(marker).toLowerCase());
  if (idx < 0) return false;
  const head = normTitle(s.slice(0, idx));
  const t = normTitle(row.show);
  if (!head.startsWith(t)) return false;
  if (!row.date) return true;
  const d = parseSlashDate(s) || parseLongDate(s);
  return !d || d.date === row.date;
}

// ── State ───────────────────────────────────────────────────────────────────

/** Duplicate-guard key: (show, performance date, platform, entrant); no entrant = the owner. */
export function entryKey(e, owner = ownerEntrant()) {
  return [normTitle(e.show), e.date || "", e.platform, e.entrant || owner].join("|");
}

/** Rows already submitted, awaiting validation, or classified permanently un-enterable — the duplicate guard. */
export function doneKeys(state, owner = ownerEntrant()) {
  const s = new Set();
  for (const e of state?.entries || []) {
    if (["submitted", "pending_validation", "failed_permanent"].includes(e.status)) s.add(entryKey(e, owner));
  }
  return s;
}
