// stop-evidence — before a location question goes out, has the user already
// told us?
//
// The case: a 14:24–15:29 stop. At 15:00 the user sent a photo of the counter
// with "Having lunch here today", Jori named the place, the user said "Yes!
// It's great" and described the dishes — and at 16:00 a card asked which of
// four shops near the stop it was. Two camera photos taken inside the
// stop (food, meal, plate) sat 8–20 m from the restaurant. None of it was read:
// the question path looked at the row, the GPS and Google, never at the chat
// or the camera.
//
// This module gathers what was SAID and SHOT during the window and lets a model
// decide whether it already names the place:
//   - the chat (the user's messages AND Jori's replies), start −10 min → end +60 min,
//     including the photos the user sent — their EXIF GPS/time make them camera fixes;
//   - photos the user took in the window (labels, OCR, ordered OCR lines, GPS, and the
//     phone's own on-device venue guess + Apple Maps POIs when the app probed it);
//   - businesses near where the user RESTED (never the visit row's centroid, which on
//     that day sat 101 m from the user), each with its distance to the rest and to
//     the nearest photo.
// The decision is Jev (site `stop-evidence`, a pick-one over the candidates)
// with a Sonnet fallback that may also spell a venue not on the list — only
// when the user's own words named it, or Jori named it and the user went along with it.
// Code owns the geometry here; every reading of language is the model's (Rule #0b).
//
// 2026-10-20: a plan stated hours before the stop ("meeting them for lunch at
// X" at 12:42 for a 13:31 stop) falls outside the window above, so the caller
// may pass `stated` (lib/stated-place.mjs): the whole day's chat and the
// calendar, read first. See evidenceVerdict.
//
// Machine judgments name the row `named`; they never write confirmed-stops.json
// (agent/ops-agent/jobs/location-confirm-ask.md § Automated guesses cannot
// self-confirm). The one exception is the user's own words read by
// stated-place on a Claude rung (`confirm: true` below), saved through the
// confirm path by the owner's decision.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { maxOnlyEnv } from "./jev-claude.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { instance } = require("./instance.cjs");
// The owner as the chat transcript names them, and as an answer's `named_by`
// records it (owner_id keeps the values earlier logs already hold).
const OWNER = instance().owner_name;
const OWNER_ID = instance().owner_id;

export const SITE = "stop-evidence";
export const CHAT_BEFORE_MIN = 10;
export const CHAT_AFTER_MIN = 60;
/** A photo the user sent is a camera fix when its GPS is this close to where the user rested. */
export const PHOTO_FIX_M = 75;
/** EXIF time may sit this far outside the window (the window's edges are fuzzy). */
export const PHOTO_TIME_PAD_MIN = 10;
/** Businesses offered: within this of the rest (or of an in-window photo). */
export const CANDIDATE_M = 60;
export const MAX_CANDIDATES = 15;
/** A legacy (Sonnet) answer must reach this to settle a stop. */
export const ACCEPT_CONFIDENCE = 0.85;
const MAX_MESSAGES = 40;

export function meters(aLat, aLon, bLat, bLon) {
  const R = 6371000, r = (x) => (x * Math.PI) / 180;
  const dLat = r(bLat - aLat), dLon = r(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// EXIF (JPEG APP1) — GPS and DateTimeOriginal. Nothing on the mini reads EXIF
// (no PIL, exifread, exiftool), and the fields needed are four tags, so this is
// a byte parser rather than a dependency. Returns null when there is no EXIF.
// ---------------------------------------------------------------------------
export function readJpegExif(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end: no APP1 before the image
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString("latin1", off + 4, off + 10) === "Exif\0\0") {
      return parseTiff(buf.subarray(off + 10, off + 2 + len));
    }
    off += 2 + len;
  }
  return null;
}

function parseTiff(t) {
  if (t.length < 8) return null;
  const le = t.toString("latin1", 0, 2) === "II";
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const readIfd = (o) => {
    const tags = {};
    if (!o || o + 2 > t.length) return tags;
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      if (e + 12 > t.length) break;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
    }
    return tags;
  };
  const valueOffset = (tag) => {
    const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 }[tag.type] || 1;
    return size * tag.count <= 4 ? tag.at : u32(tag.at);
  };
  const ascii = (tag) => {
    if (!tag) return null;
    const o = valueOffset(tag);
    if (o + tag.count > t.length) return null;
    return t.toString("latin1", o, o + tag.count).split("\0")[0] || null;
  };
  const rationals = (tag) => {
    if (!tag || tag.type !== 5) return null;
    const o = valueOffset(tag), out = [];
    for (let i = 0; i < tag.count; i++) {
      if (o + i * 8 + 8 > t.length) return null;
      const den = u32(o + i * 8 + 4);
      out.push(den ? u32(o + i * 8) / den : 0);
    }
    return out;
  };
  const ifd0 = readIfd(u32(4));
  const exif = ifd0[0x8769] ? readIfd(u32(ifd0[0x8769].at)) : {};
  const gps = ifd0[0x8825] ? readIfd(u32(ifd0[0x8825].at)) : {};
  const dms = (v) => (v && v.length === 3 ? v[0] + v[1] / 60 + v[2] / 3600 : null);
  let lat = dms(rationals(gps[2])), lon = dms(rationals(gps[4]));
  if (lat != null && ascii(gps[1]) === "S") lat = -lat;
  if (lon != null && ascii(gps[3]) === "W") lon = -lon;
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    datetime_original: ascii(exif[0x9003]) || ascii(ifd0[0x0132]),
    offset: ascii(exif[0x9011]),
  };
}

/** EXIF local "YYYY:MM:DD HH:MM:SS" (+ "+03:00" offset, else the day's tz) → ms. */
export function exifTimeMs(exif, tz) {
  const s = exif && exif.datetime_original;
  if (!s || s.length < 19) return null;
  const isoLocal = `${s.slice(0, 4)}-${s.slice(5, 7)}-${s.slice(8, 10)}T${s.slice(11, 19)}`;
  if (exif.offset && exif.offset.length >= 6) {
    const t = Date.parse(isoLocal + exif.offset.slice(0, 6));
    return Number.isFinite(t) ? t : null;
  }
  if (!tz) return null;
  // Interpret the wall time in tz: guess UTC, then correct by tz's offset at that instant.
  const guess = Date.parse(isoLocal + "Z");
  if (!Number.isFinite(guess)) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(guess)).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  const asTz = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  return guess - (asTz - guess);
}

/**
 * Is a photo the user SENT a camera fix for this stop? Its GPS must sit within
 * PHOTO_FIX_M of where the user rested, and its time (EXIF, else when the user sent it)
 * inside the window ± PHOTO_TIME_PAD_MIN.
 */
export function exifFix({ exif, sentAt, rest, start, end, tz }) {
  if (!exif || exif.lat == null || exif.lon == null || !rest) return null;
  const d = meters(rest.lat, rest.lon, exif.lat, exif.lon);
  if (d > PHOTO_FIX_M) return null;
  const taken = exifTimeMs(exif, tz);
  const t = taken ?? sentAt;
  const pad = PHOTO_TIME_PAD_MIN * 60000;
  if (t == null || t < start - pad || t > end + pad) return null;
  return { lat: exif.lat, lon: exif.lon, t, distance_m: Math.round(d), time_from: taken != null ? "exif" : "sent" };
}

/** A chat message whose content is a link to an image the user uploaded. Structure, not language. */
export function attachmentUrl(content) {
  let u;
  try { u = new URL(String(content || "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || !u.pathname.includes(`/storage/v1/object/public/${instance().attachments_bucket}/`)) return null;
  const ext = path.extname(u.pathname).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".heic"].includes(ext) ? u.toString() : null;
}

// ---------------------------------------------------------------------------
// Candidates: Google businesses near the rest (+ near any in-window photo far
// from it), plus the Apple Maps POIs the phone saw around its photos.
// ---------------------------------------------------------------------------
export function buildCandidates({ rest, google = [], photoPoints = [], applePois = [] }) {
  const out = [];
  const near = (lat, lon) => {
    const dRest = rest ? meters(rest.lat, rest.lon, lat, lon) : null;
    const dPhoto = photoPoints.length
      ? Math.min(...photoPoints.map((p) => meters(p.lat, p.lon, lat, lon))) : null;
    return { dRest, dPhoto };
  };
  const add = (c) => {
    const key = String(c.name).trim().toLowerCase();
    const dup = out.find((o) => o.key === key
      || (o.lat != null && c.lat != null && meters(o.lat, o.lon, c.lat, c.lon) <= 15 && o.source !== c.source && sameStem(o.name, c.name)));
    if (dup) { dup.sources = [...new Set([...dup.sources, c.source])]; return; }
    out.push({ ...c, key, sources: [c.source] });
  };
  for (const g of google) {
    if (!g || !g.name) continue;
    const lat = Number(g.lat), lon = Number(g.lon);
    const has = Number.isFinite(lat) && Number.isFinite(lon);
    const { dRest, dPhoto } = has ? near(lat, lon) : { dRest: g.distance_m ?? null, dPhoto: null };
    if (!(Math.min(dRest ?? Infinity, dPhoto ?? Infinity) <= CANDIDATE_M)) continue;
    add({ name: g.name, type: g.primary_type || (g.types || [])[0] || null, lat: has ? lat : null, lon: has ? lon : null,
          reviews: g.reviews ?? null, from_rest_m: dRest == null ? null : Math.round(dRest),
          from_photo_m: dPhoto == null ? null : Math.round(dPhoto), source: "google" });
  }
  for (const p of applePois) {
    if (!p || !p.name) continue;
    const lat = Number(p.lat), lon = Number(p.lon), has = Number.isFinite(lat) && Number.isFinite(lon);
    const { dRest, dPhoto } = has ? near(lat, lon) : { dRest: null, dPhoto: p.distance_m ?? null };
    if (!(Math.min(dRest ?? Infinity, dPhoto ?? Infinity) <= CANDIDATE_M)) continue;
    add({ name: p.name, type: p.category || null, lat: has ? lat : null, lon: has ? lon : null, reviews: null,
          from_rest_m: dRest == null ? null : Math.round(dRest), from_photo_m: dPhoto == null ? null : Math.round(dPhoto),
          source: "apple" });
  }
  out.sort((a, b) => Math.min(a.from_rest_m ?? 1e9, a.from_photo_m ?? 1e9) - Math.min(b.from_rest_m ?? 1e9, b.from_photo_m ?? 1e9));
  return out.slice(0, MAX_CANDIDATES).map(({ key, ...c }, i) => ({ id: `c${i}`, ...c }));
}

// Two listings of one venue from different maps ("Pinat HaShlosha" vs a long
// Hebrew SEO title) share no reliable string; only an exact match dedupes by
// name, and cross-source rows dedupe only when one name contains the other.
function sameStem(a, b) {
  const x = String(a).trim().toLowerCase(), y = String(b).trim().toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
}

/** Is there anything to read? Without a word of the user's or a photo, a pick would be a guess. */
export function hasDirectEvidence({ transcript = [], photos = [] }) {
  return transcript.some((m) => m.who === OWNER) || photos.length > 0;
}

const hhmm = (t, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));

/** The state Jev and the fallback read. Distances in metres, times local. */
export function buildState({ start, end, tz, rest, transcript, photos, candidates, minutes }) {
  return {
    window: `${hhmm(start, tz)}–${hhmm(end, tz)} (${Math.round(minutes ?? (end - start) / 60000)} min), local time`,
    where_he_rested: rest ? "a GPS rest; candidate distances are measured from it" : "no clean GPS rest; distances are from the stop's centre",
    chat: transcript.map((m) => ({
      at: hhmm(m.t, tz), who: m.who,
      ...(m.text ? { text: m.text } : {}),
      ...(m.image ? { sent_a_photo: m.image.fix
        ? `taken ${m.image.fix.distance_m} m from where the user rested, at ${hhmm(m.image.fix.t, tz)}`
        : (m.image.exif_checked ? "no usable location in the photo" : "photo") } : {}),
    })),
    photos_he_took: photos.map((p) => ({
      at: hhmm(p.t, tz),
      from_rest_m: p.from_rest_m,
      shows: (p.labels || []).slice(0, 15),
      ...(p.ocr_lines && p.ocr_lines.length ? { sign_text_lines: p.ocr_lines.slice(0, 12) }
        : p.detected_text && p.detected_text.length ? { sign_words_unordered: p.detected_text.slice(0, 30) } : {}),
      ...(p.device_venue && p.device_venue.name ? { phone_guess: {
        venue: p.device_venue.name, confidence: p.device_venue.confidence ?? null, basis: p.device_venue.basis || null } } : {}),
    })),
    places_nearby: candidates.map((c) => ({ id: c.id, name: c.name, type: c.type || null,
      from_rest_m: c.from_rest_m, from_photo_m: c.from_photo_m, listed_by: c.sources.join("+") })),
  };
}

// ---------------------------------------------------------------------------
// The decision.
// ---------------------------------------------------------------------------
const LEGACY_PROMPT = `${OWNER}'s phone recorded a stop (below, ${OWNER} is "the user"). Before Jori asks the user where it was, decide whether the chat and the user's photos ALREADY say where the user was.

Input: the stop's window, the chat around it (the user's messages, as "${OWNER}", and Jori's replies, with photos the user sent and whether each was taken where the user rested), photos the user took during it (what they show, sign text, the phone's own on-device guess), and places near where the user rested with distances.

Rules:
- Settle only on what the user SAID or SHOWED: the user's own words naming the place; Jori naming the place from the user's photo and the user going along with it (replying about it as the place, not correcting it); a sign in the user's photo spelling a business at that spot.
- A phone guess is one more witness, never enough alone.
- The place must be where the user was DURING the window — not a plan, not somewhere mentioned, not someone else.
- Prefer a listed place (give its id) when it is the same business; spell the name only if it is not listed.
- If nothing clearly says where the user was, answer null. A wrong confident name is worse than asking.

Answer with ONLY a JSON object:
{"venue": string|null, "listed_id": string|null, "named_by": "${OWNER_ID}"|"jori_accepted"|"photo_sign"|"phone_guess"|"none", "confidence": number, "basis": string}`;

// The Claude CLI: $CLAUDE_BIN, else the per-user install.
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude");

const sonnetId = () => require("./models.cjs").MODELS.sonnet;

// The house flags (lib/jev-claude.mjs): Max-only env, no MCP servers, no
// session file, and the prompt on stdin — passed as an argument with stdin left
// open, the CLI stalls 3 s ("no stdin data received") on every call.
function runClaude({ prompt, tools = "", timeoutMs, bin }) {
  const args = ["-p", "--model", sonnetId(), "--effort", "low", "--tools", tools,
    ...(tools ? ["--allowedTools", tools] : []),
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "project",
    "--no-session-persistence", "--output-format", "text"];
  return new Promise((resolve, reject) => {
    try {
      const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, cwd: os.tmpdir(), env: maxOnlyEnv() },
        (err, stdout, stderr) => {
          const ans = parseModelJson(stdout);
          if (ans) return resolve(ans);
          const why = !err ? "no JSON in the reply" : err.killed ? `timed out after ${timeoutMs} ms`
            : typeof err.code === "number" ? `exit ${err.code}` : String(err.code || err.signal || "spawn failed");
          const tail = String(stderr || stdout || "").trim().slice(-160);
          reject(new Error(`${why}${tail ? ` — ${tail}` : ""}`));
        });
      child.on("error", (e) => reject(new Error(String(e.code || e.message || e))));
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    } catch (e) { reject(new Error(String(e.message || e))); }
  });
}

function parseModelJson(out) {
  const s = String(out || ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// A call that produced no answer REJECTS; it never resolves null. null is a
// verdict ("nothing names the place") and a dead call is not one. jev-shadow
// logs a rejected shadow as shadow.error and compares nothing; on the primary
// path the rejection reaches stop-passage's "evidence step failed" branch,
// which asks the user exactly as a null did, but with the cause written down.
// 2026-10-08 13:30-13:33Z: six calls died in ~4 s, were logged as "null" and
// paged as six Jev disagreements; replayed, the same states named the same two
// venues Jev had (0.93, ~9 s).
export function askSonnet(state, { timeoutMs = 90000, bin = CLAUDE_BIN } = {}) {
  const prompt = `${LEGACY_PROMPT}\n\nInput:\n${JSON.stringify(state, null, 1)}`;
  return runClaude({ prompt, timeoutMs, bin }).catch((e) => { throw new Error(`sonnet fallback: ${e.message}`); });
}

/**
 * Map a fallback answer to a settled venue, or null. It settles only at
 * ACCEPT_CONFIDENCE and only when the name is grounded: a listed place, or a
 * name HE gave / Jori gave and the user accepted. A phone guess alone never settles.
 */
export function acceptLegacy(ans, candidates) {
  if (!ans || !ans.venue || typeof ans.confidence !== "number" || ans.confidence < ACCEPT_CONFIDENCE) return null;
  const listed = ans.listed_id ? candidates.find((c) => c.id === ans.listed_id) : null;
  if (ans.named_by === "phone_guess" || ans.named_by === "none") return null;
  if (!listed && ![OWNER_ID, "jori_accepted"].includes(ans.named_by)) return null;
  return { name: listed ? listed.name : String(ans.venue).trim(), listed: !!listed, confidence: ans.confidence,
           named_by: ans.named_by, basis: String(ans.basis || "").slice(0, 300), by: "sonnet" };
}

/** Jev answers → a venue value (pick-one over candidates + none + unlisted). */
export function interpretJev(answers, candidates, answerConfidence) {
  const a = answers && answers.venue;
  const pick = a && a.choice;
  if (!pick || pick === "unlisted") return { value: null, confidence: 0 }; // needs a speller → fallback
  const conf = answerConfidence(a);
  if (pick === "none") return { value: { name: null, confidence: conf, by: "jev" }, confidence: conf };
  const c = candidates.find((x) => x.id === pick);
  if (!c) return { value: null, confidence: 0 };
  return { value: { name: c.name, listed: true, confidence: conf, by: "jev", basis: `jev picked ${c.name} (${c.from_rest_m ?? "?"} m from the rest)` }, confidence: conf };
}

/**
 * Decide. Returns {name, confidence, by, basis, ...} when the evidence names the
 * place, or null (ask the user as before).
 */
export async function decideVenue({ state, candidates, id = null, decideImpl = null, legacyImpl = null }) {
  const legacy = async () => acceptLegacy(await (legacyImpl || askSonnet)(state), candidates);
  const { decide } = decideImpl ? { decide: decideImpl } : await import("./jev-shadow.mjs");
  const jevMod = decideImpl ? null : await import("./jev.mjs");
  const answerConfidence = jevMod ? jevMod.answerConfidence : (a) => (a && a.confidence) || 0;
  const tpl = jevMod ? jevMod.jevSiteDef(SITE)?.venue_template : { instructions: "", fixed_criteria: {} };
  if (!tpl) return legacy();
  const criteria = {};
  for (const c of candidates) criteria[c.id] = `${c.name}${c.type ? ` (${String(c.type).split("_").join(" ")})` : ""}`;
  Object.assign(criteria, tpl.fixed_criteria);
  const { value } = await decide({
    site: SITE, id, state,
    privacyScreen: true,
    questions: { venue: { type: "choice", instructions: tpl.instructions, criteria } },
    interpret: (answers) => interpretJev(answers, candidates, answerConfidence),
    legacy,
    same: (a, b) => (a && a.name ? a.name : null) === (b && b.name ? b.name : null),
  });
  return value && value.name ? value : null;
}

// ---------------------------------------------------------------------------
// Gathering. `sb(pathQs)` is the caller's Supabase REST GET.
// ---------------------------------------------------------------------------
const PHOTO_COLS_BASE = "uuid,taken_at,latitude,longitude,self_captured,labels,detected_text,media_type,original_filename,thumb_url";

/** Photos in [from,to]; the phone-probe columns when the table has them. */
export async function photosBetween(sb, from, to) {
  const qs = (cols) => `photos?taken_at=gte.${encodeURIComponent(new Date(from).toISOString())}`
    + `&taken_at=lte.${encodeURIComponent(new Date(to).toISOString())}&in_trash=is.false`
    + `&select=${cols}&order=taken_at.asc&limit=200`;
  try { return await sb(qs(`${PHOTO_COLS_BASE},ocr_lines,device_venue`)); }
  catch { try { return await sb(qs(PHOTO_COLS_BASE)); } catch { return []; } }
}

async function fetchExif(url, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    // EXIF sits in the first segment; 256 KB covers APP1 with room to spare.
    const buf = Buffer.from(await r.arrayBuffer());
    return readJpegExif(buf.subarray(0, Math.min(buf.length, 256 * 1024)));
  } catch { return null; }
}

/**
 * Everything said and shot around the stop.
 * @returns {{rest, transcript, photos, candidates, photoFixes}}
 */
export async function gatherEvidence({ sb, start, end, tz, rest, fallback, near, fetchImpl, asOf = null }) {
  const anchor = rest || fallback;
  // asOf (audit): only what had been said by the time the question went out —
  // the user's answer TO the question is not evidence it was needless.
  const from = start - CHAT_BEFORE_MIN * 60000, to = Math.min(end + CHAT_AFTER_MIN * 60000, asOf ?? Infinity);
  const q = encodeURIComponent;
  let msgs = [];
  try {
    msgs = await sb(`jori_messages?channel=eq.chat&created_at=gte.${q(new Date(from).toISOString())}`
      + `&created_at=lte.${q(new Date(to).toISOString())}&select=role,content,created_at&order=created_at.asc&limit=${MAX_MESSAGES}`);
  } catch {}
  const transcript = [];
  for (const m of msgs) {
    const t = Date.parse(m.created_at);
    const who = m.role === "user" ? OWNER : "Jori";
    const url = m.role === "user" ? attachmentUrl(m.content) : null;
    if (url) {
      const exif = await fetchExif(url, fetchImpl);
      const fix = exifFix({ exif, sentAt: t, rest: anchor, start, end, tz });
      transcript.push({ t, who, image: { url, exif_checked: true, fix } });
    } else {
      transcript.push({ t, who, text: String(m.content || "").slice(0, 600) });
    }
  }
  const rows = await photosBetween(sb, start - PHOTO_TIME_PAD_MIN * 60000, end + PHOTO_TIME_PAD_MIN * 60000);
  const photos = rows.filter((p) => p.self_captured !== false && (p.media_type || "photo") !== "video")
    .map((p) => {
      const lat = Number(p.latitude), lon = Number(p.longitude), has = Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon);
      return { uuid: p.uuid, t: Date.parse(p.taken_at), lat: has ? lat : null, lon: has ? lon : null,
        from_rest_m: has && anchor ? Math.round(meters(anchor.lat, anchor.lon, lat, lon)) : null,
        labels: p.labels || [], detected_text: p.detected_text || [], ocr_lines: p.ocr_lines || null,
        device_venue: p.device_venue || null, file: p.original_filename || null, thumb_url: p.thumb_url || null };
    })
    // A photo taken far from where the user rested is not evidence about THIS place.
    .filter((p) => p.from_rest_m == null || p.from_rest_m <= PHOTO_FIX_M);
  const photoFixes = [
    ...photos.filter((p) => p.lat != null).map((p) => ({ lat: p.lat, lon: p.lon })),
    ...transcript.filter((m) => m.image && m.image.fix).map((m) => ({ lat: m.image.fix.lat, lon: m.image.fix.lon })),
  ];
  let google = [];
  if (anchor && near) {
    google = near(anchor.lat, anchor.lon, CANDIDATE_M) || [];
    // A photo well away from the rest gets its own neighbourhood (at most two).
    const extra = photoFixes.filter((p) => meters(anchor.lat, anchor.lon, p.lat, p.lon) > 30).slice(0, 2);
    for (const p of extra) google = google.concat(near(p.lat, p.lon, 40) || []);
  }
  const applePois = [];
  for (const p of photos) {
    for (const poi of (p.device_venue && p.device_venue.pois) || []) {
      // The phone reports POI distance from the PHOTO; without coordinates it
      // counts as near when that photo is near the rest.
      applePois.push({ name: poi.name, category: poi.category || null, lat: poi.lat ?? null, lon: poi.lon ?? null,
        distance_m: poi.distance_m != null && p.from_rest_m != null ? poi.distance_m + p.from_rest_m : poi.distance_m ?? null });
    }
  }
  const candidates = buildCandidates({ rest: anchor, google, photoPoints: photoFixes, applePois });
  return { rest: anchor, transcript, photos, candidates, photoFixes };
}

// ---------------------------------------------------------------------------
// Looking at the pictures. Tags, OCR and the phone's guess are all summaries
// of the image, and each can fail: on 2026-10-08 the phone read a Hebrew menu
// as Latin junk and its on-device model named the wrong shop, while the chat
// model — shown the photo itself — said "Pinat HaShlosha, the display case is
// full of skewers". When nothing else settles the stop, the images (the
// phone-probe thumbnails and photos the user sent in chat) go to Sonnet, which may
// only PICK a listed place: what it sees must match a business that is there.
// ---------------------------------------------------------------------------
export const MAX_IMAGES = 4;
const LOOK_PROMPT = `${OWNER}'s phone recorded a stop. Below are the facts around it, and the image files of photos ${OWNER} took or sent during it. Use the Read tool to look at each image file.

Which of the listed places_nearby was ${OWNER} at? Decide from what the photos SHOW — the food, the counter, the signage, the interior — matched against each place's name and type. The chat is context.

Rules:
- Answer only with a listed place's id. Never a place that is not listed.
- If the photos could fit more than one listed place, or none, answer null. A wrong confident name is worse than asking.

Answer with ONLY a JSON object:
{"listed_id": string|null, "confidence": number, "basis": string}`;

/** Local files for the images worth showing: the user's in-window photos nearest the rest, then photos the user sent. */
export async function fetchImages({ photos = [], transcript = [], dir, fetchImpl = fetch, max = MAX_IMAGES }) {
  const urls = [
    ...photos.filter((p) => p.thumb_url).sort((a, b) => (a.from_rest_m ?? 999) - (b.from_rest_m ?? 999)).map((p) => p.thumb_url),
    ...transcript.filter((m) => m.image).map((m) => m.image.url),
  ].filter((u, i, a) => u && a.indexOf(u) === i).slice(0, max);
  const files = [];
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, url] of urls.entries()) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const f = path.join(dir, `img${i}.jpg`);
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      files.push(f);
    } catch {}
  }
  return files;
}

export function askSonnetLooking(state, files, { timeoutMs = 150000, bin = CLAUDE_BIN } = {}) {
  const prompt = `${LOOK_PROMPT}\n\nImage files:\n${files.join("\n")}\n\nFacts:\n${JSON.stringify(state, null, 1)}`;
  return runClaude({ prompt, tools: "Read", timeoutMs, bin }).catch((e) => { throw new Error(`sonnet look: ${e.message}`); });
}

/** A look answer settles only as a listed place at ACCEPT_CONFIDENCE. */
export function acceptLook(ans, candidates) {
  if (!ans || !ans.listed_id || typeof ans.confidence !== "number" || ans.confidence < ACCEPT_CONFIDENCE) return null;
  const c = candidates.find((x) => x.id === ans.listed_id);
  if (!c) return null;
  return { name: c.name, listed: true, confidence: ans.confidence, named_by: "photo_seen", by: "sonnet-look",
           basis: `seen in the user's photos: ${String(ans.basis || "").slice(0, 240)} (${c.from_rest_m ?? "?"} m from the rest)` };
}

/**
 * One call: gather, then decide. Returns {settled, venue, reason, evidence_summary}.
 *
 * `stated` (lib/stated-place.mjs statedPlace, passed by stop-passage)
 * runs first, over the whole day's chat and the calendar around the stop —
 * what the user said BEFORE the stop ("meeting them for lunch at X") sits outside
 * this module's −10 min window. A settled answer from the user's own words, read by a
 * Claude rung, comes back with `confirm: true`: the caller saves it through
 * the confirm path, the same write as the user's answer to the card. One from the
 * calendar alone, or from the on-device rung, is named like the rest of this step. `calendar` is the events around the window.
 */
export async function evidenceVerdict({ sb, start, end, tz, rest, fallback, near, id, decideImpl, legacyImpl, lookImpl = null, fetchImpl, asOf = null,
  stated = null, calendar = [] }) {
  const ev = await gatherEvidence({ sb, start, end, tz, rest, fallback, near, fetchImpl, asOf });
  const summary = {
    his_messages: ev.transcript.filter((m) => m.who === OWNER).length,
    photos_sent: ev.transcript.filter((m) => m.image).length,
    photos_sent_as_fixes: ev.transcript.filter((m) => m.image && m.image.fix).length,
    photos_taken: ev.photos.length,
    candidates: ev.candidates.length,
  };
  if (stated) {
    try {
      const places = ev.candidates.map((c) => ({ id: c.id, name: c.name, type: c.type || null, from_m: c.from_rest_m ?? c.from_photo_m ?? null }));
      const st = await stated({ sb, start, end, tz, places, calendar, asOf, id });
      summary.stated = { settled: !!st.settled, tier: st.tier || null, reason: st.reason,
        his_messages_today: st.summary ? st.summary.his_messages ?? null : null, cached: !!st.cached,
        ...(st.attempts ? { attempts: st.attempts } : {}) };
      if (st.settled && st.venue) {
        const v = st.venue;
        const said = v.source === "chat" ? `the user said "${v.quote}"${v.said_at ? ` at ${hhmm(v.said_at, tz)}` : ""}` : `the user's calendar: "${v.quote}"`;
        // A confirmation needs the user's words AND a Claude rung; the 1B rung only names.
        return { settled: true, confirm: v.source === "chat" && v.durable !== false, summary, reason: `${said}${v.basis ? ` — ${v.basis}` : ""}`,
          venue: { name: v.name, listed: v.listed, confidence: v.confidence, named_by: v.source === "chat" ? `${OWNER_ID}_stated` : "calendar_stated",
            by: `stated-${st.tier}`, basis: said, quote: v.quote, said_at: v.said_at, plan: v.plan } };
      }
    } catch (e) {
      summary.stated = { error: String(e.message || e).slice(0, 160) };
    }
  }
  if (!hasDirectEvidence(ev)) return { settled: false, reason: "nothing said or shot during the stop", summary };
  const state = buildState({ start, end, tz, rest: rest || null, transcript: ev.transcript, photos: ev.photos, candidates: ev.candidates });
  let venue = await decideVenue({ state, candidates: ev.candidates, id, decideImpl, legacyImpl });
  if (!venue && ev.candidates.length && lookImpl !== false) {
    const dir = path.join(os.tmpdir(), "stop-evidence", String(id || Date.now()));
    try {
      const files = await fetchImages({ photos: ev.photos, transcript: ev.transcript, dir, fetchImpl: fetchImpl || fetch });
      summary.images_looked_at = files.length;
      if (files.length) venue = acceptLook(await (lookImpl || askSonnetLooking)(state, files), ev.candidates);
    } catch (e) {
      summary.look_error = String(e.message || e).slice(0, 200);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  if (!venue) return { settled: false, reason: "the chat and photos don't say where the user was", summary };
  return { settled: true, venue, reason: venue.basis || `${venue.by} named ${venue.name}`, summary };
}
