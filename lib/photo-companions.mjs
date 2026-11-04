// photo-companions — which of the people face-tagged in the user's photos were
// actually THERE with the user? Jev site `photo-companions`.
//
// The face tag itself is Apple Photos' on-device recognition and stays the
// source of WHO; what no rung judged is whether a tagged face was a person in
// the room. A face on a phone or TV screen, in a framed photo on a shelf, on a
// poster, or in a picture someone sent gets the same tag as a companion across
// the table — and every tag became a companion.
//
// Jev never sees the image (it reads text): it gets each photo's labels, its
// OCR'd text, who else is tagged, whether the user took it, and in how many of the
// stop's photos each person appears. One yes/no per person. It can only
// REMOVE someone (present=false at or above the threshold); legacy — every
// tag is a companion — is the behaviour before, and the fallback.
//
// Names are canonicalised and the user is dropped before anything is asked
// (lib/companions.js): the day is the user's own story.

import { createRequire } from "node:module";
import { decide } from "./jev-shadow.mjs";
import { answerConfidence, boolOf, jevSiteDef } from "./jev.mjs";

const require = createRequire(import.meta.url);
const { companionNames, canonicalName } = require("./companions.js");
const { instance } = require("./instance.cjs");

export const JEV_SITE = "photo-companions";
let NAMES = null;

export function canonical(name) {
  NAMES = NAMES || companionNames();
  return canonicalName(name, NAMES);
}

// The state key that says the user took the photo, named with the owner id
// (`taken_by_<owner_id>`) so an installation's Jev history keeps its key.
const takenByKey = () => `taken_by_${instance().owner_id}`;

const hhmm = (t, tz) => new Date(t).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
const words = (dt) => (dt && typeof dt === "object" ? Object.values(dt).flat().join(" ")
  : Array.isArray(dt) ? dt.join(" ") : (dt || "")).slice(0, 200) || null;

/** Tagged people (canonical, never the user) across the photos, in first-seen order. */
export function taggedPeople(photos) {
  const seen = new Map();
  for (const p of photos || [])
    for (const raw of p.persons || []) {
      const n = canonical(raw);
      if (n && !seen.has(n)) seen.set(n, 0);
      if (n) seen.set(n, seen.get(n) + 1);
    }
  return seen;
}

/** The state Jev sees. Pure, so tests can pin it. */
export function buildState({ photos, tz = "UTC", place = null }) {
  const people = taggedPeople(photos);
  return {
    place: place || null,
    photos: (photos || []).map((p) => ({
      at: p.taken_at ? hhmm(Date.parse(p.taken_at), tz) : null,
      [takenByKey()]: p.self_captured !== false,
      shows: Array.isArray(p.labels) ? p.labels.slice(0, 20) : [],
      text_in_photo: words(p.detected_text),
      people_tagged: [...new Set((p.persons || []).map(canonical).filter(Boolean))],
    })),
    people: [...people].map(([name, n]) => ({ name, in_photos: `${n} of ${(photos || []).length}` })),
  };
}

function questionsFor(names) {
  const tpl = jevSiteDef(JEV_SITE)?.person_template;
  if (!tpl) throw new Error(`jev: no person_template for ${JEV_SITE}`);
  const qs = {};
  names.forEach((name, i) => { qs[`p${i}`] = { ...tpl, instructions: tpl.instructions.replaceAll("{{name}}", name) }; });
  return qs;
}

// A new site gets its own shadow week, whatever the global window says.
export function siteShadowing(site, now = Date.now()) {
  const until = jevSiteDef(site)?.shadow_until;
  return !!until && now < Date.parse(until);
}

/**
 * @param photos [{taken_at, persons[], labels[], detected_text, self_captured}]
 * @returns {Promise<{present:string[], dropped:{name:string,confidence:number}[], used:string}>}
 */
export async function presentCompanions({ photos, tz = "UTC", place = null, id = null, decideImpl = decide }) {
  const names = [...taggedPeople(photos).keys()];
  if (!names.length) return { present: [], dropped: [], used: "none" };
  const legacy = async () => names; // every tag is a companion — the behaviour before
  const { value, used, jev } = await decideImpl({
    site: JEV_SITE,
    id,
    state: buildState({ photos, tz, place }),
    questions: questionsFor(names),
    interpret: (answers) => {
      let conf = 1;
      const present = [];
      names.forEach((n, i) => {
        const a = answers[`p${i}`];
        conf = Math.min(conf, answerConfidence(a));
        if (boolOf(a) !== false) present.push(n);
      });
      return { value: present, confidence: conf };
    },
    legacy,
    alwaysShadow: siteShadowing(JEV_SITE),
    same: (a, b) => [...a].sort().join("|") === [...b].sort().join("|"),
  });
  const present = Array.isArray(value) ? value : names;
  const dropped = names.filter((n) => !present.includes(n)).map((name) => ({ name, confidence: jev?.confidence ?? null }));
  return { present, dropped, used };
}
