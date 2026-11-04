"use strict";
// daily-summary-day — settle the day's FACTS as JSON, then hand them to the
// renderer. Nothing here emits HTML.
//
// Why this layer exists: building the day's skeleton is deterministic (JSON),
// may take several passes to get right, and only once it is as good as it
// gets is the final email formatted.
//
// Before this, `daily-summary-build prep` decided each stop's identity and
// rendered its <h3> in the same step, then the agent wrote prose afterwards —
// so a title and the paragraph under it could disagree, and did: a summary
// shipped "~Café Example? · unconfirmed (also: two other venues)" directly
// above "Not really a stop, you were walking the coastline through the park."
// The answer existed; it just never reached the title.
//
// The split:
//   settleDay(resolved, signals)  -> the canonical day JSON (this file)
//   buildSkeleton(day, photos)    -> HTML, a pure formatter of that JSON
//
// Settling is ITERATIVE because resolutions cascade. Binding a chat answer to
// stop A settles A, which drops A out of the bindable pool for the volunteered-
// venue miner, which can re-bind a later statement to the stop it actually
// describes. So we re-run the whole ladder until no stop's title changes (or
// MAX_PASSES), and record what each pass did in `day.passes` so a wrong title
// can be traced to the pass that set it.
//
// Every stop ends up with:
//   title            the exact text the email will show — decided HERE, once
//   title_certainty  answered | known | corroborated | guess | weak_guess | none
//   title_kind       venue | area | movement | unknown
//   alternatives     only when the title is still a guess
//   needs_review     the agent should look at this one (with a reason)

const { applyProvenance } = require("./daily-summary-confirm.js");

const MAX_PASSES = 5;

// ---------------------------------------------------------------------------
// Answers to the day's own location-enrich asks
// ---------------------------------------------------------------------------
//
// `location-enrich` asks about a stop by TIME ("9m near the beach around
// 12:49 — … just a walk along the beach, or did you actually stop somewhere
// (Café Example, maybe)?") and the user answers whenever they next pick up the
// phone — often hours later, with other asks and unrelated messages in
// between. `findme resolve` writes that answer back to location_history when
// the chat-agent recognizes it, but that write-back is a separate moving part
// that can (and did) lose the content. The transcript is the durable record, so
// mine it directly here as an INDEPENDENT path to the same fact.

// Mirrors `_classify_non_stop` in bin/findme — kept narrow on purpose:
// each pattern needs an explicit not-a-stop marker, so an ordinary answer that
// merely mentions walking ("we walked to Le Récif and had lunch") is NOT read
// as a non-stop.
const NON_STOP_BARE = new Set(["no", "n", "nope", "blip", "not a stop", "none", "nothing",
  "data error", "data blip", "pause", "just a pause", "walk"]);
const NON_STOP_DESCRIBED = [
  /\bnot\s+(?:really\s+)?a\s+(?:real\s+)?stop\b/i,
  /\bwasn'?t\s+a\s+stop\b/i,
  /\b(?:just|only|merely)\s+(?:walking|walked|driving|drove|strolling|wandering|biking|cycling|passing|riding|out\s+for\s+a\s+walk)\b/i,
  /^(?:no[,.]?\s*)?(?:we|i)\s+(?:were|was)\s+(?:just\s+)?(?:walking|driving|strolling|wandering|biking|cycling|passing)\b/i,
];

function classifyAnswer(raw, { offersNonStop = true } = {}) {
  const text = String(raw || "").trim();
  if (!text) return { kind: "unclear" };
  const bare = text.toLowerCase().replace(/[.!?\s]+$/, "");
  if (NON_STOP_BARE.has(bare)) {
    // A bare "no" only means "not a stop" when the ask offered that as an
    // answer. Against "Was the Mousquetaire de Richelieu show your stop at
    // 13:36?" it rejects the VENUE — the user was still there, we just guessed wrong.
    // Reading it as a non-stop would replace one wrong fact with another.
    return offersNonStop ? { kind: "movement", label: null } : { kind: "rejection", label: null };
  }
  if (NON_STOP_DESCRIBED.some(p => p.test(text))) {
    let desc = text;
    for (const p of [/^(?:no|nope)[,.]?\s+/i, /^not\s+(?:really\s+)?a\s+(?:real\s+)?stop\s*[,.;:-]?\s+/i]) {
      desc = desc.replace(p, "");
    }
    desc = desc.trim().replace(/[.!?\s]+$/, "");
    if (!desc) return { kind: "movement", label: null };
    return { kind: "movement", label: (desc[0].toUpperCase() + desc.slice(1)).slice(0, 120) };
  }
  // A command, not an answer — leave the stop open rather than titling it with
  // an instruction. (Same shape as the chat-agent's own answer/command split.)
  if (/^(show|send|add|find|what|when|where|remind|run|check|book|call|cancel|delete|update|make|set|open|play)\b/i.test(text)) {
    return { kind: "unclear" };
  }
  if (text.length > 160) return { kind: "unclear" };
  const label = text.replace(/[.!?\s]+$/, "");
  // A venue answer only becomes a title when it reads like a NAME ("y space
  // bbq", "Le Récif", "1"). Prose that merely mentions where the user was — "We
  // stopped at one of the restaurants and had a plate of cheeses and wine for
  // dinner in ars en re" — is a real answer but a terrible title, so it is
  // surfaced for the agent to turn into one rather than printed verbatim.
  // (A movement answer has no such problem: "just walking the coastline" IS the
  // description, so it applies directly.)
  const nameLike = label.split(/\s+/).length <= 6 && !/[,;:]/.test(label);
  return { kind: "venue", label, nameLike };
}

// Location asks name the stop's time in several ways — "around 12:49", "at
// 11:58", "starting 13:36", "(in around 22:31, ~10h there)". Matching only
// "around" missed half of them: on 2026-07-27 the lunch ask ("50m for lunch
// around Puy du Fou at 11:58") and the show ask ("~1h10 starting 13:36") were
// both invisible, so a reply answering four asks looked like it answered two.
const ASK_TIME = /\b(?:around|at|starting|from|since|in)\s+(\d{1,2}):(\d{2})\b/;

// A time alone isn't enough — a calendar question can carry one. Pair it with a
// location-ask tell so "your 14:30 meeting, want a reminder?" stays out.
const LOCATION_SIGNAL = /\b(gps|stops?|stopped|near|nearby|park|wandering|drifting|walking|walked|there|pause|did you catch)\b|~\d+\s*(m|km|h)\b/i;

// EVERY question Jori asked that day, location or not. The non-location ones
// matter: they are what a reply might ACTUALLY be answering, and without them in
// the running a location ask wins by default just for being open. On 2026-07-26
// that mis-bound three replies — "Yes. Caroline was canceled" (answering a
// calendar question from 80 minutes earlier) landed on the 12:09 stop as its
// venue, purely because the location ask happened to be the most recent message.
function findQuestions(messages = []) {
  const out = [];
  for (const m of messages) {
    if ((m.role || "") !== "assistant") continue;
    const text = String(m.content || "");
    if (!text.includes("?")) continue;
    const t = ASK_TIME.exec(text);
    const isLocationAsk = !!t && LOCATION_SIGNAL.test(text);
    out.push({
      id: m.id || null,
      atMs: Date.parse(m.created_at || m.ts || 0) || null,
      minutes: isLocationAsk ? Number(t[1]) * 60 + Number(t[2]) : null,
      isLocationAsk,
      text,
    });
  }
  return out;
}

// Back-compat name for the location subset (used by tests + callers that only
// care about the asks themselves).
function findAsks(messages = []) {
  return findQuestions(messages).filter(q => q.isLocationAsk);
}

// Pure noise — words that carry no discriminating power in this corpus.
const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "but", "was", "were", "you", "your",
  "we", "our", "just", "not", "for", "with", "that", "this", "there", "here", "did", "does",
  "around", "near", "over", "from", "into", "have", "had", "been", "some", "any", "all",
  "actually", "really", "whole", "time", "stop", "stopped", "somewhere", "maybe", "today",
  "shows", "gps", "min", "mins", "yes", "yeah", "yep", "his", "her", "its", "out", "one"]);

function contentTokens(s) {
  return new Set(String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w)));
}

// Score a reply against the open questions by DISCRIMINATING tokens only: a
// token shared with exactly one open question is worth a point, a token several
// of them contain is worth nothing.
//
// Raw overlap doesn't work here because Jori's location asks are near-clones
// of each other — "GPS shows you", "walking", "stop", "around HH:MM" appear in
// every one, so "we were walking" scores equally against all of them. What
// actually identifies an ask is its rare word: "minimes", "panache", "ars".
// Same unique-winner discipline as the hum reply segmenter, for the same
// reason: a tie must drop, never guess.
function discriminatingMatch(text, openQuestions) {
  const replyTokens = contentTokens(text);
  if (!replyTokens.size || !openQuestions.length) return null;
  const askTokens = openQuestions.map(q => contentTokens(q.text));
  const docCount = new Map();
  for (const set of askTokens) for (const t of set) docCount.set(t, (docCount.get(t) || 0) + 1);

  let best = null, bestScore = 0, tied = false;
  openQuestions.forEach((q, i) => {
    let score = 0;
    for (const t of askTokens[i]) if (replyTokens.has(t) && docCount.get(t) === 1) score += 1;
    if (score > bestScore) { best = q; bestScore = score; tied = false; }
    else if (score === bestScore && score > 0) tied = true;
  });
  if (!best || bestScore === 0 || tied) return null;
  return best;
}

// Which of Jori's open questions is this reply answering — and is it a
// location ask at all? Threading is exact; otherwise the reply must name
// something only that ask mentions.
//
// "Being the only open location ask" is deliberately NOT sufficient. The user
// answers Jori's questions out of order and hours late, so the most recent
// message is routinely not the one being replied to; scoring against every open
// question of ANY topic is what stops an unrelated answer becoming a stop's
// title ("Yes. The meeting was canceled." landing on the 12:09 stop).
function bindAnswerToAsk(reply, openQuestions) {
  if (reply.reply_to) {
    const threaded = openQuestions.find(q => q.id && q.id === reply.reply_to);
    if (threaded) return threaded.isLocationAsk ? { ask: threaded, method: "thread" } : null;
  }
  const best = discriminatingMatch(reply.content, openQuestions);
  if (!best || !best.isLocationAsk) return null;   // no evidence, or the user was answering something else
  return { ask: best, method: "overlap" };
}

// A reply is several answers when it's several sentences. The split exists to
// NOTICE that, not to attribute the pieces — see mineAskAnswers.
function segmentReply(text) {
  return String(text || "")
    .split(/\n+|(?<=[.!?])\s+|\s*;\s*/)
    .map(x => x.trim().replace(/[.!?]+$/, "").trim())
    .filter(x => x.length >= 2);
}

// Does this ask offer "it wasn't a stop" as an answer? It decides what a bare
// "no" MEANS. "Just a walk along the beach, or did you actually stop somewhere?"
// -> "no" is not-a-stop. "Was the Mousquetaire de Richelieu show your stop at
// 13:36?" -> "no" rejects the VENUE; it was still a stop, and marking it a
// non-stop would be a fresh wrong fact of our own invention.
const OFFERS_NON_STOP = /\b(real stop|just a (pause|blip|walk)|or just\b|was it just\b|rather than a stop|not sitting still|not parked|drifting|wandering|walking the)\b/i;

// The stop an ask's "around HH:MM" refers to. EXACT containment wins outright —
// the tolerance band exists only for an ask whose rounded time falls in the gap
// between two stops, and must never let a neighbour poach a time that lands
// squarely inside another stop's window. (It did: with a flat ±10 min the
// 12:09-12:45 stop claimed 12:49, stealing the answer meant for 12:49-13:02.)
function stopCoveringMinutes(stops, minutes, { askAtMs = null, toleranceMin = 10 } = {}) {
  const toMin = (hm) => {
    const [h, m] = String(hm || "").split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  // Distance outside a stop's window: 0 when contained, else minutes to the
  // nearest edge. Stops can wrap past midnight (22:31-02:32).
  const gap = (s) => {
    const a = toMin(s.start), b = toMin(s.end);
    if (a == null || b == null) return null;
    if (b >= a) {
      if (minutes >= a && minutes <= b) return 0;
      return Math.min(Math.abs(minutes - a), Math.abs(minutes - b));
    }
    if (minutes >= a || minutes <= b) return 0;
    return Math.min(Math.abs(minutes - a), Math.abs(minutes - b));
  };
  // On a tie, prefer the stop that STARTS at the named time: an ask quotes the
  // stop's start ("50m for lunch … at 11:58"), and back-to-back stops both
  // contain the shared boundary minute — without this the 11:00-11:58 stop
  // swallowed the ask meant for the 11:58-12:48 one.
  const startDist = (s) => {
    const a = toMin(s.start);
    return a == null ? Infinity : Math.abs(minutes - a);
  };
  // An ask carries a clock time with no date, so a stop must also be PLAUSIBLE
  // for it: asked after the stop began, and within 12h of it ending. Without
  // this, widening the chat window to the next day let 2026-07-27's asks (about
  // a 11:00 stop at Puy du Fou) bind to 2026-07-26's 06:15-11:36 stop purely
  // because it covers 11:00. The genuine cross-day case still works — the 08:46
  // ask about the previous night's 22:31 stop is ~10h later.
  const plausible = (s) => {
    if (askAtMs == null || s.start_ts_ms == null) return true;
    if (askAtMs < s.start_ts_ms) return false;
    return s.end_ts_ms == null || askAtMs - s.end_ts_ms <= 12 * 3600_000;
  };
  let best = null, bestGap = Infinity, bestStart = Infinity;
  for (const s of stops) {
    if (!plausible(s)) continue;
    const g = gap(s);
    if (g == null || g > toleranceMin) continue;
    const sd = startDist(s);
    if (g < bestGap || (g === bestGap && sd < bestStart)) { best = s; bestGap = g; bestStart = sd; }
  }
  return best;
}

/**
 * Read the day's chat for answers to Jori's location asks.
 *
 * Returns { answers, multi, unattributed }:
 *   answers      bound to one stop; `applied` says whether it settles the title
 *   multi        ONE reply that answers SEVERAL asks — surfaced, never guessed
 *   unattributed replies we couldn't bind at all — surfaced so nothing is lost
 *
 * On multi-answer replies (answers were being lost). A catch-up reply after a
 * stretch offline routinely answers every open ask at once. A real one,
 * threaded to the 13:36 ask:
 *
 *   "No. We saw the last panache first, then the vikings, then the colliseum
 *    show. We had lunch after the last panache at the rotissirie (roast chicken
 *    and potatoes). Just walked around in between."
 *
 * That answers four asks — the 11:00 show, the 11:58 lunch, the 13:36 show, and
 * the 14:52 walk. Binding it to the threaded ask alone drops three answers, and
 * classifying the WHOLE text (it contains "Just walked") would have marked the
 * 13:36 stop a non-stop and titled it with the entire paragraph.
 *
 * Deterministic attribution of the pieces is not achievable here and pretending
 * otherwise invents facts: "We had lunch after the last panache at the
 * rotissirie" shares its rare words ("panache", "last") with the SHOW ask, not
 * the lunch ask it actually answers. So a multi-answer reply is detected,
 * surfaced with every candidate ask and its stop, and left to the agent — which
 * attributes semantically. Same split as the hum reply handling: deterministic
 * where it's safe, agent where it isn't, silent nowhere.
 */
function mineAskAnswers(messages = [], stops = []) {
  const questions = findQuestions(messages);
  const answers = [], multi = [], unattributed = [];
  if (!questions.some(q => q.isLocationAsk)) return { answers, multi, unattributed };

  const answered = new Set();
  for (const m of messages) {
    if ((m.role || "") !== "user") continue;
    const atMs = Date.parse(m.created_at || m.ts || 0) || null;
    if (!atMs) continue;
    // Questions still open at this moment: asked before the reply, within 12h,
    // not already answered. All topics, so a location ask has to actually win.
    const open = questions.filter(q => !answered.has(q) && q.atMs && q.atMs < atMs && atMs - q.atMs <= 12 * 3600_000);
    if (!open.length) continue;
    const openLocation = open.filter(q => q.isLocationAsk);
    if (!openLocation.length) continue;

    const segments = segmentReply(m.content);
    const quote = String(m.content || "").slice(0, 300);

    // Match each SENTENCE independently. Per-segment is what separates "this
    // reply answers several asks" from "this reply isn't about location at
    // all" — and it keeps a stray clause from contaminating the classification
    // of the sentence that actually answers ("Just walked around in between"
    // must not make the 13:36 show stop a non-stop).
    const segMatch = segments.map(seg => discriminatingMatch(seg, open));
    const hitAsks = [...new Set(segMatch.filter(q => q && q.isLocationAsk))];

    const surfaceUnbound = (extra) => {
      if (extra.length) unattributed.push({ quote: extra.join(" ").slice(0, 300), at: m.created_at || null,
                                            open_location_asks: openLocation.map(q => q.text.slice(0, 120)) });
    };

    // TWO OR MORE location asks answered in one message -> the agent's job.
    if (hitAsks.length >= 2 || (m.reply_to && segments.length >= 2 && openLocation.length >= 2
                                && openLocation.some(q => q.id === m.reply_to))) {
      const candidates = openLocation
        .map(q => ({ ask_id: q.id, ask_at: q.atMs ? new Date(q.atMs).toISOString() : null,
                     ask: q.text.slice(0, 200), stop_id: (stopCoveringMinutes(stops, q.minutes, { askAtMs: q.atMs }) || {}).id || null }))
        .filter(c => c.stop_id);
      if (candidates.length >= 2) {
        openLocation.forEach(q => answered.add(q));
        multi.push({ quote, segments, at: m.created_at || null,
                     threaded_to: m.reply_to || null, candidates });
        continue;
      }
    }

    // Exactly one location ask has evidence -> bind it, and classify ONLY the
    // sentences that matched it.
    let bound = null, answerText = m.content;
    if (hitAsks.length === 1) {
      bound = { ask: hitAsks[0], method: "overlap" };
      const matched = segments.filter((_, i) => segMatch[i] === hitAsks[0]);
      if (matched.length) answerText = matched.join(". ");
      surfaceUnbound(segments.filter((_, i) => segMatch[i] !== hitAsks[0] && segMatch[i]));
    } else {
      bound = bindAnswerToAsk(m, open);
    }

    if (!bound) {
      // The user said something while a location ask was open and we couldn't tell
      // what it was about. Surface it — an answer we drop silently is exactly
      // what this whole pass exists to stop.
      unattributed.push({ quote, at: m.created_at || null,
                          open_location_asks: openLocation.map(q => q.text.slice(0, 120)) });
      continue;
    }
    const stop = stopCoveringMinutes(stops, bound.ask.minutes, { askAtMs: bound.ask.atMs });
    if (!stop) continue;

    const cls = classifyAnswer(answerText, { offersNonStop: OFFERS_NON_STOP.test(bound.ask.text) });
    if (cls.kind === "unclear") continue;   // not an answer — leave the ask open
    answered.add(bound.ask);
    answers.push({
      stop_id: stop.id,
      kind: cls.kind,
      label: cls.label,
      // Movement answers apply straight to the title; a prose venue answer, or a
      // rejection of a named guess, is surfaced for the agent instead.
      applied: cls.kind === "movement" || cls.nameLike === true,
      quote,
      at: m.created_at || null,
      method: bound.method,
      ask: bound.ask.text.slice(0, 200),
      ask_at: bound.ask.atMs ? new Date(bound.ask.atMs).toISOString() : null,
    });
  }
  return { answers, multi, unattributed };
}

// ---------------------------------------------------------------------------
// The settle loop
// ---------------------------------------------------------------------------

function titleOf(stop) {
  return (stop.provenance && stop.provenance.title) || null;
}

/**
 * Settle the day's stop identities, iterating until nothing changes.
 *
 *   resolved     resolve-day output (mutated in place — stops gain .provenance)
 *   messages     the day's chat turns (both roles; `id`/`reply_to` used when present)
 *   transactions the day's plaid rows
 *   confirmed    agent-vetted { stop_id: "<name>" | {name, kind} } from a prior pass
 *
 * Returns { stops, passes, ask_answers, chat_venue_candidates, mobility, txnMatch }.
 */
function settleDay(resolved, { messages = [], transactions = [], confirmed = {} } = {}) {
  const stops = resolved.stops || [];
  // Normalize the agent's map: a bare string is a venue name.
  const applied = {};
  for (const [id, v] of Object.entries(confirmed || {})) {
    applied[id] = typeof v === "string" ? { name: v, kind: "venue", source: "agent" } : { ...v, source: v.source || "agent" };
  }

  const passes = [];
  let askAnswers = [], multiAnswers = [], unattributed = [];
  let prov = null;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const before = new Map(stops.map(s => [s.id, titleOf(s)]));

    // (1) Answers to the day's own asks. Re-mined every pass: binding is
    // stop-window-based, and a stop settled by an earlier pass can change which
    // stop a later statement belongs to.
    const mined = mineAskAnswers(messages, stops);
    askAnswers = mined.answers;
    multiAnswers = mined.multi;
    unattributed = mined.unattributed;
    let newResolutions = 0;
    for (const a of askAnswers) {
      if (!a.applied) continue;                                                   // advisory only — the agent turns it into a title
      if (applied[a.stop_id] && applied[a.stop_id].source === "agent") continue;  // the agent's vet wins
      // A `user-confirmed` visit row is the later authority: `findme resolve`
      // writes it from this same reply, or from a correction the user made after
      // it. The user once answered a port-side ask "Just passing through", then
      // five minutes later said it was where a friend was met on the dog's walk;
      // the row was fixed to match, and this mined first answer still
      // retitled the stop "no label at all".
      const row = stops.find(s => s.id === a.stop_id);
      if (row && row.place && row.place.source === "user_confirmed") continue;
      // A walk block code built from the user's "not a stop" answers already says what a
      // movement answer about a window inside it says (2026-10-21: "Just passing
      // through", about 14:44-15:17, retitled the whole 14:44-17:13 walk home
      // "not a stop"). The user's own words for the block go through the agent's map.
      if (row && row.excursion && a.kind === "movement" && process.env.JORI_WALK_KEEPS_TITLE !== "0") continue;
      const next = a.kind === "movement"
        ? { name: a.label, kind: "movement", source: "chat-ask" }
        : { name: a.label, kind: "venue", source: "chat-ask" };
      const prev = applied[a.stop_id];
      if (!prev || prev.name !== next.name || prev.kind !== next.kind) newResolutions += 1;
      applied[a.stop_id] = next;
    }

    // (2) A movement answer means the same thing as a `non-stop` row in
    // location_history — mark the stop so provenance drops the POI guess.
    for (const s of stops) {
      const r = applied[s.id];
      if (r && r.kind === "movement") s.user_non_stop = true;
    }

    // (3) Re-run the whole confirmed-fact ladder with everything known so far.
    const confirmedNames = {};
    for (const [id, r] of Object.entries(applied)) if (r.name) confirmedNames[id] = r.name;
    prov = applyProvenance(stops, { messages, transactions, confirmed: confirmedNames, date: resolved.date || null });

    const changed = stops.filter(s => before.get(s.id) !== titleOf(s)).map(s => s.id);
    passes.push({ pass, new_resolutions: newResolutions, titles_changed: changed });
    if (!changed.length && !newResolutions) break;
  }

  // What still needs a human/agent judgment call, in the order worth spending it on.
  const answeredInMulti = new Map();
  for (const r of multiAnswers) for (const c of r.candidates) answeredInMulti.set(c.stop_id, r);
  const rejected = new Set(askAnswers.filter(a => a.kind === "rejection").map(a => a.stop_id));
  for (const s of stops) {
    const p = s.provenance || {};
    // A stop the user ALREADY answered — in a multi-answer reply, or by rejecting
    // the guess we offered — outranks the generic "it's a thin guess" reason:
    // the answer is sitting right there in the transcript, waiting to be read.
    const reason = answeredInMulti.has(s.id) ? "the user answered this in a reply covering several stops — attribute it"
      : rejected.has(s.id) ? "the user rejected the venue we guessed — read the reply for what it actually was"
      : p.certainty === "none" ? "no label at all"
      : p.certainty === "weak_guess" ? "thin guess with competing alternatives"
      : p.certainty === "guess" && p.title_kind === "venue" ? "single-signal venue guess"
      : null;
    s.needs_review = reason ? { reason } : null;
  }

  return {
    stops,
    passes,
    ask_answers: askAnswers,
    // One reply that answers several asks — the agent attributes these; the
    // stops they cover stay open until it does.
    multi_answer_replies: multiAnswers,
    // Replies we could not bind to any ask. Surfaced rather than dropped: a
    // lost answer is the failure this whole pass exists to prevent.
    unattributed_replies: unattributed,
    resolutions: applied,
    chat_venue_candidates: prov ? prov.chatCandidates : [],
    mobility: prov ? prov.mobility : [],
    txnMatch: prov ? prov.txnMatch : null,
  };
}

module.exports = {
  settleDay,
  mineAskAnswers,
  _internal: { classifyAnswer, findAsks, findQuestions, bindAnswerToAsk, discriminatingMatch, segmentReply, stopCoveringMinutes, OFFERS_NON_STOP, LOCATION_SIGNAL, MAX_PASSES },
};
