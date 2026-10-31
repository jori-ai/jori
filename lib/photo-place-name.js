// Name a stop from the text in the photo the user took there.
//
// WHY THIS EXISTS
// ---------------
// A 42-minute stop shipped as "unlabeled". Inside it was a photo of a
// storefront whose awning read EXAMPLE COFFEE ROOM in foot-high letters, with
// the venue's social handle on the A-frame below it. Apple Photos had already
// OCR'd all of it on-device. Three separate things knew the answer and none
// were plumbed: the photo's own GPS (more precise than any tracker fix that
// hour), the photo's OCR, and the photo row's `match_reason: dist=138m` —
// which recorded that the photo disagreed with the segment it was being filed
// under, and was read by nobody.
//
// Meanwhile the ladder underneath was doing its honest best with nothing: the
// nearest saved place was 129 m away (9 m past the ask radius), the nearest POI
// guess 116 m, and the visit row carried a reverse-geocoded street address,
// which is not a label. So the day offered "unlabeled" and the narrator
// hedged about a coffee shop two blocks off.
//
// A sign in a photo the user took, standing at the place, is better evidence of
// which place it is than any proximity match. This pass is that rung.
//
// WHY A MODEL AND NOT A PARSER
// ----------------------------
// osxphotos hands the OCR back lowercased, de-duplicated and ALPHABETICALLY
// SORTED — word order is gone before we see it. That photo arrives as
//
//   ["are","band","be","because","better","buy","call","camera","coffee",
//    "done","drinks","example","examplecoffee","for","hating","hould",
//    "ithusiasm","job","love","on","room","sane","school","smile","someone",
//    "speakerphone","stay","the","use","with","you","your","zone"]
//
// — the venue name, a menu board, a joke on a sandwich sign, a NO SCHOOL ZONE
// street sign, and two words the OCR mangled ("hould", "ithusiasm"). Picking
// "example coffee room" out of that is a language judgement, and Rule #0b is
// explicit that code owns geometry and a model owns language: never
// pattern-match by how a string looks. So the geometry (which photo, which
// stop, which rest, how far) is decided here in code, and the single question
// "do these words name a business?" goes to a model.
//
// COST
// ----
// Gated hard. The pass runs only on stops with a self-captured photo, taken
// inside the stop's verified rest, with enough OCR to be worth asking about
// (named stops too: the photo always takes precedence), and never more than MAX_CALLS_PER_DAY times in one resolve.
//
// A day is resolved many times (every live-day refresh, the daily summary,
// the writebacks), so each photo is asked about ONCE: the answer is kept in
// VERDICT_CACHE, keyed by everything the question is made of. Before
// 2026-10-13 every pass asked again: 426 asks in six days for 30 distinct
// inputs, and one photo Jev and Sonnet read differently was logged as a new
// Jev disagreement seven times in 19 hours.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { judge, CLAUDE_BIN } = require("./max-judge.js");

const MODEL = "claude-sonnet-5-5";

// The model call is the CLI on the Max subscription, through lib/max-judge.js:
// no tools, no MCP servers, no jori settings or hooks, cwd a temp dir, the
// prompt on stdin and the answer as a schema-checked object. There is no API
// fallback: agent/CLAUDE.md § Auth Model forbids API-key-billed calls, and
// an API key that happens to be in `.env` for another purpose is not ours to
// borrow.
//
// Until 2026-10-10 this file ran its own `claude -p --allowedTools ""` in the
// caller's cwd. `--allowedTools ""` removes nothing (lib/jev-claude.mjs
// says why), so each one-question call loaded the whole ops-agent session: both
// rulebooks, the session-start memory hook and ~985 tool names, about 100-115k
// tokens, nearly all of it cache-written cold, ~$0.20 a call for a ~150-token
// answer (cost-efficiency-review 2026-10-10, 30 successful calls in 5 days).

// A photo whose OCR is one word is a street sign or a price tag, not a
// storefront. Two is the floor at which "do these name a business?" is a real
// question.
const MIN_TOKENS = 2;

// Below this the model is guessing, and a wrong confident name is worse than
// "unlabeled" — an unlabeled stop asks the user; a wrongly named one does not.
const ACCEPT_CONFIDENCE = 0.8;

// Ceiling on model calls for one day's resolve. A day with many unnamed stops
// is a day with a GPS problem, not a day to spend money on.
const MAX_CALLS_PER_DAY = 12;

// How far a saved place or POI can sit from the photo and still be offered to
// the model as a spelling to confirm. Wider than the naming radius on purpose:
// these are hints for normalising a name the OCR already produced, never
// permission to pick one.
const CONTEXT_RADIUS_M = 400;

const SYSTEM_PROMPT = `You identify the business or venue in a photograph, from
text that Apple Photos already read out of that photograph.

The words are given to you as an UNORDERED, lowercased bag. Word order and line
breaks are gone. The bag mixes everything legible in the frame: the venue's own
signage, menu boards, slogans, street signs, notices, other businesses across
the street, and OCR errors (truncated or mangled words are common).

Return the name of the venue the photo was taken AT, and only if the words
actually spell it out. Signals that a name is the venue's own: it appears on an
awning-style repetition, it recurs as a social handle (e.g. "acmecoffee"
alongside "acme" and "coffee"), or it is a distinctive proper noun that is not a
street, a neighbourhood, or a generic category word.

Return null for name when:
- the bag holds only generic words ("coffee", "open", "bar", "sale")
- the only proper nouns are streets, cities, or brands being sold rather than
  the seller
- you would be inferring the venue from the address or the nearby-places list
  rather than reading it in the photo

The nearby-places list is context for SPELLING and formatting only — if the
photo's words name a place on that list, use that list's spelling. Never return
a name from that list that the photo's words do not support. It is far better to
return null than to name the wrong shop; a stop with no name asks the owner
directly, a stop with a wrong name never does.

Whatever you return in name, if the venue is one of the nearby places also
return that place in listed, copied exactly as the list writes it, even when
the list writes it in another script (Hebrew, Arabic, Cyrillic) or with a branch
suffix the sign does not show. listed is how the caller knows which listed place
you mean. Otherwise listed is null.

Give the name as it would appear on the sign, in normal capitalisation.`;

const NAME_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: ["string", "null"],
      description: "The venue name, or null if the words do not name one.",
    },
    listed: {
      type: ["string", "null"],
      description: "The nearby place this is, copied exactly as listed (any script), or null if it is not on the list.",
    },
    confidence: {
      type: "number",
      description: "0-1. How sure you are this names the venue the photo was taken at.",
    },
    evidence: {
      type: "string",
      description: "The words you read it from, and why they are the venue's own.",
    },
  },
  required: ["name", "listed", "confidence", "evidence"],
  additionalProperties: false,
};

function haversineMeters(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lat2 == null || lon1 == null || lon2 == null) return Infinity;
  const R = 6371000, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Did the model read the name in the photo, or invent it from the context we
 * handed it?
 *
 * This is NOT a language test and it is not Rule #0b pattern-matching: it makes
 * no judgement about what the words mean, which of them are generic, or how a
 * name is shaped. It checks one thing — that the answer is quoted from the
 * input. EVERY substantial word of the returned name has to appear in the bag
 * the model was given, as a whole token or inside one (so "Example" is
 * satisfied by "examplecoffee").
 *
 * All, not any, and the difference is the whole guard. "Think Coffee" — the
 * 130 m guess the narrator actually shipped on 2026-09-05 — clears an ANY test
 * on the word "coffee" alone, because a coffee shop's OCR contains "coffee".
 * Requiring "think" too is what makes the nearby-places list a spelling aid
 * rather than a menu to order from.
 *
 * Words under 4 characters are skipped ("&", "the", "NY"): they carry no
 * evidence either way and OCR drops them freely. If a mangled scan costs a real
 * name its match, the stop stays unnamed and the user gets asked — the safe direction.
 */
// A listed place whose name has no Latin-script word to check (a Hebrew
// "מאמא גרג" against OCR'd "mama") can't be grounded by spelling. Jev reading
// it as the sign is accepted only if that place is this close to where he
// stood — the spelling guard's job, done by geometry instead.
const UNCHECKABLE_NAME_MAX_M = 75;
function checkableWords(name) {
  return String(name).toLowerCase().split(/[^a-z0-9]+/i).filter(w => w.length >= 4);
}

function groundedInPhoto(name, tokens) {
  const bag = tokens.map(t => String(t).toLowerCase());
  const words = String(name).toLowerCase().split(/[^a-z0-9]+/i).filter(w => w.length >= 4);
  if (!words.length) return false;
  return words.every(w => bag.some(t => t === w || t.includes(w)));
}

/**
 * The photo best placed to name this stop: self-captured (a received photo's
 * GPS and signage are the sender's), taken inside the stop, carrying enough
 * OCR to ask about. Ties break on token count — more legible text, better
 * chance the name is in it.
 */
function bestPhotoForStop(stop, textFor) {
  const tokensOf = p => (textFor(p.uuid) || {}).tokens || [];
  // `photo_text_eligible`, when it is a list, is the caller's geometry verdict:
  // the photos taken inside this stop's verified rest. A photo from the walk in
  // or out is a picture of somewhere the user passed, not of where they stopped.
  const allowed = Array.isArray(stop.photo_text_eligible) ? new Set(stop.photo_text_eligible) : null;
  const cands = (stop.photos || []).filter(p =>
    p.self_captured !== false
    && (!allowed || allowed.has(p.uuid))
    && tokensOf(p).length >= MIN_TOKENS);
  if (!cands.length) return null;
  return cands.reduce((a, b) => (tokensOf(b).length > tokensOf(a).length ? b : a));
}

/** Pull the JSON object out of a model's reply. Operates on MODEL output. */
function parseModelJson(out) {
  if (!out) return null;
  const block = String(out).match(/\{[\s\S]*\}/); // lang-regex-ok: extracting a JSON object from model output, not interpreting the user's words
  if (!block) return null;
  try { return JSON.parse(block[0]); } catch { return null; }
}

// One tool-less judgment (lib/max-judge.js). It rejects with the CLI's own
// error text ("Not logged in" from cron, a usage limit), which the naming loop
// records as the stop's declined reason.
async function askViaCli(payload, timeoutMs) {
  return judge({
    model: MODEL,
    system: SYSTEM_PROMPT,
    prompt: `Input:\n${JSON.stringify(payload, null, 1)}`,
    schema: NAME_SCHEMA,
    effort: "low",
    timeoutMs,
  });
}

// No Claude login → no `claude -p` (2026-10-13): trigger-live-day.sh sets this to the
// reason (inline from cron, or a failed Max check). Jev still reads; only this is skipped.
const NO_CLAUDE_ENV = "JORI_PHOTO_TEXT_NO_CLAUDE";
const SKIPPED = "photo cross-check skipped: "; // our own error text, survives jev-shadow's re-wrap

async function askModel(payload, { timeoutMs = 90000 } = {}) {
  if (process.env[NO_CLAUDE_ENV]) throw new Error(SKIPPED + process.env[NO_CLAUDE_ENV]);
  return askViaCli(payload, timeoutMs);
}

// ---------------------------------------------------------------------------
// Jev (site photo-place-name), since 2026-10-08. Jev reads, it does not write,
// so it CHOOSES among the nearby places a name the photo's words spell out;
// "unlisted" (a venue not on the list) and anything below its threshold go to
// the Sonnet read above, which can spell a name nobody listed. Legacy runs as
// shadow for the site's own week (shadow_until in its question file).
// ---------------------------------------------------------------------------
const JEV_SITE = "photo-place-name";
const norm = (n) => (n == null ? null : String(n).trim().toLowerCase());

async function decideWithJev(payload, legacyAsk, { id = null } = {}) {
  const { decide } = await import("./jev-shadow.mjs");
  const { answerConfidence, jevSiteDef } = await import("./jev.mjs");
  const def = jevSiteDef(JEV_SITE);
  const tpl = def && def.venue_template;
  if (!tpl) return legacyAsk(payload);
  const cands = [];
  for (const p of payload.nearby_places || []) {
    if (p && p.name && !cands.some(c => norm(c) === norm(p.name))) cands.push(p.name);
  }
  const criteria = {};
  cands.forEach((n, i) => { criteria[`c${i}`] = String(n).slice(0, 200); });
  Object.assign(criteria, tpl.fixed_criteria);
  let memo = null;
  const legacy = () => (memo ||= legacyAsk(payload));
  const { value } = await decide({
    site: JEV_SITE,
    id,
    state: {
      ...(payload.photo_lines ? { photo_lines: payload.photo_lines } : {}),
      photo_words: payload.photo_words,
      photo_labels: payload.photo_labels,
      street_address: payload.street_address,
      nearby_places: cands.map((n, i) => ({ id: `c${i}`, name: n })),
    },
    questions: { venue: { type: "choice", instructions: tpl.instructions, criteria } },
    interpret: (answers) => {
      const a = answers.venue;
      const pick = a && a.choice;
      // "unlisted" is not an answer we can act on — it needs a speller.
      if (!pick || pick === "unlisted") return { value: null, confidence: 0 };
      const conf = answerConfidence(a);
      if (pick === "none") return { value: { name: null, confidence: conf, evidence: "jev: the words name no venue" }, confidence: conf };
      const name = cands[Number(String(pick).slice(1))];
      // The stop's current name is unshifted onto the list with no distance;
      // prefer the same place's entry that carries one.
      const matches = (payload.nearby_places || []).filter(p => p && norm(p.name) === norm(name));
      const listed = matches.find(p => Number.isFinite(p.distance_m)) || matches[0];
      return { value: { name: name || null, confidence: conf, evidence: `jev: the photo's words spell ${name}`,
                        from_list: true, distance_m: listed && Number.isFinite(listed.distance_m) ? listed.distance_m : null },
               confidence: conf };
    },
    legacy,
    alwaysShadow: !!(def.shadow_until && Date.now() < Date.parse(def.shadow_until)),
    // Same place, not same string: a Hebrew-listed café whose sign reads in
    // Latin letters comes back from Jev as the list's name and from Sonnet as
    // the sign's ("מאמא גרג רחובות" / "Mama Greg", 2026-10-08), so Sonnet's
    // `listed` (which list entry it means) counts as its answer too.
    same: (j, l) => {
      const jn = norm(j && j.name);
      return jn === norm(l && l.name) || (l != null && l.listed != null && jn === norm(l.listed));
    },
  });
  return value;
}

// ---------------------------------------------------------------------------
// One answer per question (2026-10-13). The key is the whole payload plus
// everything else that shapes the answer: the model, the Sonnet prompt and
// Jev's question file. A renamed stop, a new nearby place, a re-read photo or
// an edited question is a new key and is asked again. Only a real answer is
// kept: a call that throws ("Not logged in" on the cron path) or comes back
// empty is asked again on the next pass. Losing a write to a concurrent
// resolve costs one re-ask, nothing else.
// ---------------------------------------------------------------------------
const VERDICT_CACHE = path.join(__dirname, "..", "data", ".cache", "photo-place-name-verdicts.json");
const VERDICT_TTL_MS = 21 * 24 * 3600 * 1000;
const QUESTION_FILE = path.join(__dirname, "..", "data", "jev-questions", `${JEV_SITE}.json`);

function verdictKey(payload) {
  let question = "";
  try { question = fs.readFileSync(QUESTION_FILE, "utf8"); } catch {}
  return createHash("sha256").update(JSON.stringify([MODEL, SYSTEM_PROMPT, question, payload])).digest("hex");
}

function readVerdicts(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}

function remembered(askFresh, file) {
  return async (payload) => {
    const key = verdictKey(payload);
    const hit = readVerdicts(file)[key];
    if (hit && hit.verdict && Date.now() - Date.parse(hit.at) < VERDICT_TTL_MS) return hit.verdict;
    const verdict = await askFresh(payload);
    if (verdict && typeof verdict === "object") {
      // Re-read: another resolve may have written since this one read.
      const cache = readVerdicts(file);
      const now = Date.now();
      for (const [k, v] of Object.entries(cache)) {
        if (!v || !(now - Date.parse(v.at) < VERDICT_TTL_MS)) delete cache[k];
      }
      cache[key] = { verdict, at: new Date(now).toISOString() };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(cache));
        fs.renameSync(tmp, file);
      } catch {}
    }
    return verdict;
  };
}

/**
 * Name still-unnamed stops from the text in their photos.
 *
 * Runs AFTER nameFromSavedPlaces on purpose: a saved place at the rest is HIS
 * label for the spot and outranks our reading of a sign. This pass is for what
 * that one leaves behind.
 *
 * Mutates `stops` in place for anything it names, and returns what it did and
 * what it declined to do — a declined stop is a question for the user, and the day
 * record should say why it stayed a question.
 *
 * @param stops   resolved stops, each with .photos attached
 * @param textFor uuid => { tokens, labels }. An accessor rather than a field on
 *                the photo on purpose: `stop.photos` is serialised verbatim into
 *                resolved_day_json, and a 60-token OCR bag per photo would grow
 *                every stored day and every embedding of one for the sake of a
 *                value used once, here.
 * @param opts.savedPlacesNear (lat, lon, radiusM) => [{name, address, distance_m}]
 * @param opts.ask             injectable model call, for tests
 * @param opts.verdictCache    answers file; default VERDICT_CACHE in
 *                             production, none when a test injects a reader
 * @returns {named, declined, calls, tally} — tally counts each eligible stop as answered
 *   (Jev, Sonnet or a kept answer), ceiling, few_words (< MIN_TOKENS), failed or no_login
 *   (needed the skipped Claude read); one JSON line to $JORI_PHOTO_TEXT_REPORT if set.
 */
async function nameStopsFromPhotoText(stops, textFor, opts = {}) {
  const tally = { eligible: 0, answered: 0, named: 0, ceiling: 0, few_words: 0, failed: 0, no_login: 0, error: null };
  try {
    return await namePass(stops, textFor, opts, tally);
  } catch (e) {
    tally.pass_failed = true;
    tally.error = String((e && e.message) || e).slice(0, 160);
    throw e;
  } finally {
    if (process.env.JORI_PHOTO_TEXT_REPORT) {
      try { fs.appendFileSync(process.env.JORI_PHOTO_TEXT_REPORT, JSON.stringify(tally) + "\n"); } catch {}
    }
  }
}

async function namePass(stops, textFor, opts, tally) {
  // Tests inject `ask` (the Sonnet read) and stay off Jev unless they also
  // inject `decide`; production goes Jev-first.
  const injected = opts.decide || opts.ask;
  const askFresh = injected || ((payload) => decideWithJev(payload, askModel));
  const cacheFile = opts.verdictCache !== undefined ? opts.verdictCache : (injected ? null : VERDICT_CACHE);
  const ask = cacheFile ? remembered(askFresh, cacheFile) : askFresh;
  const nearby = opts.savedPlacesNear || (() => []);
  const named = [];
  const declined = [];
  let calls = 0;

  for (const s of stops) {
    if (!s.photo_text_eligible) continue;
    tally.eligible += 1;
    if (calls >= MAX_CALLS_PER_DAY) {
      declined.push({ start: s.start, end: s.end, reason: "day's model-call ceiling reached" });
      tally.ceiling += 1;
      continue;
    }
    const photo = bestPhotoForStop(s, textFor);
    if (!photo) { tally.few_words += 1; continue; }
    const read = textFor(photo.uuid) || {};
    let tokens = read.tokens || [];
    // Photos' index is the FAST OCR pass, alphabetised. The chosen photo is
    // re-read in accurate mode (bin/photo-ocr, on-device, cached) for
    // its lines in order and the words the fast pass missed — the cursive
    // "greg" under MAMA on 2026-10-07. Optional: without it, the bag alone.
    let lines = null;
    if (opts.readPhoto) {
      try { lines = await opts.readPhoto(photo.uuid); } catch { lines = null; }
      if (Array.isArray(lines) && lines.length) {
        const extra = lines.flatMap(l => String(l).toLowerCase().split(/\s+/)).filter(Boolean); // lang-regex-ok: tokenising machine OCR output, not the user's words
        tokens = [...new Set([...tokens, ...extra])];
      } else lines = null;
    }

    // Everything the model may see. Coordinates are ours to reason about, so
    // they stay here in code; the model gets names and text only.
    const context = nearby(
      photo.lat != null ? photo.lat : s.lat,
      photo.lon != null ? photo.lon : s.lon,
      CONTEXT_RADIUS_M,
    ).slice(0, 8).map(p => ({ name: p.name, distance_m: p.distance_m }));
    // The stop's current name is a candidate too: a sign that spells it
    // confirms it, and only a sign naming somewhere ELSE replaces it.
    const current = s.place && s.place.name;
    if (current && !context.some(c => norm(c.name) === norm(current))) context.unshift({ name: current, distance_m: null });
    for (const alt of (s.alternatives || []).slice(0, 4)) {
      if (alt && alt.name) {
        context.push({ name: alt.name,
                       distance_m: alt.distance_km != null ? Math.round(alt.distance_km * 1000) : null });
      }
    }

    let verdict;
    calls += 1;
    try {
      verdict = await ask({
        ...(lines ? { photo_lines: lines } : {}),
        photo_words: tokens,
        photo_labels: (read.labels || []).slice(0, 20),
        street_address: (s.place && s.place.address) || null,
        nearby_places: context,
      });
    } catch (e) {
      // A naming pass must never take the day down. An unnamed stop is the
      // status quo; a thrown resolve is a missing summary.
      declined.push({ start: s.start, end: s.end, reason: `model call failed: ${(e && e.message) || e}` });
      const msg = String((e && e.message) || e);
      if (msg.includes(SKIPPED)) tally.no_login += 1;
      else { tally.failed += 1; tally.error = tally.error || msg.slice(0, 160); }
      continue;
    }
    tally.answered += 1;

    const name = verdict && typeof verdict.name === "string" ? verdict.name.trim() : null;
    const conf = verdict && Number.isFinite(verdict.confidence) ? verdict.confidence : 0;
    if (!name) {
      declined.push({ start: s.start, end: s.end, reason: "the photo's words do not name a venue",
                      tokens: tokens.length });
      continue;
    }
    if (conf < ACCEPT_CONFIDENCE) {
      declined.push({ start: s.start, end: s.end, name, confidence: conf,
                      reason: `below the ${ACCEPT_CONFIDENCE} bar — left as a question` });
      continue;
    }
    // The photo always takes precedence (a café stop was still titled with the
    // office the user had just left). A sign that
    // spells the name the stop already has changes nothing — including when
    // the read spells it in another script and says which listed place it
    // means (`listed`) — and needs no grounding, since nothing is written.
    // One that names somewhere else replaces it, whatever the source — the
    // old name is kept.
    const listedAs = verdict && typeof verdict.listed === "string" ? verdict.listed.trim() : null;
    const before = s.place && s.place.name ? { name: s.place.name, source: s.place.source || null } : null;
    if (before && (norm(before.name) === norm(name) || (listedAs && norm(before.name) === norm(listedAs)))) {
      declined.push({ start: s.start, end: s.end, name, reason: "the photo confirms the name the stop already has" });
      continue;
    }
    const grounded = groundedInPhoto(name, tokens)
      || (verdict.from_list && !checkableWords(name).length
          && verdict.distance_m != null && verdict.distance_m <= UNCHECKABLE_NAME_MAX_M);
    if (!grounded) {
      declined.push({ start: s.start, end: s.end, name,
                      reason: "not grounded in the photo's own words — looks read off the nearby list" });
      continue;
    }

    if (before) s.photo_overrode = before;
    named.push({ start: s.start, end: s.end, name, confidence: conf,
                 was: (s.place && s.place.name) || null, was_source: before && before.source,
                 photo: photo.uuid, evidence: verdict.evidence || null });
    s.place = {
      name,
      address: (s.place && s.place.address) || null,
      source: "photo_text",
      confidence: conf,
      distance_m: photo.lat != null && s.lat != null
        ? Math.round(haversineMeters(s.lat, s.lon, photo.lat, photo.lon)) : null,
    };
    s.unnamed = false;
    s.named_from_photo = { uuid: photo.uuid, taken_at: photo.ts, evidence: verdict.evidence || null };
  }

  tally.named = named.length;
  return { named, declined, calls, tally };
}

module.exports = {
  nameStopsFromPhotoText,
  bestPhotoForStop,
  groundedInPhoto,
  MIN_TOKENS, ACCEPT_CONFIDENCE, MAX_CALLS_PER_DAY, CONTEXT_RADIUS_M, MODEL, VERDICT_CACHE,
  _internal: { SYSTEM_PROMPT, NAME_SCHEMA, askModel, askViaCli, parseModelJson, CLAUDE_BIN, verdictKey },
};
