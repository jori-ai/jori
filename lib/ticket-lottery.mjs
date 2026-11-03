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
 *   files          {state, pause_all, pauses, exemptions, guest, profile, error_classes, tickets}
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
 *   confirmations  {senders: [<address or domain>], query: <Gmail query>, lookback_days}
 *                  — where the user's ticket orders, lottery wins and post-show
 *                  surveys come from. `senders` is who an installation's mail
 *                  intake starts `ticket-shows scan` for; the scan reads `query`
 *                  (default: from any of `senders`) and keeps the curated list
 *                  honest (§ Tickets below). Neither: the scan is off.
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
  confirmations: null,
};

const FILE_DEFAULTS = {
  state: "data/ticket-lottery-state.json",
  pause_all: "data/ticket-lottery-all-paused.json",
  pauses: "data/ticket-lottery-pauses.json",
  exemptions: "data/ticket-lottery-exemptions.json",
  guest: "data/ticket-lottery-guest-mode.json",
  profile: "data/lottery-profile.json",
  error_classes: "data/ticket-lottery-error-classes.json",
  tickets: "data/ticket-lottery-tickets.json",
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

// ── Tickets: what the user bought, saw, or only won ────────────────────────
//
// A show the user has tickets for, or has already seen, leaves the curated list
// by itself, not when someone remembers to retire it. Each piece of evidence is
// a ticket record {show, kind, date, message_id, source}; what a record does to
// the list is decided here, in code:
//
//   attended          a post-show survey, or anything saying the user was there  → retire now
//   purchase          tickets the user paid for outright                          → retire now
//   lottery_purchase  lottery tickets the user won AND paid for or claimed        → retire now
//   won               a win notice on its own                                     → nothing: a win
//                     that was never paid for is not a show the user saw, and
//                     wins lapse unclaimed often enough for that to matter
//   none              anything else
//
// Which kind an email is, which show and which performance date are a model's
// reading (bin/ticket-shows scan, or an email-triage turn through `ticket-shows
// booked`); this section only applies the answer and checks that the answer is
// grounded in the email (mentionsTitle, quoted). The records live in the
// `files.tickets` ledger {seen:{<message id>:{at, kind}}, retries:{<message id>: n}, records:[…], last_scan}.

export const TICKET_KINDS = ["purchase", "lottery_purchase", "attended", "won", "none"];

/** What a record does to the list: "retire" | "none". Pure — tested. */
export function ticketAction(rec) {
  const kind = rec?.kind;
  return kind === "attended" || kind === "purchase" || kind === "lottery_purchase" ? "retire" : "none";
}

/** The one entry of `entries` that is `title`: a single sameTitle hit, else the single exact one, else null. */
export function findTitle(entries, title, key = "title") {
  const hits = (entries || []).filter((e) => e && sameTitle(e[key], title));
  if (hits.length <= 1) return hits[0] || null;
  const exact = hits.filter((e) => normTitle(e[key]) === normTitle(title));
  return exact.length === 1 ? exact[0] : null;
}

/** Move `title` from list.shows to list.retired. → the retired entry, or null when it is not on the active list. */
export function retireIn(list, title, reason, date) {
  list.shows ||= []; list.retired ||= [];
  const s = findTitle(list.shows, title);
  if (!s) return null;
  list.shows = list.shows.filter((e) => e !== s);
  const entry = { title: s.title, reason, date };
  list.retired.push(entry);
  return entry;
}

/** The pauses file without `title`'s entries (a retirement supersedes a pause). → {pauses, changed}. */
export function dropPauses(pauses, title) {
  const entries = Array.isArray(pauses?.entries) ? pauses.entries : [];
  const kept = entries.filter((e) => !(e && sameTitle(e.show, title)));
  return { pauses: { ...(pauses || {}), entries: kept }, changed: kept.length !== entries.length };
}

const plainObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

export function loadLedger(file) {
  const j = readJson(file, null) || {};
  return {
    seen: plainObject(j.seen),
    retries: plainObject(j.retries),
    records: Array.isArray(j.records) ? j.records : [],
    last_scan: j.last_scan || null,
  };
}

/**
 * The three files a ticket record touches — curated list, per-show pauses,
 * ledger — read once, changed in memory, written by save() (only what changed).
 * Paths come from the config, so tests point them anywhere.
 */
export function openStore(cfg = lotteryConfig()) {
  const store = {
    cfg,
    list: readJson(cfg.shows_file, null),
    pauses: readJson(cfg.files.pauses, null),
    ledger: loadLedger(cfg.files.tickets),
    dirty: new Set(),
    save() {
      if (store.dirty.has("list") && store.list) writeJson(cfg.shows_file, store.list);
      if (store.dirty.has("pauses")) writeJson(cfg.files.pauses, store.pauses);
      if (store.dirty.has("ledger")) writeJson(cfg.files.tickets, store.ledger);
      store.dirty.clear();
    },
  };
  return store;
}

function retireReason(rec) {
  const on = rec.date ? ` for ${rec.date}` : "";
  const via = rec.source ? ` (${rec.source})` : "";
  if (rec.kind === "attended") return `attended${rec.date ? ` ${rec.date}` : ""}${via}`;
  if (rec.kind === "lottery_purchase") return `won + bought tickets${on}${via}`;
  return `bought tickets${on}${via}`;
}

/**
 * Record one piece of ticket evidence in `store` and apply it (store.save()
 * writes it). Idempotent: the same message id, or for a record with no message
 * the same show + kind + date, is a "duplicate".
 *
 * → {result, title, detail}; result ∈ retired | noted | already-retired |
 *   not-listed | duplicate | no-list
 */
export function recordTicket(store, rec, today) {
  if (!store.list || !Array.isArray(store.list.shows)) return { result: "no-list", title: rec.show, detail: "no curated list" };
  const L = store.ledger;
  const dup = L.records.find((r) => rec.message_id ? r.message_id === rec.message_id && sameTitle(r.show, rec.show)
    : !r.message_id && sameTitle(r.show, rec.show) && r.kind === rec.kind && (r.date || null) === (rec.date || null));
  if (dup) return { result: "duplicate", title: dup.show, detail: `already recorded ${dup.recorded}` };

  const active = findTitle(store.list.shows, rec.show);
  const title = active?.title || findTitle(store.list.retired, rec.show)?.title || rec.show;
  const action = ticketAction(rec);
  let result, detail;
  if (!active) {
    result = findTitle(store.list.retired, rec.show) ? "already-retired" : "not-listed";
    detail = result === "already-retired" ? "already retired" : "not on the curated list";
  } else if (action === "retire") {
    const reason = retireReason(rec);
    retireIn(store.list, title, reason, today);
    store.dirty.add("list");
    const dp = dropPauses(store.pauses, title);
    if (dp.changed) { store.pauses = dp.pauses; store.dirty.add("pauses"); }
    result = "retired"; detail = reason;
  } else {
    result = "noted"; detail = rec.kind === "won" ? "a win alone changes nothing until the tickets are paid for" : "nothing to change";
  }
  L.records.push({
    show: title, kind: rec.kind, date: rec.date || null, message_id: rec.message_id || null,
    source: rec.source || null, ...(rec.evidence ? { evidence: String(rec.evidence).slice(0, 200) } : {}),
    recorded: today, result,
  });
  store.dirty.add("ledger");
  return { result, title, detail };
}

// ── Reading the user's ticket mail (bin/ticket-shows scan) ─────────────────
//
// A tool-less model call reads a batch of emails from the configured senders
// and says, per email, which kind it is, which listed show and which performance
// date (Rule #0b: what an email means is a model's reading). Code then refuses
// any answer it cannot ground: the show must be one of the listed titles and
// named in that email, and the evidence must be a phrase copied from it.

/** Does `haystack` (an email's subject + text) name `title`? A grounding check on a model's answer, not a reading. */
export function mentionsTitle(haystack, title) {
  const t = normTitle(title);
  return !!t && ` ${normTitle(haystack)} `.includes(` ${t} `);
}

// Curly quotes and long dashes count as their plain forms: a model copying "you’ve" often writes "you've".
const PLAIN = { "\u2018": "'", "\u2019": "'", "\u201b": "'", "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u2013": "-", "\u2014": "-" };
// lang-regex-ok: whitespace squash for a verbatim-quote check of a model's evidence against a machine-generated email
const squash = (s) => [...String(s || "").toLowerCase()].map((c) => PLAIN[c] ?? c).join("").split(/\s+/).filter(Boolean).join(" ");

const ENTITIES = { "&amp;": "&", "&nbsp;": " ", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&rsquo;": "\u2019", "&lsquo;": "\u2018", "&rdquo;": "\u201d", "&ldquo;": "\u201c", "&ndash;": "\u2013", "&mdash;": "\u2014", "&lt;": "<", "&gt;": ">" };

/** An email's text as the model and the grounding check both see it: entities decoded, whitespace collapsed, clipped. */
export function clipText(s, max = 1500) {
  // lang-regex-ok: HTML entity decoding and whitespace collapse of a machine-generated email body
  const t = String(s || "").replace(/&[a-z]+;|&#39;/g, (e) => ENTITIES[e] ?? e).split(/\s+/).filter(Boolean).join(" ");
  return t.length > max ? `${t.slice(0, max)} …` : t;
}

/** Is `quote` copied from `haystack` (case- and whitespace-insensitive)? */
export function quoted(haystack, quote) {
  const q = squash(quote);
  return q.length >= 3 && squash(haystack).includes(q);
}

/** A YYYY-MM-DD within a year of `today`, else null. */
export function performanceDate(s, today) {
  // lang-regex-ok: shape check on a date the model was asked to write as YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return null;
  const t = Date.parse(`${s}T12:00:00Z`), now = Date.parse(`${today}T12:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(now) || Math.abs(t - now) > 400 * 86400_000) return null;
  return s;
}

export const SCAN_SYSTEM = `You read emails that theater ticket sellers and ticket lotteries sent to one account holder ("the user"), and say what each email shows about the user and one show on the user's list.

kind — exactly one of:
- "purchase": the user paid for tickets outright — an order confirmation, a receipt, or the tickets themselves being delivered — and nothing says they were won in a lottery.
- "lottery_purchase": the user paid for or claimed tickets they WON in a lottery (the lottery's own purchase or payment confirmation).
- "attended": the user has been to a performance, e.g. a post-show survey ("What did you think of …?", "How was …?").
- "won": a lottery-win notice that does not show the tickets were paid for or claimed.
- "none": anything else — an entry received, a loss, "try again", standby, results that are not a win, marketing and newsletters, account and security mail, reminders or venue policies with no purchase in them, or a show that is not on the list.

show: the list title the email is about, written exactly as it appears in the list, or "none".
performance_date: the performance date as YYYY-MM-DD when the email states one, else "".
evidence: a short phrase (3 to 15 words) copied exactly from the email's subject or text that shows the kind; "" for "none".

Give one item for every email id you are given. Judge each email on its own.`;

/** The structured-output schema for one batch, the show enum being the listed titles. */
export function scanSchema(titles) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "show", "performance_date", "evidence"],
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: TICKET_KINDS },
            show: { type: "string", enum: [...titles, "none"] },
            performance_date: { type: "string" },
            evidence: { type: "string" },
          },
        },
      },
    },
  };
}

/** The per-call data: today, the list, and the emails ({id, from, date, subject, text}). */
export function scanPrompt(batch, titles, today) {
  return JSON.stringify({ today, list: titles, emails: batch.map(({ id, from, date, subject, text }) => ({ id, from, date, subject, text })) });
}

/**
 * Check a model's answer for one batch. → {ok:[{id, kind, show, date, evidence}], bad:[id]}
 * Ids the model skipped are in neither (they are read again next run).
 */
export function validateScan(answer, batch, titles, today) {
  const byId = new Map(batch.map((m) => [m.id, m]));
  const ok = [], bad = [], done = new Set();
  for (const it of Array.isArray(answer?.items) ? answer.items : []) {
    const m = byId.get(it?.id);
    if (!m || done.has(m.id)) continue;
    done.add(m.id);
    if (!TICKET_KINDS.includes(it.kind)) { bad.push(m.id); continue; }
    if (it.kind === "none") { ok.push({ id: m.id, kind: "none", show: null, date: null }); continue; }
    const hay = `${m.subject || ""}\n${m.text || ""}`;
    const show = titles.includes(it.show) ? it.show : null;
    if (!show || !mentionsTitle(hay, show) || !quoted(hay, it.evidence)) { bad.push(m.id); continue; }
    ok.push({ id: m.id, kind: it.kind, show, date: performanceDate(it.performance_date, today), evidence: String(it.evidence).trim().slice(0, 200) });
  }
  return { ok, bad };
}

/** Forget judged message ids older than `days` (the scan never looks back that far). */
export function pruneSeen(ledger, today, days = 120) {
  const cut = new Date(Date.parse(`${today}T12:00:00Z`) - days * 86400_000).toISOString().slice(0, 10);
  for (const [id, v] of Object.entries(ledger.seen)) if (String(v?.at || "") < cut) delete ledger.seen[id];
}
