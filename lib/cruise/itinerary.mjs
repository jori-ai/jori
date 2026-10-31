// Shared itinerary cleanup for the six cruise extractors.
//
// Every line publishes its ports differently, but they get two things wrong in
// the same two ways, and both were visible on the live site on 2026-09-01:
//
//   1. SEA DAYS ride along as if they were ports. MSC lists "Day At Sea" as a
//      visiting port (code SEADAY) — a 13-night Caribbean sailing showed four
//      of them between the real calls. Royal types them `CRUISING`, Holland
//      spells them "Cruising Panama Canal and Gatun Lake".
//   2. THE EMBARKATION PORT reappears in the middle of the list. MSC's
//      visitingPorts is an unordered facet array that includes the home port
//      on a round trip, so the card read "... → Philipsburg → <home port> →
//      Ocean Cay → ...", which looks like a mistake because it is one.
//
// Both are cosmetic in the data and glaring on a card, so they are stripped
// once, here, instead of five times with five slightly different regexes.
//
// ORDERING is the other half. Only some lines actually publish a sequence:
//   ordered   royal, celebrity (itinerary.days), virgin (ports[].day),
//             ncl (recovered from the itinerary code — see ncl.mjs)
//   unordered msc (Algolia facet array), holland (sortedPortNames_ss)
// An unordered line must set ports_ordered false so the site joins its ports
// with "·" rather than claiming an itinerary with arrows. Guessing an order is
// worse than admitting there isn't one: the wrong sequence still reads as
// authoritative.

/**
 * Is this "port" actually a day at sea, a canal transit, or scenic cruising?
 *
 * lang-regex-ok: matches vendor API enum values and machine-generated place
 * labels ("SEADAY", "Day At Sea", "Cruising the Inside Passage"), not anything
 * a person wrote.
 */
export function isSeaDay(name, code) {
  if (code && /^(seaday|cru|atseaday)$/i.test(String(code))) return true;
  const n = String(name || "").trim();
  if (!n) return true;
  return /^(day at sea|at sea|cruising\b|scenic cruising\b|enter |exit |transit )/i.test(n)
    || /\bday at sea\b/i.test(n)
    // Royal/Celebrity label scenic segments "Inside Passage (Cruising)" and
    // "Hubbard Glacier (Scenic Cruising)" — the marker trails the place name,
    // so a prefix test misses it and the site's normalizePort would then strip
    // the parenthetical and render it as an ordinary port of call.
    || /\((scenic )?cruising\)\s*$/i.test(n);
}

/** The bare place: "Nassau, Bahamas" → "Nassau". */
export function placeName(title) {
  return String(title || "").split(",")[0].trim();
}

/**
 * Drop sea days, drop the voyage's own endpoints, and collapse repeats.
 *
 * `ends` are the embarkation and disembarkation ports as {code, name}; a call
 * matching either by code (or, when the line gives no codes, by name) is the
 * ship being back where it started, not a port worth listing.
 *
 * Repeats collapse GLOBALLY for an unordered list — a set that names Puerto
 * Plata twice is just noise — but only CONSECUTIVELY for an ordered one, where
 * a genuine second call later in the voyage is real information.
 */
export function cleanCalls(raw, { ends = [], ordered = true } = {}) {
  const endCodes = new Set(ends.map((e) => e?.code).filter(Boolean));
  const endNames = new Set(ends.map((e) => placeName(e?.name).toLowerCase()).filter(Boolean));

  const out = [];
  const seen = new Set();
  for (const c of raw || []) {
    const name = placeName(c?.name);
    const code = c?.code || null;
    if (isSeaDay(name, code)) continue;
    if (code ? endCodes.has(code) : endNames.has(name.toLowerCase())) continue;
    const key = (code || name).toLowerCase();
    if (ordered) {
      if (out.length && (out[out.length - 1].code || out[out.length - 1].name).toLowerCase() === key) continue;
    } else {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push({ code, name });
  }
  return out;
}
