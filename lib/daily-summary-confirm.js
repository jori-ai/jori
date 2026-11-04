"use strict";
// daily-summary-confirm — the CONFIRMED-FACT backbone for the daily summary.
//
// Why this exists: the old spine took each GPS cluster's centroid, asked
// OSM/Google for the nearest POI, and treated that GUESS as the stop's identity
// — then let the narrator dress it up as fact ("Tea House Example, the
// century-old dim sum room"). One summary shipped three such errors at once: it
// named a 2-GPS-sample lunch after the nearest POI when the user had said in
// chat "we went to Ping's, very disappointing"; it narrated a gallery VISIT that
// was only a recommendation ping (GPS had the user at home); and it asserted a
// landmark-bar stop whose only alternatives were two other bars. Meanwhile the
// genuinely CONFIRMED signals — what the user volunteered in chat, what the
// user's card paid for, what the user's photos actually show — went unused.
//
// This module inverts the trust order. Every stop's venue identity carries a
// PROVENANCE TIER, computed from how it was established:
//
//   CONFIRMED    — the user said it (chat, asked or volunteered), or a known/home
//                  location, or an in-person card charge names it. Assert freely.
//   CORROBORATED — an OSM/Google guess that AGREES with >=1 independent signal
//                  (a transaction, a photo's contents, a busy-calendar event).
//                  Assert plainly, no embellishment.
//   GUESS        — an OSM/Google nearest-POI with a single signal and decent
//                  GPS coverage. Hedge ("around X").
//   WEAK_GUESS   — <=2 GPS samples, OR >=2 near-equidistant alternatives, OR a
//                  "browse" (walk-past) pattern. Hedge hard, name the
//                  alternatives, generate a follow-up question. NEVER add
//                  encyclopedic colour.
//
// One answer sits above all four: `stop.user_non_stop` (the user replied "not a
// stop / just walking" to a location-enrich ask). That's CONFIRMED with
// `non_stop: true` — no venue, no alternatives, no follow-up question.
//
// The narrator's LANGUAGE is gated by the tier (see daily-summary.md). The H3
// header renders by tier too, so certainty is visible at a glance.
//
// Pure + deterministic (no I/O): the caller (daily-summary-build) fetches the
// day's chat turns + transactions and passes them in. Chat-venue extraction is
// deliberately CONSERVATIVE and ADVISORY — it surfaces candidates the agent
// vets (and, for clean ones, writes back to location_history), it never silently
// renames a stop on a fuzzy regex match.

const { matchTransactions } = require("./daily-summary-transactions.js");
const { companionNames, knownCompanions } = require("./companions.js");

// The names of the user and the people the user is with (lib/companions.js),
// lower-cased whole and by first word: a "went to" that leads with a person is a
// companion, not a place. Empty in a fresh install beyond the owner's name.
function companionWords() {
  const { self, aliases } = companionNames();
  const out = new Set();
  for (const n of [...self, ...Object.keys(aliases), ...Object.values(aliases), ...knownCompanions()]) {
    const low = String(n || "").trim().toLowerCase();
    if (!low || low === "the user") continue;
    out.add(low);
    out.add(low.split(/\s+/)[0]);
  }
  return [...out];
}

// Source tiers the resolver already trusts as user-grade truth.
const RESOLVER_CONFIRMED = new Set([
  "user_confirmed",
  "user_confirmed_via_transcript",
  "named_location",
  "known_recurring",
  "confirmed_stop",
  "wifi_ssid",
  // Where the user is staying on this trip, from the travel timeline (resolve-day
  // `applyAccommodation`). As settled as "home" — it's the same fact.
  "accommodation",
  // A physical calendar event covering an iOS visit that GPS clustering never
  // saw — two independent signals, not a nearest-POI guess.
  "calendar_corroborated",
  // A place the USER saved in Google Maps, where the trace shows the user
  // actually sat: most of a verified rest's own fixes inside 30 m of it
  // (resolve-day's nameFromSavedPlaces). The user's label plus the user's fixes — stronger evidence than a
  // hand-curated known_recurring entry matched on a centroid at 80-120 m.
  "saved_place",
  // The venue's own signage, read out of a photo the user took while resting at
  // the stop, with the name quoted from that photo's OCR (resolve-day's
  // nameStopsFromPhotoText). Photographic evidence of the sign beats every
  // proximity tier below it.
  "photo_text",
]);

// Sources that are an honest non-venue label (a neighborhood / reverse-geocode
// area), not a false venue claim. Stated plainly; never "hedged" as if wrong.
const AREA_SOURCES = new Set(["neighborhood", "reverse_geocode"]);

// Sources that are an algorithmic venue GUESS — the class that must earn its
// confidence from a corroborating signal or be hedged.
const GUESS_SOURCES = new Set(["osm_overpass", "google_places", "photo_gps", "coordinate", "unknown"]);

// ---------------------------------------------------------------------------
// Chat-venue mining — volunteered location statements in the day's USER turns.
// ---------------------------------------------------------------------------
//
// The old transcript-overlay (Step 3a) only caught REPLIES to a Jori
// location-enrich question ("Was X your lunch?" -> "Y Space BBQ"). It missed
// VOLUNTEERED statements ("we went to Ping's", "X was disappointing") — which is
// how the "we went to Ping's" truth was once lost. This catches both shapes.

const NEG_SENTIMENT = /\b(disappoint\w*|underwhelm\w*|overrated|mediocre|not (?:great|good|worth)|meh|bad|awful|terrible|skip it|won'?t (?:go )?back)\b/i;
const POS_SENTIMENT = /\b(great|amazing|excellent|incredible|fantastic|delicious|loved|love it|the best|so good|wonderful|outstanding|phenomenal)\b/i;

// Normalize the messy reality of phone typing before matching: curly quotes,
// smart apostrophes ("ping’s"), stray unicode. Without this a "we went to
// ping’s" never matched (lowercase + curly ’).
function normalizeChat(s) {
  return String(s || "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .trim();
}

// A venue statement: "we went to X", "we're at X", "ate at X", "lunch at X",
// "had brunch at X", or "X was <verdict>". Capture the venue phrase. These run
// CASE-INSENSITIVE (phone typing is lowercase) — over-capture is filtered by the
// COMMON_NONVENUE reject set + the agent's vetting, never auto-applied blind.
// Venue token charset excludes sentence punctuation (.!?) so a capture can't run
// past a sentence boundary ("ping's. it's very disappointing" -> "ping's").
const VT = "[\\w'&-]+";
// VENUE_PATTERNS deleted — grammar regexes over the user's chat, replaced
// by bin/day-statements (Rule #0b: a model owns language).


// First-token rejects: pronouns, filler, and the non-venue destinations of
// "went to" ("bed", "the park", "sleep"). A captured phrase whose FIRST token is
// here is not a venue. People/agent names too — they're companions, not places.
const COMMON_NONVENUE = new Set([
  "i", "we", "you", "he", "she", "it", "it's", "they", "this", "that", "there", "here",
  "today", "tomorrow", "yesterday", "the", "a", "an", "and", "but", "so", "then",
  "home", "bed", "sleep", "work", "school", "the park", "town", "downtown", "uptown",
  "lunch", "dinner", "brunch", "breakfast", "coffee",
  "jori",
  ...companionWords(),
]);

// Capitalize the first letter of each space-delimited token only — leaves the
// possessive 's lowercase ("ping's" -> "Ping's", not "Ping'S").
function titleCase(v) {
  return v.split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

// Trailing filler the greedy capture grabs ("balaboosta for lunch" -> "balaboosta").
const TRAILING_FILLER = /\s+(restaurant|cafe|bar|place|spot|for|in|at|was|is|were|today|tonight|now|again|earlier|lunch|dinner|brunch|breakfast|coffee|drinks?|a|the)$/i;

function cleanVenue(raw, relaxed = false) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/['"().,!?;:]+$/g, "").trim();
  let prev;
  do { prev = v; v = v.replace(TRAILING_FILLER, "").trim(); } while (v !== prev);
  if (!v || v.length < 2) return null;
  const low = v.toLowerCase();
  const firstTok = low.split(/\s+/)[0];
  if (COMMON_NONVENUE.has(low) || COMMON_NONVENUE.has(firstTok)) return null;
  // Require a name-like signal: possessive 's, a capital in the original, or 2+
  // tokens. In a strong venue context ("went to X", "the X restaurant") a single
  // lowercase token (a typed "balaboosta") is trusted too.
  const nameLike = relaxed || /'s\b/i.test(v) || /[A-Z]/.test(v) || v.split(/\s+/).length >= 2;
  if (!nameLike) return null;
  return titleCase(v);
}

function sentimentOf(text) {
  if (NEG_SENTIMENT.test(text)) return "negative";
  if (POS_SENTIMENT.test(text)) return "positive";
  return null;
}

// Is a stop a candidate target for a volunteered venue statement? Home / named
// locations are never re-labelled by an offhand chat line; only dwell stops
// whose identity is a guess/area are.
function isBindable(stop) {
  const src = stop.place && stop.place.source;
  if (RESOLVER_CONFIRMED.has(src)) return false;
  if (stop.pattern === "browse") return false;
  return true;
}

// Bind a chat statement (at message time `atMs`) to the most plausible stop.
// Past-tense "we went to X" refers to an EARLIER stop; present-tense "we're at
// X" to the containing stop. We pick the nearest bindable dwell stop at/<= the
// message time; if none precedes, the nearest after. Returns stop or null.
function bindStop(stops, atMs, presentTense) {
  const bindable = stops.filter(isBindable);
  if (!bindable.length) return null;
  // A stop whose window contains the message wins for either tense — "we're at
  // X" (still there) and "we went to X" (sent while wrapping up) both point here.
  const containing = bindable.find(s => s.start_ts_ms <= atMs && s.end_ts_ms >= atMs);
  if (containing) return containing;
  if (presentTense) {
    // present tense with no containing stop -> nearest upcoming
    const following = bindable.filter(s => s.start_ts_ms >= atMs).sort((a, b) => a.start_ts_ms - b.start_ts_ms);
    if (following.length) return following[0];
  }
  // past tense / default: nearest preceding (the stop just left), else following
  const preceding = bindable.filter(s => s.end_ts_ms <= atMs).sort((a, b) => b.end_ts_ms - a.end_ts_ms);
  if (preceding.length) return preceding[0];
  const following = bindable.filter(s => s.start_ts_ms >= atMs).sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  return following[0] || null;
}

// Mine the day's USER messages for volunteered venue statements. Returns
// candidates: { stop_id, name, sentiment, quote, at }. ADVISORY — the agent
// vets each before it names a stop / writes back.
// ---------------------------------------------------------------------------
// Provenance tiering — the heart of the inversion.
// ---------------------------------------------------------------------------

function nearEquidistantAlternatives(stop, withinKm = 0.15) {
  const alts = (stop.alternatives || []).filter(a => a && a.name);
  const primaryD = (stop.place && stop.place.distance_m != null) ? stop.place.distance_m / 1000 : null;
  return alts.filter(a => {
    if (a.distance_km == null) return true; // unknown distance -> treat as competing
    if (primaryD == null) return a.distance_km <= withinKm;
    return Math.abs(a.distance_km - primaryD) <= withinKm;
  });
}

// ---------------------------------------------------------------------------
// A title names a PLACE, never describes one
// ---------------------------------------------------------------------------
//
// When the user answers a location ask with "We were walking along the
// coastline in the minimes park", the whole sentence used to become the stop's
// title. It's the user's own words and it's accurate, but a title is a label in a timeline — it
// should read "Minimes park", with the walking carried by the marker beside it
// and the sentence itself left for the prose underneath.
//
// The place is the last prepositional phrase: "walking ALONG the coastline IN
// the minimes park" -> "the minimes park", which is the destination rather than
// the route. `between` is deliberately absent from the preposition list — in
// "at Puy du Fou, between the Vikings show and the Colosseum show" it would
// carry the title off the place and onto the itinerary.
// Two different roles, and they are NOT the same list. LEAD introduces a place
// ("in the minimes park"); BOUNDARY also ends a capture but must never start one
// — otherwise "…at Puy du Fou, between the Vikings show AND the Colosseum show"
// titles the stop "Colosseum Show".
const LEAD = "in|at|along|through|around|near|by|on|to";
const BOUNDARY = `${LEAD}|and|with|for|from|of|between|while|before|after|then`;
const WORD = "[\\w'’ÀÁÂÄÇÈÉÊËÎÏÔÖÙÛÜàáâäçèéêëîïôöùûü-]+";
// The capture must STOP at the next preposition, or "along the coastline in the
// minimes park" captures "coastline in the minimes" and the title is a fragment
// of the sentence again.
const PLACE_PHRASE = new RegExp(
  `\\b(?:${LEAD})\\s+((?:the\\s+)?(?!(?:${BOUNDARY})\\b)${WORD}(?:\\s+(?!(?:${BOUNDARY})\\b)${WORD}){0,3})`, "gi");
// "walking the village" — a place with no preposition in front of it.
const BARE_WALK_PLACE = new RegExp(
  `\\b(?:walk(?:ing|ed)?|strolling|wandering|driving|drove)\\s+(the\\s+(?!(?:${BOUNDARY})\\b)${WORD}(?:\\s+(?!(?:${BOUNDARY})\\b)${WORD}){0,2})`, "i");
const SMALL_WORDS = new Set(["de", "des", "du", "la", "le", "les", "the", "of", "sur", "en", "and", "a", "an"]);

function titleCasePlace(s) {
  return s.split(/\s+/).map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()))
    ? w.toLowerCase()
    : (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

// Pull the place out of a movement description. Returns null when there isn't
// one ("just walking around") — the caller then falls back to an area label, and
// the header says only that the user was moving, which is all we actually know.
function placeFromMovement(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let phrase = null;
  for (const m of raw.matchAll(PLACE_PHRASE)) phrase = m[1];   // last wins: the destination
  if (!phrase) {
    const bare = BARE_WALK_PLACE.exec(raw);
    if (bare) phrase = bare[1];
  }
  if (!phrase) return null;
  phrase = phrase.replace(/^the\s+/i, "").replace(/[.,;:!?]+$/, "").trim();
  if (phrase.length < 3 || phrase.length > 40) return null;
  // A phrase that's still a verb clause isn't a place.
  if (/^(walking|walked|driving|drove|wandering|strolling|going|coming|home|there|here)$/i.test(phrase)) return null;
  return titleCasePlace(phrase);
}

// The verb the user used, so the marker can say what the user was doing rather than a
// generic "not a stop". Absent -> we inferred the movement and say so.
function movementVerb(text) {
  const m = /\b(walking|walked|driving|drove|strolling|wandering|biking|cycling|running|jogging|riding)\b/i.exec(String(text || ""));
  if (!m) return null;
  const v = m[1].toLowerCase();
  return { walked: "walking", drove: "driving" }[v] || v;
}

// The exact text the email will show for this stop, decided HERE and carried in
// the day JSON — the renderer formats it and makes no identity decisions of its
// own (settle the JSON first, format last). Before this the
// header was composed at render time from the tier while the prose was written
// separately from the manifest, which is how a title and the paragraph under it
// managed to disagree.
//
// `title` is plain text. `certainty` drives the styling and the hedge, and
// `title_kind` says what sort of thing the title names (a venue, an area, a
// stretch of movement, or nothing).
function withTitle(p) {
  const title = p.display_name || null;
  return {
    ...p,
    title,
    certainty: title ? p.certainty : "none",
    // Movement survives having no place to name: "the user was moving and we don't
    // know where" is still movement, and the header must say that rather than
    // fall through to "unlabeled".
    title_kind: title ? p.title_kind : (p.title_kind === "movement" ? "movement" : "unknown"),
  };
}

// Compute one stop's provenance from the stop + the signals bound to it.
//   signals: { confirmedName, sentiment, txnVenue }
// confirmedName is an AGENT-VETTED or precise-signal venue name (from the
// `confirmed` override map: a chat statement the agent vetted, or a photo the
// agent read) | null. txnVenue is an in-person card charge { merchant } | null —
// precise enough (channel=in store + geo) to auto-confirm.
//
// DELIBERATELY: raw mined chat statements do NOT reach here as auto-confirm.
// Free chat is ambiguous — "the villa is 1.6" (a property's value) and "the
// balaboosta restaurant is a great rec" (a tip the user didn't visit) both
// regex-match as venue statements but neither is where the user was. mineChatVenues surfaces them
// as ADVISORY candidates; the agent decides which become `confirmedName`. (This
// mirrors location-confirm: the user/agent confirms, the tool applies.)
function computeProvenance(stop, signals = {}) {
  const src = (stop.place && stop.place.source) || "unknown";
  const guessName = (stop.place && stop.place.name) || null;
  const samples = stop.sample_count;
  const competing = nearEquidistantAlternatives(stop);
  const sig = [];

  // 0. The user answered "not a stop" for this window (location-enrich reply ->
  // place_type='non-stop', surfaced by resolve-day as `user_non_stop`). That is
  // a CONFIRMED fact about the window's identity — there is no venue here — so
  // it outranks every guess below and carries NO alternatives. Before this
  // (2026-07-27) a non-stop answer was invisible to resolve-day and the window
  // shipped as `~<nearest POI>? · unconfirmed (also: …)` even though the prose
  // beside it described the walk correctly.
  if (stop.user_non_stop) {
    // The user's own words if `findme` kept them (the row's place_name arrives here as
    // a user_confirmed source), else an honest area label, else nothing.
    const named = signals.confirmedName || (src === "user_confirmed" ? guessName : null);
    const areaLabel = AREA_SOURCES.has(src) ? guessName : null;
    // The user's sentence describes the stretch; the TITLE takes only the place out of
    // it ("…walking along the coastline in the minimes park" -> "Minimes park")
    // and the full wording rides along as `movement_note` for the prose.
    const place = placeFromMovement(named);
    return withTitle({
      tier: "CONFIRMED", hedge: false, non_stop: true,
      certainty: "answered",
      title_kind: (place || !areaLabel) ? "movement" : "area",
      display_name: place || areaLabel || null,
      confirmed_name: place || null,
      movement_note: named || null,
      movement_verb: movementVerb(named),
      alternatives: [], sentiment: signals.sentiment || null,
      signals: named ? ["user:non-stop", `confirmed:${named}`] : ["user:non-stop"],
    });
  }

  // 0a. A walk out from the nightly base and back with nothing named in it
  // (lib/day-excursions.js). This is NOT a hedge like 0b below: the walk
  // itself is observed — the GPS trace proves the user left and came back — and the
  // title names where it went, taken from a data source (an OSM waterway/park
  // the path ran along, or the turnaround's neighborhood), never guessed at a
  // venue. So it asserts plainly. `certainty` is "known" rather than "answered"
  // because the resolver knows it, the user didn't tell us. What the user did
  // tell us wins (the agent's "Walk along the beach", from the user's "took the
  // dog for a long walk along the beach", once never reached a header titled
  // after the neighborhood).
  if (stop.excursion) {
    const told = signals.confirmedName || null;
    return withTitle({
      tier: "CONFIRMED", hedge: false, excursion: true,
      certainty: told ? "answered" : "known", title_kind: "movement",
      display_name: told || guessName, confirmed_name: told || guessName,
      movement_note: null,
      movement_verb: stop.excursion.mode === "driving" ? "drove" : "walked",
      alternatives: [], sentiment: null,
      signals: [
        `excursion:${stop.excursion.away_m}m out`,
        stop.excursion.feature ? `feature:${stop.excursion.feature.name}` : null,
        told ? `confirmed:${told}` : null,
      ].filter(Boolean),
    });
  }

  // 0b. Several browse clusters that resolve-day merged into one walk. There is
  // no venue to name — the POI guesses were dropped precisely because printing
  // one turned a stroll into a "stop" (a café the walk passed was titled as a
  // stop, not a continuation of the walk along the coastline). If the user SAID
  // what it was, branch 0 above already used the user's words; this is the unanswered
  // case, so it stays a hedge — we inferred the walk from drift and pace.
  if (stop.merged_walk) {
    const area = AREA_SOURCES.has(src) || src === "movement" ? guessName : null;
    return withTitle({
      tier: "GUESS", hedge: true, merged_walk: true,
      certainty: "guess", title_kind: "movement",
      // The area if we have one, else nothing — the header then says only that
      // the user was moving, which is the whole of what we know.
      display_name: area || null,
      confirmed_name: null,
      movement_note: null, movement_verb: null,
      alternatives: [], sentiment: null,
      signals: [`walk:${stop.merged_walk.members} clusters`],
    });
  }

  // 1. Resolver already holds user-grade truth.
  if (RESOLVER_CONFIRMED.has(src)) {
    return withTitle({
      tier: "CONFIRMED", hedge: false,
      // `user_confirmed` is the user answering; the rest (home, known-recurring,
      // wifi) is the resolver knowing. Both assert plainly, but the day JSON
      // keeps them apart so "did the user tell us?" stays answerable.
      certainty: src === "user_confirmed" ? "answered" : "known",
      title_kind: "venue",
      display_name: guessName, confirmed_name: guessName,
      alternatives: [], sentiment: null,
      signals: [`source:${src}`],
    });
  }

  // 2. An agent-vetted name or an in-person card charge NAMES the stop -> CONFIRMED.
  const txn = signals.txnVenue || null;
  const vetted = signals.confirmedName || null;
  if (vetted) sig.push(`confirmed:${vetted}`);
  if (txn) sig.push(`txn:${txn.merchant}`);

  const confirmedName = vetted || txn?.merchant || null;
  if (confirmedName) {
    return withTitle({
      tier: "CONFIRMED", hedge: false,
      certainty: vetted ? "answered" : "corroborated",
      title_kind: "venue",
      display_name: confirmedName, confirmed_name: confirmedName,
      // A name the user gave (or a card charge) settles the stop — the runner-up POIs
      // are no longer competing for the title, so they never reach the header.
      alternatives: [],
      sentiment: signals.sentiment || null,
      signals: sig,
    });
  }

  // 2b. An unanswered "where was this?" card's default (resolve-day
  // applyDefaultGuesses), applied as a low-confidence guess: the title says
  // "probably X", never asserts it, and carries no alternatives (the card
  // already offered them). The user's answer, a vetted name or a card charge
  // (above) all outrank it.
  if (src === "default_applied") {
    return withTitle({
      tier: "GUESS", hedge: true, probable: true,
      certainty: "guess", title_kind: "venue",
      display_name: guessName, confirmed_name: null,
      alternatives: [], sentiment: null,
      signals: ["default:unanswered card"],
    });
  }

  // 3. Honest AREA label (neighborhood / reverse-geocode) — not a venue claim.
  // State plainly, do not "hedge" (it isn't pretending to be a venue), but it's
  // not CONFIRMED either.
  if (AREA_SOURCES.has(src)) {
    return withTitle({
      tier: "GUESS", hedge: false,
      certainty: "guess", title_kind: "area",
      display_name: guessName, confirmed_name: null,
      alternatives: [], sentiment: null,
      signals: [`area:${src}`],
    });
  }

  // 4. An algorithmic venue guess. Weak if thin GPS, competing POIs, or browse.
  const weak =
    (typeof samples === "number" && samples <= 2) ||
    competing.length >= 1 ||
    stop.pattern === "browse";
  if (typeof samples === "number") sig.push(`samples=${samples}`);
  if (competing.length) sig.push(`alts=${competing.length}`);
  if (stop.pattern === "browse") sig.push("browse");

  return withTitle({
    tier: weak ? "WEAK_GUESS" : "GUESS",
    hedge: true,
    certainty: weak ? "weak_guess" : "guess",
    title_kind: "venue",
    display_name: guessName,
    confirmed_name: null,
    alternatives: competing.map(a => a.name),
    sentiment: null,
    signals: sig.length ? sig : [`source:${src}`],
  });
}

// Annotate every stop with `.provenance`. Mutates and returns `stops`.
//   opts.confirmed — agent-vetted { <stop_id>: "<venue>" } map (a chat statement
//     the agent confirmed, or a venue the agent read off the photos). Pass {} on
//     the deterministic first prep; the agent fills it after vetting candidates +
//     reading photos, then re-preps.
// mineChatVenues still runs to surface ADVISORY candidates (returned for the
// manifest), but those candidates do NOT auto-confirm — only `confirmed` and
// in-person transactions do.
// RETIRED: mineChatVenues() read the user's chat with five grammar regexes and
// is the miner that bound a property VALUE ("the villa is 1.6") and a
// restaurant RECOMMENDATION ("the balaboosta restaurant is a great
// rec") onto real stops. Per Rule #0b it is replaced by `bin/day-statements`,
// which reads the day with a model (local -> sonnet -> opus). There is NO regex
// fallback: if the model has not run for a day, there are simply no candidates.
const fs = require("node:fs");

function readStatementVenues(stops = [], dateStr = null) {
  let date = dateStr;
  if (!date) {
    const anyMs = (stops.find(s => s.start_ts_ms) || {}).start_ts_ms;
    if (!anyMs) return [];
    date = new Date(anyMs).toISOString().slice(0, 10);
  }
  let doc;
  try {
    // Directory is overridable so this is testable without writing to a
    // hardcoded absolute path (`/tmp` is not writable under the agent sandbox).
    // Production is unchanged: the default is `/tmp`, which is where
    // `day-statements` writes unless given --out.
    const dir = process.env.DAY_STATEMENTS_DIR || "/tmp";
    const f = `${dir}/day-statements-${date}.json`;
    if (!fs.existsSync(f)) return [];
    doc = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { return []; }
  const out = [];
  for (const p of (doc.places || [])) {
    if (!p || !p.name) continue;
    const atMs = p.said_at_iso ? Date.parse(p.said_at_iso) : null;
    // "now" means the user was there while writing; "earlier" means a prior window.
    const presentTense = String(p.when_hint || "").toLowerCase() === "now";
    const stop = atMs ? bindStop(stops, atMs, presentTense) : null;
    out.push({
      stop_id: stop ? stop.id : null,
      name: p.name,
      sentiment: p.sentiment || null,
      quote: String(p.evidence || "").slice(0, 160),
      at: p.said_at_iso || p.said_at || null,
      when_hint: p.when_hint || null,
      source: "day-statements",
    });
  }
  return out;
}

function applyProvenance(stops = [], { messages = [], transactions = [], confirmed = {}, date = null } = {}) {
  const chatCandidates = readStatementVenues(stops, date);
  // Carry a candidate's sentiment onto a stop the AGENT confirmed to the same
  // venue, so "Ping's (disappointing)" keeps its verdict once vetted.
  const sentimentByStop = {};
  for (const c of chatCandidates) {
    if (c.stop_id && c.sentiment && confirmed[c.stop_id] &&
        String(confirmed[c.stop_id]).toLowerCase().includes(c.name.toLowerCase().split("'")[0])) {
      sentimentByStop[c.stop_id] = c.sentiment;
    }
  }

  const txnMatch = matchTransactions(transactions, stops);
  const txnByStop = txnMatch.byStopId || {};

  for (const s of stops) {
    s.provenance = computeProvenance(s, {
      confirmedName: confirmed[s.id] || null,
      sentiment: sentimentByStop[s.id] || null,
      txnVenue: (txnByStop[s.id] && txnByStop[s.id][0]) || null,
    });
  }
  return { stops, chatCandidates, mobility: txnMatch.mobility, txnMatch };
}

module.exports = {
  readStatementVenues,
  computeProvenance,
  applyProvenance,
  sentimentOf,
  _internal: { cleanVenue, bindStop, isBindable, nearEquidistantAlternatives, placeFromMovement, movementVerb, RESOLVER_CONFIRMED, GUESS_SOURCES, AREA_SOURCES },
};
