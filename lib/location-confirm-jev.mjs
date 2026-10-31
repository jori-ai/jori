// location-confirm-jev.mjs — the language-judgment tail of
// bin/location-confirm-resolve.mjs's localResolve(), with Jev as primary.
//
// When the deterministic tiers (1 memory radius, 2/2b calendar containment,
// 3 message-contains-candidate) find nothing, the remaining question — does
// the evidence clearly show which place the user was at? — is a language judgment.
// Jev (lib/jev.mjs) is PRIMARY for it: a choice over the candidates plus
// `named_other` (his own message names a non-candidate venue) and `ask`. The
// old tail — Gemma venue extraction (tier 3b) then ask (tier 4) — is LEGACY:
// shadow during the Jev shadow week, fallback whenever Jev is unavailable or
// below the (deliberately high, 0.9) threshold. Jev cannot return free text,
// so on `named_other` the name is still extracted by messageVenueViaModel —
// Jev decides THAT there is a name, Gemma reads WHAT it is. Questions:
// data/jev-questions/location-confirm.json. Log: data/jev-shadow/.
// `extractVenueFrom(windowMsgs) → Promise<string|null>` is the caller's Gemma
// extractor (messageVenueViaModel), injected so this module is testable.

import { decide, privacyOn } from "./jev-shadow.mjs";
import { jevQuestions, answerConfidence } from "./jev.mjs";

const JEV_SITE = "location-confirm";
// Health rule (no external models on health rows): a dwell whose candidates
// include a medical place is a potential medical visit — keep it on the legacy
// path. Structured Places/OSM type field, not text matching.
const MEDICAL_TYPES = new Set([
  "doctor", "doctors", "dentist", "dental_clinic", "hospital", "clinic", "medical_clinic",
  "medical_center", "medical_lab", "pharmacy", "drugstore", "physiotherapist", "chiropractor",
  "health", "general_hospital", "urgent_care", "psychiatrist", "psychologist", "optometrist",
]);
export function hasMedicalCandidate(cands) {
  return (cands || []).some((c) => {
    const types = [c.primary_type, c.type, ...(Array.isArray(c.types) ? c.types : [])]
      .filter(Boolean).map((t) => String(t).toLowerCase());
    return types.some((t) => MEDICAL_TYPES.has(t));
  });
}

export function dwellWindowMsgs(msgs, dwellWindow) {
  if (!dwellWindow || typeof dwellWindow.startMs !== "number" || typeof dwellWindow.endMs !== "number") return [];
  const LAG_BEFORE_MS = 15 * 60 * 1000;
  const LAG_AFTER_MS = 45 * 60 * 1000;
  return (msgs || []).filter((m) => {
    if (m.role !== "user") return false;
    const atMs = m.at ? Date.parse(m.at) : NaN;
    if (Number.isNaN(atMs)) return false;
    return atMs >= dwellWindow.startMs - LAG_BEFORE_MS && atMs <= dwellWindow.endMs + LAG_AFTER_MS;
  });
}

// The user's messages from earlier the same day, before the dwell window (a
// "meeting friends for lunch at <restaurant>" at 12:42 for a 13:31 dwell whose
// first candidate was that restaurant). Jev may pick a
// CANDIDATE from a plan stated here, never named_other: the name it would
// extract could belong to any stop of the day. Time filter only (geometry).
export function earlierTodayMsgs(msgs, dwellWindow) {
  if (!dwellWindow || typeof dwellWindow.startMs !== "number") return [];
  const LAG_BEFORE_MS = 15 * 60 * 1000;
  const DAY_MS = 18 * 3600 * 1000;
  return (msgs || []).filter((m) => {
    if (m.role !== "user") return false;
    const atMs = m.at ? Date.parse(m.at) : NaN;
    return !Number.isNaN(atMs) && atMs < dwellWindow.startMs - LAG_BEFORE_MS && atMs >= dwellWindow.startMs - DAY_MS;
  }).slice(-30);
}

// Legacy tail, behavior unchanged: tier 3b (Gemma extraction), then tier 4.
async function legacyTail(windowMsgs, extractVenue) {
  if (windowMsgs.length > 0) {
    const venue = await extractVenue();
    if (venue) return { decision: "auto_confirm", venue, reasoning: `message names "${venue}" within dwell window`, source: "local:message_explicit" };
  }
  return { decision: "ask", reasoning: "no memory/calendar/message match", source: "local" };
}

// Agreement: same decision and, for an auto-confirm, the same venue. A Jev
// `named_other` (name not known until extraction) agrees with a legacy
// auto-confirm of a NON-candidate name — that is the same call.
export function sameLocation(names) {
  const lcNames = names.map((n) => String(n).toLowerCase());
  return (j, l) => {
    if (!j || !l || j.decision !== l.decision) return false;
    if (j.decision !== "auto_confirm") return true;
    if (j.named_other) return !lcNames.includes(String(l.venue || "").toLowerCase());
    return String(j.venue || "").toLowerCase() === String(l.venue || "").toLowerCase();
  };
}

// The extraction prompt's JSON slot carries its instructions in angle brackets,
// and gemma3:1b sometimes copies the slot back as its answer. Once, at a family
// home, "<exact venue name as written, or empty string if none>" came back as the
// venue, was auto-confirmed, and was saved as the place's name. A value that is
// still a slot of our own template names nothing. (The shape of OUR prompt, not
// a reading of the user's words — Rule #0b.)
export function isTemplateSlot(v) {
  const t = String(v ?? "").trim();
  return t.startsWith("<") && t.endsWith(">");
}

export async function resolveTail({ cands, cal, msgs, dwellWindow, wiki, askId, centroid, durationMin, extractVenueFrom }) {
  const windowMsgs = dwellWindowMsgs(msgs, dwellWindow);
  // One Gemma extraction at most, shared by the legacy tail and Jev's named_other.
  let venueMemo = null;
  const extractVenue = () => (venueMemo ||= Promise.resolve(extractVenueFrom(windowMsgs))
    .then((v) => (isTemplateSlot(v) ? null : v)));
  let tailMemo = null;
  const legacy = () => (tailMemo ||= legacyTail(windowMsgs, extractVenue));

  const names = cands.map((c) => c.name);
  const questions = jevQuestions(JEV_SITE);
  questions.venue.criteria = {
    ...Object.fromEntries(cands.map((c, i) => [`c${i + 1}`,
      `${c.name}${c.primary_type ? ` (${c.primary_type})` : ""}${c.address ? ` — ${c.address}` : ""}`])),
    ...questions.venue.criteria,
  };
  const state = {
    dwell: { lat: centroid?.lat ?? null, lon: centroid?.lon ?? null, duration_min: durationMin ?? null,
      start: dwellWindow?.startMs ? new Date(dwellWindow.startMs).toISOString() : null,
      end: dwellWindow?.endMs ? new Date(dwellWindow.endMs).toISOString() : null },
    candidates: cands.map((c, i) => ({ option: `c${i + 1}`, name: c.name, type: c.primary_type || null, address: c.address || null })),
    calendar: (cal || []).map((e) => ({ title: e.summary, location: e.location, description: e.description, start: e.start, end: e.end })),
    messages: windowMsgs.map((m) => ({ at: m.at, text: m.body })),
    earlier_today: earlierTodayMsgs(msgs, dwellWindow).map((m) => ({ at: m.at, text: m.body })),
    wiki: (wiki || []).map((h) => ({ candidate: h.candidate, page: h.title, snippet: h.snippet })),
  };

  const { value, used } = await decide({
    site: JEV_SITE,
    id: askId || null,
    // A medical candidate keeps the whole ask off Jev; otherwise the calendar,
    // messages and wiki evidence is screened on-device for health/bank content
    // ("Cardiology follow-up" on a building with no place type).
    skipJev: privacyOn() && hasMedicalCandidate(cands) ? "health-excluded" : undefined,
    privacyScreen: true,
    state,
    questions,
    interpret: (a) => {
      const pick = a.venue?.choice;
      const confidence = answerConfidence(a.venue);
      if (pick === "named_other") return { value: { decision: "auto_confirm", named_other: true, venue: null }, confidence };
      const m = /^c(\d+)$/.exec(pick || "");
      const cand = m ? cands[Number(m[1]) - 1] : null;
      if (cand) return { value: { decision: "auto_confirm", venue: cand.name }, confidence };
      return { value: { decision: "ask" }, confidence };
    },
    legacy,
    same: sameLocation(names),
  });

  if (used !== "jev") return value;
  if (value.decision !== "auto_confirm") return { decision: "ask", reasoning: "jev: evidence does not clearly name the place", source: "jev" };
  if (value.named_other) {
    // Extraction reads only the dwell-window messages (never earlier_today).
    const venue = windowMsgs.length ? await extractVenue() : null;
    if (!venue) return { decision: "ask", reasoning: "jev: message names a venue but extraction found none", source: "jev:named_other" };
    return { decision: "auto_confirm", venue, reasoning: `jev: message names "${venue}" within dwell window`, source: "jev:named_other" };
  }
  return { decision: "auto_confirm", venue: value.venue, reasoning: `jev: evidence names ${value.venue}`, source: "jev:candidate" };
}
