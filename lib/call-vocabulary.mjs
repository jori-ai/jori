// call-vocabulary.mjs — the names a call's notes may need, handed to the model
// that writes them so it can fix what Zoom's speech recognition misheard.
//
// Why: Zoom's AI summary of a recurring call wrote "Suicide" for a client
// company the notes had named for months. The names were already in memory;
// the model writing the notes just was not shown them as names to watch for.
// So the call-notes steps (bin/meeting-notes-from-zoom, bin/call-log) pass
// this list as "names that may appear; correct mis-transcriptions of these".
// A model makes every correction (Rule #0b): code only gathers the list, from
// structure, never by reading prose for proper nouns.
//
// Sources, most specific first (the cap drops from the end):
//   1. a configured list — the meeting's `vocabulary` in meetings.json, or
//      `vocabulary` in agent/local/config/call-log.json for other calls (the
//      companies and products the wiki has no page for);
//   2. the wiki: the counterpart's person page(s), and the person pages linked
//      to or from them (page_links, entity: person);
//   3. recent mentions: person pages linked from the day pages of the last
//      RECENT_DAYS days that link the counterpart.
// Bounded: at most MAX_NAMES names and MAX_CHARS characters in all.

export const MAX_NAMES = 60;
export const MAX_CHARS = 1500;
export const MAX_NAME_LEN = 60;
export const RECENT_DAYS = 30;

/** Groups of names (priority order) → one deduped, bounded list. Pure. */
export function boundedVocabulary(groups, { max = MAX_NAMES, maxChars = MAX_CHARS } = {}) {
  const out = [], seen = new Set();
  let chars = 0;
  for (const g of groups || []) {
    for (const raw of Array.isArray(g) ? g : []) {
      if (typeof raw !== "string") continue;
      const name = raw.trim();
      if (!name || name.length > MAX_NAME_LEN || name.includes("\n")) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      if (out.length >= max || chars + name.length > maxChars) return out;
      seen.add(key); out.push(name); chars += name.length + 2;
    }
  }
  return out;
}

/** The prompt section for a list ("" when empty). Pure. */
export function vocabularyBlock(names, { source = "Zoom" } = {}) {
  if (!names || !names.length) return "";
  return `NAMES THAT MAY APPEAR (people, companies and products already in memory):
${names.join("; ")}
${source}'s speech recognition often mishears names, turning a company or a surname into a common word that may sound only loosely like it. A word that makes no sense where it stands (an ordinary word acting as a company or a person, e.g. "<word> agreed to the contract") is almost always such a mishearing: when one of these names fits there, given what the notes say about it, write that name as spelled here. Correct names that are spelled differently or split ("Sage View") the same way. Never add a name the call did not mention, and leave a word alone when no name fits.`;
}

const entityOf = (row) => {
  try { return JSON.parse((row && row.frontmatter_json) || "{}").entity || null; } catch { return null; }
};

/**
 * Names from the wiki around the counterpart. `pageIds` = their known pages;
 * `names` = display names to find a person page by exact title (structure: a
 * title equal to the name, case aside — never a fuzzy guess). `ws` is
 * lib/wiki-store.js (injected for tests). Never throws: no wiki → [].
 */
export function wikiNames({ pageIds = [], names = [], ws, now = Date.now(), recentDays = RECENT_DAYS }) {
  if (!ws) return [];
  try {
    const isPerson = (id) => entityOf(ws.getPage(id)) === "person";
    const ids = new Set(pageIds.filter((id) => id && ws.getPage(id)));
    for (const n of names) {
      const want = String(n || "").trim().toLowerCase();
      if (!want) continue;
      for (const r of ws.searchPages(n, { limit: 8, type: "user" }) || []) {
        const p = ws.getPage(r.id);
        if (p && String(p.title || "").trim().toLowerCase() === want && entityOf(p) === "person") ids.add(r.id);
      }
    }
    const core = [], linked = [], recent = [];
    const since = new Date(now - recentDays * 864e5).toISOString().slice(0, 10);
    for (const id of ids) {
      const p = ws.getPage(id);
      if (p && p.title) core.push(p.title);
      for (const l of ws.getForwardLinks(id) || []) if (l.resolved && isPerson(l.dst_id)) linked.push(l.dst_title);
      for (const b of ws.getBacklinks(id) || []) {
        if (b.src_id.startsWith("day_")) {
          // A day page that links the counterpart: whoever else it links came up around them lately.
          if (b.src_id.slice(4) < since) continue;
          for (const l of ws.getForwardLinks(b.src_id) || []) if (l.resolved && !ids.has(l.dst_id) && isPerson(l.dst_id)) recent.push(l.dst_title);
        } else if (isPerson(b.src_id)) linked.push(b.src_title);
      }
    }
    return [...core, ...linked, ...recent].filter(Boolean);
  } catch { return []; }
}

/** The whole list for one call. `config` = the configured names. Never throws. */
export function callVocabulary({ config = [], pageIds = [], names = [], ws, now } = {}) {
  return boundedVocabulary([Array.isArray(config) ? config : [], wikiNames({ pageIds, names, ws, now })]);
}
