// address-match.mjs — is this stop one of the user's homes, judged by its street address?
//
// A geocoder may name a home's street in English while the user's records name
// it in the local language (or transliterated), with a different house number
// for the same building: address matching must be translation- and
// transliteration-aware, and a few doors off on the same street is the same
// home. A model does the name match (Rule #0b), not a regex.
//
// Code owns the geometry: which homes a stop could be at all
// (named-locations.js addressCandidates: within ADDRESS_NEAR_M of a home's
// recorded spot, or an address-only home in the stop's timezone). A model owns
// the language: whether the geocoders' addresses for the stop and the home's
// address name the same house, across Hebrew, English and transliteration, a
// dropped or translated "Simta"/"Alley", and a house number a few doors off.
//
// The model is Jev first (site `named-location-address`, a pick-one over the
// candidate homes + none), then Sonnet, then Opus, climbing only when a tier's
// answer is not one of the allowed ids. No local tier: gemma3:1b would answer
// in the right shape and could not read סמטת התמר, and a wrong "same home" puts
// his parents' name on a stranger's door. Jev is the cheap rung.
//
// Each question is asked once. The answer is kept in
// data/.cache/named-location-address-verdicts.json, keyed by everything
// the model saw (the stop's addresses, the candidate homes, the question file),
// so a re-resolved day costs nothing and a new home nearby, a new geocoder label
// or an edited question is asked afresh. Only a real answer is kept: a call that
// fails is asked again next time, and until then the stop is not named by
// address. Never a guess in place of the model.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { loadAddressHomes, addressCandidates } = require(path.join(HERE, "named-locations.js"));
const { timezoneForCoords } = require(path.join(HERE, "geo-timezone.js"));

export const JEV_SITE = "named-location-address";
export const VERDICT_FILE = process.env.JORI_ADDRESS_VERDICTS_FILE
  || path.join(HERE, "..", "data", ".cache", "named-location-address-verdicts.json");
const QUESTION_FILE = path.join(HERE, "..", "data", "jev-questions", `${JEV_SITE}.json`);
const VERDICT_TTL_MS = 90 * 24 * 3600 * 1000;
const REVERSE_TTL_MS = 30 * 24 * 3600 * 1000;

// The prompt the Claude tiers get. Jev's wording lives in the question file.
export const SYSTEM_PROMPT = `You decide whether a place the user stopped at is one of their known homes, from addresses only.

"stop_addresses" are what map geocoders call the spot where the user stopped: street addresses in English or another language, sometimes transliterated, and often with a different house number for the same building, because each geocoder snaps to a different address point. "homes" are the addresses of homes the user knows, each with an id.

Answer with a home's id only when a stop address names the SAME STREET as that home's address, in the same town when both name a town, and its house number (if it has one) is the home's own number or within a few doors of it. The same street across languages and transliterations counts: a name in the local script, its transliteration and its translation are one street name, and the local word for "alley" or "lane" and its English translation are the same kind of street; a geocoder may drop, keep or translate that word. A street of the same name in a different town, a different street, or a house number far along the street is "none". If unsure, answer "none".

Reply with JSON only: {"home": "<id or none>", "reason": "<one short sentence>"}`;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}

function writeJsonAtomic(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  } catch {}
}

function questionText() {
  try { return fs.readFileSync(QUESTION_FILE, "utf8"); } catch { return ""; }
}

// The key is what the model was shown, nothing else: two stops with the same
// geocoder addresses near the same homes are one question.
export function verdictKey(state) {
  return createHash("sha256").update(JSON.stringify([SYSTEM_PROMPT, questionText(), state])).digest("hex");
}

// ---------------------------------------------------------------------------
// The stop's full geocoded address, town included. The iOS label ("12 Example
// Lane") carries no town, which is fine next to a home 200 m away and not
// enough for an address-only home, where the town is the only bound left.
// Nominatim's display_name is machine-generated, in the local language.
// Cached per ~11 m cell for REVERSE_TTL_MS in the verdict file.
// ---------------------------------------------------------------------------
async function nominatimFullAddress(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=18&addressdetails=0`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": "jori-address-match/1.0" }, signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.display_name === "string" && j.display_name.trim() ? j.display_name.trim() : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function fullAddressFor(lat, lon, { file, reverse }) {
  const cell = `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
  const store = readJson(file);
  const hit = store.reverse && store.reverse[cell];
  if (hit && hit.address && Date.now() - Date.parse(hit.at) < REVERSE_TTL_MS) return hit.address;
  const address = await (reverse || nominatimFullAddress)(lat, lon);
  if (address) {
    const fresh = readJson(file);
    fresh.reverse = { ...(fresh.reverse || {}), [cell]: { address, at: new Date().toISOString() } };
    writeJsonAtomic(file, fresh);
  }
  return address;
}

// ---------------------------------------------------------------------------
// The model. Jev picks; Sonnet, then Opus, when Jev is unsure or unavailable.
// ---------------------------------------------------------------------------
function allowedIds(state) { return new Set([...state.homes.map(h => h.id), "none"]); }

// No Claude login in this run (trigger-live-day.sh sets it inline from cron, or
// after a failed Max check; photo-place-name.js reads the same flag). Jev still
// answers; only the Claude tiers are skipped, so no fork prints "Not logged in".
const NO_CLAUDE_ENV = "JORI_PHOTO_TEXT_NO_CLAUDE";

async function askClaudeLadder(state) {
  if (process.env[NO_CLAUDE_ENV]) throw new Error(`address-match: Claude tiers skipped: ${process.env[NO_CLAUDE_ENV]}`);
  const { runToollessDetailed, parseModelJson } = await import("./jev-claude.mjs");
  const { MODELS } = require(path.join(HERE, "models.cjs"));
  const ok = allowedIds(state);
  const prompt = `${SYSTEM_PROMPT}\n\nInput:\n${JSON.stringify(state, null, 1)}`;
  const tried = [];
  for (const [tier, model] of [["sonnet", MODELS.sonnet], ["opus", MODELS.opus]]) {
    const { out, error } = await runToollessDetailed({ model, prompt, timeoutMs: 90000 });
    // No login, a timeout, a crash: the next tier would fail the same way.
    if (error) throw new Error(`address-match ${tier}: ${error.kind}: ${error.message}`);
    const j = parseModelJson(out);
    if (j && typeof j.home === "string" && ok.has(j.home)) {
      return { home: j.home, reason: typeof j.reason === "string" ? j.reason.slice(0, 200) : null, tier };
    }
    tried.push(tier);
  }
  throw new Error(`address-match: no tier answered with an allowed id (${tried.join(", ")})`);
}

export async function askSameHome(state, { id = null } = {}) {
  const { decide } = await import("./jev-shadow.mjs");
  const { answerConfidence, jevSiteDef } = await import("./jev.mjs");
  const def = jevSiteDef(JEV_SITE) || {};
  const tpl = def.home_template;
  let memo = null;
  const legacy = () => (memo ||= askClaudeLadder(state));
  if (!tpl) return legacy();
  const criteria = {};
  for (const h of state.homes) criteria[h.id] = `the stop is at the home whose address is ${h.address}`.slice(0, 300);
  Object.assign(criteria, tpl.fixed_criteria || {});
  const { value } = await decide({
    site: JEV_SITE,
    id,
    state,
    questions: { home: { type: "choice", instructions: tpl.instructions, criteria } },
    interpret: (answers) => {
      const a = answers.home;
      const pick = a && a.choice;
      if (!pick || !allowedIds(state).has(pick)) return { value: null, confidence: 0 };
      return { value: { home: pick, reason: "jev" }, confidence: answerConfidence(a) };
    },
    legacy,
    alwaysShadow: !!(def.shadow_until && Date.now() < Date.parse(def.shadow_until)),
    same: (j, l) => (j && j.home) === (l && l.home),
  });
  // While the shadow runs, Claude can veto a Jev pick: the costly mistake here
  // is naming a stranger's door after his family, so the two must agree before
  // a home is named (the outbound-precheck rule, where a Sonnet suppress beats a
  // Jev send). A failed shadow leaves Jev's answer.
  if (memo && value && value.home !== "none") {
    const shadow = await memo.catch(() => null);
    if (shadow && shadow.home !== value.home) return { home: "none", reason: `claude disagreed: ${shadow.reason || shadow.home}` };
  }
  return value;
}

/**
 * Which home, if any, a stop is at by its address.
 *
 * @param stop  {lat, lon, labels: [geocoder strings already held for the stop]}
 * @param opts  entries   address-bearing named locations (default: the file)
 *              tz        the stop's timezone (default: looked up from lat/lon)
 *              file      verdict store (default VERDICT_FILE)
 *              ask       (state) => {home, reason} — the model; injectable for tests
 *              reverse   (lat, lon) => full address | null; injectable for tests
 *              allowAsk  false = read remembered answers only, never call a model
 *              onAsk     () => void, called before each fresh model call (a caller's budget)
 * @returns {entry, distance_m, verdict, cached} or null
 */
export async function matchHomeByAddress(stop, opts = {}) {
  const lat = Number(stop && stop.lat), lon = Number(stop && stop.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const entries = opts.entries || loadAddressHomes();
  const tz = opts.tz !== undefined ? opts.tz : timezoneForCoords(lat, lon);
  let cands = addressCandidates(entries, lat, lon, tz);
  if (!cands.length) return null;
  const file = opts.file || VERDICT_FILE;

  const labels = [...new Set((stop.labels || []).filter(x => typeof x === "string" && x.trim()).map(x => x.trim()))];
  const full = await fullAddressFor(lat, lon, { file, reverse: opts.reverse });
  // Without a town on the stop's side, an address-only home has no bound left.
  if (!full) cands = cands.filter(c => c.distance_m != null);
  const stopAddresses = [...new Set([...labels, ...(full ? [full] : [])])];
  if (!cands.length || !stopAddresses.length) return null;

  // Nearest first, so the ids are stable for the same geometry.
  cands.sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity));
  const state = {
    stop_addresses: stopAddresses,
    homes: cands.map((c, i) => ({ id: `h${i}`, address: c.entry.address })),
  };
  const key = verdictKey(state);
  const store = readJson(file);
  const hit = store.verdicts && store.verdicts[key];
  let verdict, cached = false;
  if (hit && hit.verdict && Date.now() - Date.parse(hit.at) < VERDICT_TTL_MS) {
    verdict = hit.verdict; cached = true;
  } else {
    if (opts.allowAsk === false) return null;
    if (opts.onAsk) opts.onAsk();
    let ans;
    try { ans = await (opts.ask || askSameHome)(state, { id: key.slice(0, 12) }); }
    catch (e) {
      if (opts.onError) opts.onError(e);
      return null;
    }
    if (!ans || typeof ans.home !== "string" || !allowedIds(state).has(ans.home)) return null;
    const c = ans.home === "none" ? null : cands[Number(ans.home.slice(1))];
    verdict = { home: ans.home, name: c ? c.entry.name : null, reason: ans.reason || null, state };
    const fresh = readJson(file);
    const now = Date.now();
    const verdicts = {};
    for (const [k, v] of Object.entries(fresh.verdicts || {})) {
      if (v && now - Date.parse(v.at) < VERDICT_TTL_MS) verdicts[k] = v;
    }
    verdicts[key] = { verdict, at: new Date(now).toISOString() };
    writeJsonAtomic(file, { ...fresh, verdicts });
  }
  if (!verdict || verdict.home === "none") return null;
  const c = cands[Number(String(verdict.home).slice(1))];
  if (!c || c.entry.name !== verdict.name) return null;
  return { entry: c.entry, distance_m: c.distance_m, verdict, cached, stop_addresses: stopAddresses };
}
