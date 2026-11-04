// comedy.mjs — pure helpers for bin/comedy-club-watch-run (Direction B,
// venue-up). Everything here reads venue-published structure — a club's lineup
// API HTML, schema.org JSON-LD, event-link cards, listing date stamps — never
// anything the user wrote.
//
// Roster matching mirrors bin/comedian `check` (same normalisation, same
// name + aka keys) but on WORD boundaries: "Modi" must not match "modified".

export function norm(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // lang-regex-ok: diacritics in a venue listing
    .toLowerCase()
    .replace(/^the\s+/, "")                            // lang-regex-ok: listing-title normalisation
    .replace(/[^a-z0-9]+/g, " ")                       // lang-regex-ok: listing-title normalisation
    .trim();
}

export const keysFor = (c) => [c.name, ...(c.aka || [])].map(norm).filter(Boolean);

/** All roster entries named in a listing text (title, performer list, card). */
export function rosterHits(text, roster) {
  const hay = ` ${norm(text)} `;
  return (roster || []).filter((c) => keysFor(c).some((k) => hay.includes(` ${k} `)));
}

const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
const strip = (s) => decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); // lang-regex-ok: HTML tag strip

/**
 * A club lineup API's HTML for one date → sets (the Comedy Cellar markup; the
 * venue-events `comedyCellar` kind reads it too).
 * Each set: `<div class="set-header">…<span class="bold">7:00 pm…</span>…<span class="title">…</span>`
 * followed by `<span class="name">Performer</span>` entries and a
 * `/reservations-<location>/?showid=<n>` link, relative to `origin`. A set
 * with no link points at `fallback` (default: the origin's home page).
 */
export function parseCellarSets(html, date, { origin = "https://www.comedycellar.com", fallback = null } = {}) {
  const out = [];
  const parts = String(html || "").split('<div class="set-header">').slice(1);
  for (const p of parts) {
    // lang-regex-ok: Comedy Cellar lineup-API markup (machine-generated)
    const time = strip((p.match(/<span class="bold">([\s\S]*?)<span/) || [])[1]);
    const title = strip((p.match(/<span class="title">([\s\S]*?)<\/span>/) || [])[1]); // lang-regex-ok: lineup-API markup
    const names = [...p.matchAll(/<span class="name">([\s\S]*?)<\/span>/g)].map((m) => strip(m[1])).filter(Boolean); // lang-regex-ok: lineup-API markup
    const res = (p.match(/href="(\/reservations-[a-z]+\/\?showid=\d+)"/) || [])[1]; // lang-regex-ok: lineup-API markup
    out.push({
      date, time: to24(time), title, names,
      url: res ? `${origin}${res}` : (fallback || `${origin}/`),
      text: [title, ...names].join(" · "),
    });
  }
  return out;
}

/** "7:00 pm" → "19:00" (null when absent). */
export function to24(s) {
  const m = String(s || "").match(/(\d{1,2}):(\d{2})\s*([ap])\.?m/i); // lang-regex-ok: listing time stamp
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "p") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * First listing date in a venue card ("Sat Oct 12", "October 12, 2026", "10/12",
 * "2026-10-12") → "YYYY-MM-DD", rolling into next year when the month has passed.
 */
export function cardDate(text, today) {
  const s = String(text || "");
  const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
  const iso = s.match(/\b(20\d\d)-(\d\d)-(\d\d)/); // lang-regex-ok: listing date stamp
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?/i); // lang-regex-ok: listing date stamp
  let y, mo, d;
  if (named) { mo = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase()) + 1; d = Number(named[2]); y = named[3] ? Number(named[3]) : null; }
  else {
    const num = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/); // lang-regex-ok: listing date stamp
    if (!num) return null;
    mo = Number(num[1]); d = Number(num[2]); y = num[3] ? Number(num[3].length === 2 ? `20${num[3]}` : num[3]) : null;
  }
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  if (!y) y = mo < tm - 1 ? ty + 1 : ty;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** schema.org availability → the ping's on-sale phrase. */
export function onsalePhrase(availability) {
  const a = String(availability || "").toLowerCase();
  if (a.includes("soldout")) return "SOLD OUT — resale only";
  if (a.includes("instock") || a.includes("limited")) return "on sale NOW";
  if (a.includes("preorder") || a.includes("presale")) return "not on sale yet — tap for the on-sale time";
  return "tickets at the link";
}

/** ISO date embedded in a listing URL path (e.g. /shows/show/13935/2026-10-04-200000-…). */
export function urlDate(url) {
  const m = String(url || "").match(/\/(20\d\d-\d\d-\d\d)(?:[-/T]|$)/); // lang-regex-ok: machine-generated URL path date stamp
  return m ? m[1] : null;
}

export function itemKey(it) {
  return [norm(it.comedian), it.date || it.url, norm(it.venue)].join("|");
}

const TASTE_ORDER = { core: 0, yes: 1, neutral: 2, avoid: 3 };

const tasteLabel = (taste) => (taste === "avoid" ? " (outside your usual taste)" : "");

/** One show without the comedian or URL: "<venue>, Fri, Nov 6 20:00. on sale NOW.<tags>". */
export function showLine(it, withVenue = true) {
  const when = it.date ? new Date(`${it.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "date on the listing";
  const t = it.time ? ` ${it.time}` : "";
  const tags = (it.tags || []).map((x) => ` ${x}`).join("");
  return `${withVenue ? `${it.venue}, ` : ""}${when}${t}. ${it.onsale}.${tags}`;
}

/** One ping line per item, the shape the agent playbook used. */
export function pingText(it) {
  return `🎤 ${it.comedian}${tasteLabel(it.taste)} — ${showLine(it)} ${it.url}`;
}

export function sortItems(items) {
  return [...items].sort((a, b) =>
    ((a.tags || []).length - (b.tags || []).length) ||
    ((TASTE_ORDER[a.taste] ?? 2) - (TASTE_ORDER[b.taste] ?? 2)) ||
    String(a.date || "9").localeCompare(String(b.date || "9")));
}

/**
 * Items → one group per comedian, so several shows by one comedian go out as
 * ONE message listing every date and room (two nights by one comedian used to
 * be two pings and two pushes seconds apart).
 *
 * Identity is structural: `comedian` is always the canonical name of the roster
 * entry the listing already matched (set in toItems from `rosterHits`), so this
 * groups on that roster entry and never compares two spellings of a name.
 * Groups come out in sortItems order of their best show; shows inside a group
 * by date, then time.
 */
export function groupByComedian(items) {
  const by = new Map();
  for (const it of sortItems(items)) {
    if (!by.has(it.comedian)) by.set(it.comedian, []);
    by.get(it.comedian).push(it);
  }
  return [...by.entries()].map(([comedian, shows]) => ({
    comedian,
    taste: shows[0].taste,
    shows: [...shows].sort((a, b) =>
      String(a.date || "9").localeCompare(String(b.date || "9")) || String(a.time || "").localeCompare(String(b.time || ""))),
  }));
}

/** The room every show in a group shares, or null when they span rooms. */
export function sharedVenue(g) {
  const v = new Set(g.shows.map((s) => s.venue));
  return v.size === 1 ? g.shows[0].venue : null;
}

/** "🎤 <comedian> — 2 shows at <room>:" (a multi-show group's first line). */
export function groupHeader(g) {
  const room = sharedVenue(g);
  return `🎤 ${g.comedian}${tasteLabel(g.taste)} — ${g.shows.length} shows${room ? ` at ${room}` : ""}:`;
}

/** The chat message for one comedian: the single-show line unchanged, or a header plus one line per show. */
export function groupText(g) {
  if (g.shows.length === 1) return pingText(g.shows[0]);
  const withVenue = !sharedVenue(g);
  return [groupHeader(g), ...g.shows.map((s) => `• ${showLine(s, withVenue)} ${s.url}`)].join("\n");
}

/** The push line for one comedian. */
export function groupNotify(g) {
  if (g.shows.length === 1) {
    const it = g.shows[0];
    return `${it.comedian} at ${it.venue}${it.date ? ` — ${it.date}` : ""}`;
  }
  const room = sharedVenue(g);
  return `${g.comedian} — ${g.shows.length} shows${room ? ` at ${room}` : ""}`;
}
