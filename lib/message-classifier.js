"use strict";
// RETIRED 2026-10-29 — nothing imports this file. Rule #0b (a model owns language,
// code owns geometry): the user's sent iMessages are now read by a model in
// `bin/day-statements` (`self_messages[]`: kind correction | declarative | chatter,
// with a verbatim quote), and lib/resolve-day.js sorts that reading into
// `corrections` / `declarative_self_messages` (selfMessageSignals) with no
// pattern fallback. Kept only for history; do not import it.
//
// message-classifier.js — tag a self-sent iMessage as one of
//   "declarative"  — a positive fact about the day it was sent
//   "correction"   — a retroactive meta-signal about a PRIOR day
//   "chatter"      — vague / opinion / single-word / emoji; drop
//
// This exists because daily-summary used to harvest self-sent iMessages
// into its parallel fact pile, which let an 8:46pm correction like
// "that's the dog's wash - the time stamps are wrong" get treated as a
// declarative fact about that day and silently re-dated prior activity.
//
// The default is "chatter" (drop). Messages are only upgraded to
// "declarative" or "correction" when they match explicit markers.
// Low trust is the point — when in doubt the LLM won't see it.

const CORRECTION_MARKERS = [
  // Explicit meta-signal phrasing
  /\btime\s*stamps?\s*(are|is)?\s*wrong\b/i,
  /\bnot\s+today\b/i,
  /\b(wasn'?t|weren'?t)\s+(today|right|that|the)\b/i,
  /\b(that|it)\s+was\s+(yesterday|last\s+(week|month)|on\s+\w+day|\d{1,2}:\d{2})\b/i,
  /\byou\s+(got|have)\s+(this|it|the\s+(date|time))\s+wrong\b/i,
  /\b(wrong|incorrect)\s+(date|day|time)\b/i,
  /\bcorrection:?\b/i,
  /\b(actually|actually,)\s+(that|the|it)\b/i,
  // "Was at <X>" at message start — a correction pattern seen in practice
  /^\s*(the\s+)?[A-Z].{0,60}\bwas\s+(at|on|in)\b/i,
];

// Positive fact markers — places, people, meals, explicit happenings.
const DECLARATIVE_MARKERS = [
  /\bhad\s+(lunch|dinner|breakfast|coffee|drinks|brunch)\b/i,
  /\b(met|saw|with)\s+[A-Z][a-z]+/,          // "met Sam", "saw Alex"
  /\bwent\s+(to|for)\b/i,
  /\b(at|in)\s+[A-Z][a-z]+(\s+[A-Z]?[a-z]+)?\b/, // "at Cafe Example", "in Old Town"
  /\b(bought|picked\s+up|dropped\s+off)\b/i,
  /\bflew\s+(to|from)\b/i,
];

// Messages shorter than this char count go straight to chatter unless
// they explicitly hit a marker above. Guards against things like "yes",
// "ok", "👍", "👎".
const MIN_MEANINGFUL_LEN = 20;

function stripWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function matchedMarkers(text, markers) {
  const hits = [];
  for (const re of markers) {
    if (re.test(text)) hits.push(String(re));
  }
  return hits;
}

function classifySelfMessage(rawText) {
  const text = stripWhitespace(rawText);
  if (!text) return { kind: "chatter", reason: "empty", markers: [] };

  const correctionHits = matchedMarkers(text, CORRECTION_MARKERS);
  if (correctionHits.length > 0) {
    return {
      kind: "correction",
      reason: "matched correction marker",
      markers: correctionHits,
      text,
    };
  }

  if (text.length < MIN_MEANINGFUL_LEN) {
    return { kind: "chatter", reason: "too short", markers: [], text };
  }

  const declarativeHits = matchedMarkers(text, DECLARATIVE_MARKERS);
  if (declarativeHits.length > 0) {
    return {
      kind: "declarative",
      reason: "matched declarative marker",
      markers: declarativeHits,
      text,
    };
  }

  return { kind: "chatter", reason: "no positive markers", markers: [], text };
}

function classifyAll(messages, { selfOnly = true } = {}) {
  const declarative = [];
  const corrections = [];
  const chatter = [];
  for (const m of messages || []) {
    // Tolerate either the imsg CLI shape ({ is_from_me, text, date, ... })
    // or a normalized { self, text, at, ... } shape. Caller decides what
    // counts as "self-sent."
    const isSelf = m.is_from_me === 1 || m.is_from_me === true || m.self === true;
    if (selfOnly && !isSelf) continue;
    const tagged = classifySelfMessage(m.text || m.content || "");
    const record = {
      at: m.et || m.at || m.date || null,
      channel: m.channel || "imsg_self",
      text: tagged.text,
      markers: tagged.markers,
      reason: tagged.reason,
      raw: m,
    };
    if (tagged.kind === "correction") corrections.push(record);
    else if (tagged.kind === "declarative") declarative.push(record);
    else chatter.push(record);
  }
  return { declarative, corrections, chatter };
}

module.exports = {
  classifySelfMessage,
  classifyAll,
  CORRECTION_MARKERS,
  DECLARATIVE_MARKERS,
};
