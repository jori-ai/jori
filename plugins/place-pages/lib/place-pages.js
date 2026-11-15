"use strict";

// place-pages — a wiki page for every public place the user spends time at
// (cafés, restaurants, bars, lounges, hotels, shops, museums, parks…), with
// every visit and every photo the user took there (plugins/place-pages).
//
//   1. Stops. The source is the resolved day as corrected by the user
//      (`live-day day <date>`: the archive plus the user's own corrections). A
//      stop counts when it lasted `min_stop_minutes` and its name is SETTLED —
//      the user named it, it was booked, it is a saved place, the sign in a
//      photo read it — or is a map guess at `guess_min_confidence` or better
//      (marked "from the map" on the page). Code owns this: durations,
//      windows, name sources.
//   2. Places. Each stop is matched to the registry (`places`, migration 0191):
//      the same folded name within `same_name_radius_m` is the same place
//      (code: set membership over names our tools wrote). Everything else goes
//      to a model, in batches (the Rule #0b ladder: Haiku, then Sonnet when the
//      answer fails validation): is it the same place as a registry place
//      nearby under another name, what kind of place is it (a public venue
//      kind, or a home, an office, a doctor, transit, not a venue at all —
//      those never get a page), and is one of the wiki's existing pages
//      already about it. Every answer is checked against the options it was
//      given; nothing the model invents is filed.
//   3. Pages. A public place gets a page: a restaurant or museum the shows-seen
//      tracker knows keeps the tracker's page (created through the tracker, so
//      one restaurant is one page), an existing page the model found is
//      adopted, anything else gets `place_<slug>` (`entity: place`, `kind`).
//      This plugin writes only between its own markers
//      (<!-- place-pages:start/end -->): the facts line, the cover, every
//      visit with its photos. Nothing else on the page is touched.
//   4. Photos. The photos of a visit are the ones the resolved day attached to
//      the stop, kept when they are the user's own camera shots (not a
//      screenshot, a received photo, a document or a receipt). They are
//      LINKED, never copied: photo_links (lib/photo-repo.js) points the page
//      at the photo's one row and one thumbnail. A user-pinned cover wins;
//      otherwise a favorite, else the newest photo without people in it.
//
// A re-swept day replaces that day's visits and links, so a correction the
// user makes later (a stop renamed, a walk withdrawn) moves the photos with it.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const LIB = path.join(__dirname, "..", "..", "..", "lib");
const { localConfig, instance } = require(path.join(LIB, "instance.cjs"));
const { installTools } = require(path.join(LIB, "root.cjs"));
const repo = require(path.join(LIB, "photo-repo.js"));

const TOOL = "place-pages";
const START = "<!-- place-pages:start -->";
const END = "<!-- place-pages:end -->";

const DEFAULTS = {
  enabled: true,
  min_stop_minutes: 15,
  lookback_days: 7,
  since: null,
  settled_sources: [
    "user_confirmed", "user_confirmed_via_transcript", "named_location", "known_recurring",
    "confirmed_stop", "accommodation", "saved_place", "photo_text", "calendar_corroborated", "wifi_ssid",
  ],
  guess_sources: ["osm_overpass", "google_places"],
  guess_min_confidence: 0.9,
  exclude_names: [],
  same_name_radius_m: 400,
  same_place_radius_m: 120,
  excluded_labels: ["document", "receipt"],
  cover_avoid_labels: ["people", "person", "adult", "child", "baby", "selfie", "face", "crowd"],
  max_photos_on_page: 40,
  batch_size: 12,
  sonnet_budget: 10,
  thumb_fetch_limit: 300,
};

const PUBLIC_KINDS = {
  cafe: "Café", bakery: "Bakery", restaurant: "Restaurant", bar: "Bar", lounge: "Lounge",
  hotel: "Hotel", rental: "Rental stay", shop: "Shop", market: "Market", museum: "Museum",
  gallery: "Gallery", theater: "Theater", venue: "Venue", gym: "Gym", spa: "Spa", park: "Park",
  beach: "Beach", attraction: "Attraction", library: "Library", worship: "Place of worship",
  other_public: "Place",
};
const PRIVATE_KINDS = {
  own_home: "the user's own home or property",
  private_home: "someone's private home",
  workplace: "an office or workplace",
  medical: "a doctor, clinic, hospital or pharmacy",
  transit: "an airport, station, terminal or a vehicle",
  not_a_venue: "not one place (an errand, a street, a description, several places)",
};
const KINDS = [...Object.keys(PUBLIC_KINDS), ...Object.keys(PRIVATE_KINDS)];
const isPublic = (kind) => Object.prototype.hasOwnProperty.call(PUBLIC_KINDS, kind);
// Page entities that are already "a page about a place" (the shows-seen trackers', ours, hand-made ones).
const PLACE_ENTITIES = new Set(["place", "restaurant", "museum", "lounge", "hotel", "cafe", "bar", "venue"]);

const config = () => ({ ...DEFAULTS, ...localConfig(TOOL, DEFAULTS) });
const norm = repo.norm;
const sha = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
const clip = (s, n) => (String(s ?? "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ""));

/** ascii_snake slug for a page id; empty for a name with no Latin letters or digits. */
function slug(name) {
  // lang-regex-ok: builds a page id from a name (formatting, not meaning)
  return String(name ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

// ── Live dependencies (tests inject their own) ──

function liveDeps() {
  const BIN = installTools("bin");
  const { request } = require(path.join(LIB, "supabase-rest.js"));
  const ws = require(path.join(LIB, "wiki-store.js"));
  let shows;
  return {
    request,
    wiki: ws,
    now: () => Date.now(),
    liveDay(date) {
      const r = spawnSync(path.join(BIN, "live-day"), ["day", date], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 });
      if (r.status !== 0 || !r.stdout.trim()) return null;
      try { return JSON.parse(r.stdout); } catch { return null; }
    },
    archiveDates() {
      const dir = installTools("data", "live-day-archive");
      try { return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, 10)).filter((d) => d.length === 10).sort(); } catch { return []; }
    },
    ensureThumb(uuid) {
      const r = spawnSync(path.join(BIN, "photos"), ["thumb-url", uuid], { encoding: "utf8", timeout: 120_000 });
      const url = String(r.stdout || "").trim().split("\n").pop();
      return r.status === 0 && url.startsWith("http") ? url : null;
    },
    async ladder(prompt, validate) {
      const ml = await import(path.join(LIB, "model-ladder.mjs"));
      const rungs = [ml.localRung({ timeoutMs: 120_000, maxTokens: 2500 }), ml.sonnetRung({ timeoutMs: 240_000, effort: "low" })];
      return ml.runLadder(prompt, { rungs, validate, budget: this._budget || (this._budget = { sonnet: config().sonnet_budget }) });
    },
    // The shows-seen trackers own restaurant and museum pages; reached through
    // the plugin registry, never by path from outside (system/plugins.md).
    shows() {
      if (shows !== undefined) return shows;
      shows = null;
      try {
        const P = require(path.join(LIB, "plugins.cjs"));
        if (P.isEnabled("shows-seen")) {
          const rs = require(P.pluginPath("shows-seen", "lib", "restaurants.js"));
          const ms = require(P.pluginPath("shows-seen", "lib", "museums.js"));
          shows = {
            restaurant: rs.config().enabled ? (name, opts) => rs.placeRestaurant(name, opts) : null,
            museum: ms.config().enabled ? (name, opts) => ms.placeMuseum(name, opts) : null,
          };
        }
      } catch { shows = null; }
      return shows;
    },
  };
}

// ── Dates ──

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayIn(tz, now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

/** The dates a run sweeps: the last `lookback_days` complete days, or an explicit range. */
function datesToSweep({ from = null, to = null, date = null, all = false, now, archiveDates, cfg = config() }) {
  const tz = instance().tz || "UTC";
  const yesterday = addDays(todayIn(tz, now), -1);
  if (date) return [date];
  const have = archiveDates();
  let lo = from || (all ? (have[0] || yesterday) : addDays(yesterday, -(cfg.lookback_days - 1)));
  const hi = to || yesterday;
  if (cfg.since && lo < cfg.since) lo = cfg.since;
  const set = new Set(have);
  const out = [];
  for (let d = lo; d <= hi; d = addDays(d, 1)) if (set.has(d)) out.push(d);
  return out;
}

// ── Stops ──

/** The stops of one corrected day that count: long enough, settled name (or a confident guess). */
function eligibleStops(day, cfg = config()) {
  if (!day || !Array.isArray(day.intervals)) return [];
  const settled = new Set(cfg.settled_sources);
  const guesses = new Set(cfg.guess_sources);
  const excluded = new Set((cfg.exclude_names || []).map(norm));
  const out = [];
  for (const s of day.intervals) {
    if (s.type !== "stop" || s.open) continue;
    const p = s.place || {};
    const name = String(p.name || "").trim();
    if (!name || (s.duration_min || 0) < cfg.min_stop_minutes) continue;
    const src = p.source || "";
    const guess = guesses.has(src);
    if (!settled.has(src) && !(guess && (p.confidence || 0) >= cfg.guess_min_confidence)) continue;
    const startMs = Number(s.start_ts_ms) || Date.parse(s.start);
    out.push({
      date: day.date,
      tz: s.tz || day.tz || instance().tz || "UTC",
      key: `${day.date}:${Math.round(startMs)}`,
      name,
      norm: norm(name),
      excluded: excluded.has(norm(name)),
      source: src,
      guess,
      confidence: p.confidence ?? null,
      lat: typeof p.lat === "number" ? p.lat : (typeof s.lat === "number" ? s.lat : null),
      lon: typeof p.lon === "number" ? p.lon : (typeof s.lon === "number" ? s.lon : null),
      address: p.address || null,
      start: new Date(startMs).toISOString(),
      end: s.end ? new Date(Number(s.end_ts_ms) || Date.parse(s.end)).toISOString() : null,
      duration_min: Math.round(s.duration_min || 0),
      companions: Array.isArray(s.companions) ? s.companions.filter((c) => typeof c === "string") : [],
      calendar: s.calendar?.summary || null,
      photo_uuids: (s.photos || []).map((ph) => ph && ph.uuid).filter(Boolean),
    });
  }
  return out;
}

// ── Registry ──

async function loadPlaces(request) {
  return (await request("/rest/v1/places?select=*&limit=10000")) || [];
}

/**
 * Code's half of matching: the same folded name within same_name_radius_m (or
 * an excluded name) is decided here. Otherwise the stop goes to the model with
 * the registry places near it.
 */
function matchStop(stop, places, cfg = config()) {
  const dist = (p) => repo.haversineM(stop.lat, stop.lon, p.lat, p.lon);
  const same = places.filter((p) => (p.norm_names || []).includes(stop.norm))
    .map((p) => ({ p, d: dist(p) }))
    .filter((x) => x.d <= cfg.same_name_radius_m || (stop.lat == null && x.d === Infinity))
    .sort((a, b) => a.d - b.d);
  if (same.length) return { place: same[0].p };
  const near = places.map((p) => ({ p, d: dist(p) })).filter((x) => x.d <= cfg.same_place_radius_m)
    .sort((a, b) => a.d - b.d).slice(0, 5).map((x) => ({ id: x.p.id, name: x.p.name, kind: x.p.kind, distance_m: Math.round(x.d) }));
  return { place: null, near };
}

// ── The model's half ──

/**
 * The wiki's pages that may already be about this place, for the model to
 * judge: only pages that ARE about a place (a place-like `entity` in their
 * frontmatter, or a place-like id family). A rule, a list or a trip page that
 * mentions the place is never offered: a dry run adopted a page of advice
 * about getting into a club as that club's page.
 */
const PLACE_ID_FAMILIES = ["place_", "restaurant_", "museum_", "lounge_", "hotel_", "cafe_", "bar_", "venue_"];
function existingPagesFor(name, wiki) {
  let hits = [];
  try { hits = wiki.searchPages(norm(name), { mode: "fts", limit: 12 }) || []; } catch { hits = []; }
  return hits.filter((h) => {
    const row = wiki.getPage(h.id);
    if (!row || ["day", "week", "month"].includes(row.type)) return false;
    const entity = frontmatterOf(row).entity;
    return entity ? PLACE_ENTITIES.has(entity) : PLACE_ID_FAMILIES.some((f) => String(h.id).startsWith(f));
  }).slice(0, 6).map((h) => ({ id: h.id, title: h.title || h.id, description: clip(h.description || "", 140) }));
}

function promptFor(items, cfg = config()) {
  const owner = instance().owner_name || "the user";
  const lines = [
    `You sort the places ${owner} stopped at into a registry of places. For each numbered stop below, answer three things.`,
    "",
    "1. same_as: if the stop is the SAME real place as one of its listed nearby registry places (a different spelling, a longer or shorter name, the name of the venue inside a hotel is NOT the hotel), give that place's id; else null.",
    "2. kind: what kind of place it is, exactly one of:",
    ...Object.entries(PUBLIC_KINDS).map(([k, v]) => `   - ${k}: ${v === "Place" ? "another place open to the public" : v.toLowerCase()}`),
    ...Object.entries(PRIVATE_KINDS).map(([k, v]) => `   - ${k}: ${v}`),
    "   A name that is only a street address says nothing about the place: not_a_venue, unless the calendar or the photos show what it is (then that kind).",
    "   A café that mainly serves coffee is cafe; a sit-down meal place is restaurant. An airport lounge is lounge, not transit. A hotel or a rental the user stayed in is hotel or rental.",
    (cfg.exclude_names || []).length ? `   The user's own homes and properties (always own_home): ${cfg.exclude_names.join("; ")}.` : "",
    "3. page: if one of the stop's listed existing wiki pages is a page about this same place, its id; else null. A list of places, a city, a trip or a person is not a page about the place.",
    "4. title: only for a NEW public place (same_as and page both null) whose name does not say which place it is or is a sentence (\"the airbnb\", \"Yes — the airbnb\", \"our hotel\"): a short clear title from what the stop shows (\"Airbnb, Old Town\", the hotel's own name from the calendar or address). Otherwise null; never rename a proper venue name.",
    "",
    "Use only the ids listed with each stop. Answer with JSON only:",
    '{"stops": [{"i": 0, "same_as": null, "kind": "cafe", "page": null, "title": null}, …]}',
    "",
  ].filter((l) => l !== "");
  for (const it of items) {
    lines.push(`[${it.i}] "${it.name}"${it.address ? ` · ${it.address}` : ""}${it.lat != null ? ` · (${it.lat.toFixed(5)}, ${it.lon.toFixed(5)})` : ""}`);
    lines.push(`    named by: ${it.source}${it.guess ? " (a map guess)" : ""} · ${it.visits} stop(s), longest ${it.longest_min} min, around ${it.hours.join(", ")}`);
    if (it.calendar.length) lines.push(`    calendar: ${it.calendar.map((c) => clip(c, 80)).join(" | ")}`);
    if (it.labels.length) lines.push(`    what the photos there show: ${it.labels.slice(0, 25).join(", ")}`);
    lines.push(`    nearby registry places: ${it.near.length ? it.near.map((n) => `${n.id} "${n.name}" (${n.kind}, ${n.distance_m} m)`).join("; ") : "none"}`);
    lines.push(`    existing wiki pages: ${it.pages.length ? it.pages.map((p) => `${p.id} "${p.title}"${p.description ? ` — ${p.description}` : ""}`).join("; ") : "none"}`);
  }
  return lines.join("\n");
}

function validateAnswer(parsed, items) {
  const list = parsed && Array.isArray(parsed.stops) ? parsed.stops : null;
  if (!list) return "need {stops: [...]}";
  const byI = new Map(list.map((s) => [Number(s && s.i), s]));
  for (const it of items) {
    const a = byI.get(it.i);
    if (!a) return `no answer for stop ${it.i}`;
    if (!KINDS.includes(a.kind)) return `stop ${it.i}: kind ${JSON.stringify(a.kind)} is not one of the listed kinds`;
    if (a.same_as != null && !it.near.some((n) => n.id === a.same_as)) return `stop ${it.i}: same_as ${a.same_as} is not one of its nearby places`;
    if (a.page != null && !it.pages.some((p) => p.id === a.page)) return `stop ${it.i}: page ${a.page} is not one of its listed pages`;
    if (a.title != null && (typeof a.title !== "string" || !a.title.trim() || a.title.length > 80)) return `stop ${it.i}: title must be a short string or null`;
  }
  return null;
}

// ── Photos ──

/** The user's own camera shots, minus documents and receipts (machine labels from the photo library). */
function keepPhoto(row, cfg = config()) {
  if (!row || row.hidden || row.in_trash) return false;
  if (row.self_captured !== true) return false;
  if (["screenshot", "screen_recording"].includes(row.media_type)) return false;
  const labels = new Set((row.labels || []).map((l) => String(l).toLowerCase()));
  return !(cfg.excluded_labels || []).some((l) => labels.has(String(l).toLowerCase()));
}

/** Cover: the user's pinned one, else the newest favorite, else the newest without people, else the newest. */
function pickCover(photos, cfg = config()) {
  const usable = photos.filter((p) => p.photo && p.photo.thumb_url);
  if (!usable.length) return null;
  const pinned = usable.find((p) => p.role === "cover");
  if (pinned) return pinned.photo;
  const fav = usable.find((p) => p.photo.favorite);
  if (fav) return fav.photo;
  const avoid = new Set((cfg.cover_avoid_labels || []).map((l) => String(l).toLowerCase()));
  const clean = usable.find((p) => !(p.photo.labels || []).some((l) => avoid.has(String(l).toLowerCase())) && !(p.photo.persons || []).length);
  return (clean || usable[0]).photo;
}

// ── Page rendering ──

function dayLabel(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function clock(iso, tz) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz || "UTC" }).replace(" ", "").toLowerCase(); // lang-regex-ok: formats our own clock string
}

function facts(place, visits, { own }) {
  const bits = [PUBLIC_KINDS[place.kind] || "Place"];
  if (own && place.address) bits.push(place.address);
  bits.push(`${visits.length} visit${visits.length === 1 ? "" : "s"}`);
  if (visits.length) bits.push(`last ${dayLabel(visits[0].date)}`);
  bits.push("kept by place pages");
  return `_${bits.join(" · ")}_`;
}

/**
 * The block for one place's page. `own`: the page is ours (it carries the
 * visit list); on an adopted page (a tracker's restaurant page, a hand-made
 * one) the block is the cover and the photos by visit, so visits are not
 * listed twice.
 */
function renderBlock(place, visits, photos, { own, cfg = config() } = {}) {
  const byVisit = new Map();
  for (const p of photos) {
    const k = String(p.context || "").replace(/^visit:/, ""); // lang-regex-ok: our own context token
    if (!byVisit.has(k)) byVisit.set(k, []);
    byVisit.get(k).push(p);
  }
  const lines = [START, facts(place, visits, { own }), ""];
  if (place.cover_url) lines.push(`![${place.name}](${place.cover_url})`, "");
  lines.push(own ? "## Visits" : "## Photos", "");
  let shown = 0;
  let hidden = 0;
  for (const v of visits) {
    const vp = (byVisit.get(v.stop_key) || []).filter((p) => p.photo && p.photo.thumb_url)
      .sort((a, b) => String(a.photo.taken_at).localeCompare(String(b.photo.taken_at)));
    if (!own && !vp.length) continue;
    const bits = [`**${dayLabel(v.date)}**`];
    const span = [clock(v.start_at, v.tz), clock(v.end_at, v.tz)].filter(Boolean).join("–");
    if (span) bits.push(`${span}${v.duration_min ? ` (${v.duration_min} min)` : ""}`);
    if (own && (v.companions || []).length) bits.push(`with ${v.companions.join(", ")}`);
    if (own && v.name_source && cfg.guess_sources.includes(v.name_source)) bits.push("name from the map");
    const room = Math.max(0, cfg.max_photos_on_page - shown);
    const show = vp.slice(0, room);
    if (vp.length > show.length) bits.push(`${vp.length} photos`);
    lines.push(bits.join(" · "));
    if (show.length) {
      lines.push("");
      for (const p of show) lines.push(`![](${p.photo.thumb_url})`);
    }
    lines.push("");
    shown += show.length;
    hidden += vp.length - show.length;
  }
  if (hidden) lines.push(`_${hidden} more photo${hidden === 1 ? "" : "s"}: \`photo-repo for ${place.page_id}\`_`, "");
  if (own && !visits.length) lines.push("_No visits on record._", "");
  while (lines[lines.length - 1] === "") lines.pop();
  lines.push(END);
  return lines.join("\n");
}

function replaceBlock(rawMd, block) {
  const raw = String(rawMd || "");
  const a = raw.indexOf(START);
  const b = raw.indexOf(END);
  if (a !== -1 && b > a) return raw.slice(0, a) + block + raw.slice(b + END.length);
  return `${raw.replace(/\s*$/, "")}\n\n${block}\n`; // lang-regex-ok: trailing whitespace trim
}

function newPageMd(place) {
  const owner = instance().owner_name || "the user";
  const label = PUBLIC_KINDS[place.kind] || "Place";
  const fm = [
    "---",
    `name: ${JSON.stringify(place.name)}`,
    `description: ${JSON.stringify(`${label} ${owner} has been to; every visit, who came, and the photos taken there`)}`,
    "type: reference",
    "entity: place",
    `kind: ${place.kind}`,
    `place_id: ${place.id}`,
    "scope: [places]",
    "---",
  ].join("\n");
  return `${fm}\n# ${place.name}\n\n${START}\n${END}\n`;
}

const frontmatterOf = (row) => { try { return JSON.parse(row?.frontmatter_json || "{}"); } catch { return {}; } };

// ── The sweep ──

/**
 * Sweep dates: match stops to places (code, then one model call per batch of
 * new names), give public places pages, rebuild each day's visits and photo
 * links, re-render every page that changed. Dry run by default.
 */
async function sweep({ dates = null, from = null, to = null, date = null, all = false, apply = false, deps = liveDeps(), log = () => {} } = {}) {
  const cfg = config();
  if (!cfg.enabled) return { skipped: "place pages are off" };
  const now = deps.now();
  const days = dates || datesToSweep({ from, to, date, all, now, archiveDates: () => deps.archiveDates(), cfg });
  const out = { dates: days.length, stops: 0, matched: 0, new_places: [], aliases: [], private: [], visits: 0, photos_linked: 0, thumbs_made: 0, pages: [], errors: [] };
  const places = await loadPlaces(deps.request);
  const byId = new Map(places.map((p) => [p.id, p]));

  // 1. Stops, matched in code where code can.
  const stops = [];
  for (const d of days) {
    const day = deps.liveDay(d);
    if (!day) { out.errors.push(`${d}: no resolved day`); continue; }
    for (const s of eligibleStops(day, cfg)) stops.push(s);
  }
  out.stops = stops.length;
  const pending = [];
  for (const s of stops) {
    if (s.excluded) { s.place_id = null; continue; }
    const m = matchStop(s, [...byId.values()], cfg);
    if (m.place) { s.place_id = m.place.id; out.matched++; continue; }
    s.near = m.near;
    pending.push(s);
  }

  // 2. The model: one item per distinct place-to-be — the same folded name
  // within same_name_radius_m of the group's first stop is one item (the same
  // rule code applies against the registry).
  const groups = new Map();
  let gid = 0;
  for (const s of pending) {
    let hit = null;
    for (const grp of groups.values()) {
      const a = grp[0];
      if (a.norm !== s.norm) continue;
      const d = repo.haversineM(a.lat, a.lon, s.lat, s.lon);
      if (d <= cfg.same_name_radius_m || (a.lat == null && s.lat == null)) { hit = grp; break; }
    }
    if (hit) hit.push(s);
    else groups.set(gid++, [s]);
  }
  const photoMeta = new Map((await repo.photoRows(pending.flatMap((s) => s.photo_uuids), { request: deps.request })).map((r) => [r.uuid, r]));
  const items = [...groups.values()].map((grp, i) => {
    const first = grp[0];
    const labels = [...new Set(grp.flatMap((s) => s.photo_uuids).flatMap((u) => photoMeta.get(u)?.labels || []))];
    return {
      i, group: grp, name: first.name, address: first.address, lat: first.lat, lon: first.lon, source: first.source, guess: grp.every((s) => s.guess),
      visits: grp.length, longest_min: Math.max(...grp.map((s) => s.duration_min)),
      hours: [...new Set(grp.map((s) => clock(s.start, s.tz)))].slice(0, 4),
      calendar: [...new Set(grp.map((s) => s.calendar).filter(Boolean))].slice(0, 3),
      labels, near: first.near || [], pages: existingPagesFor(first.name, deps.wiki),
    };
  });
  const decided = [];
  for (let b = 0; b < items.length; b += cfg.batch_size) {
    // Ids re-numbered per batch so the prompt stays short and every answer is checked against its own batch.
    const batch = items.slice(b, b + cfg.batch_size).map((it, j) => ({ ...it, i: j }));
    const res = await deps.ladder(promptFor(batch, cfg), (p) => validateAnswer(p, batch));
    if (!res.value) {
      out.errors.push(`model: no valid answer for ${batch.map((x) => x.name).join(", ")} (${(res.errors || []).join(" | ").slice(0, 300)})`);
      log(`model failed on ${batch.length} place(s): ${(res.errors || []).join(" | ").slice(0, 200)}`);
      continue;
    }
    const byI = new Map(res.value.stops.map((s) => [Number(s.i), s]));
    for (const it of batch) decided.push({ it, a: byI.get(it.i), rung: res.rung });
  }

  // 3. File the answers: an alias, or a new place (with a page when public).
  const pageOwners = new Map([...byId.values()].filter((p) => p.page_id).map((p) => [p.page_id, p.id]));
  for (const { it, a, rung } of decided) {
    let place;
    if (a.same_as) {
      place = byId.get(a.same_as);
      const names = [...new Set([...(place.names || []), it.name])];
      place = { ...place, names, norm_names: [...new Set(names.map(norm))] };
      out.aliases.push({ place: place.id, name: it.name });
    } else {
      const id = `pl_${sha(`${it.group[0].norm}|${it.lat?.toFixed(4)}|${it.lon?.toFixed(4)}`)}`;
      // A generic or sentence-like stop name gets the model's clear title; the
      // stop's own words stay an alias, so the next stop under them still matches.
      const title = !a.page && typeof a.title === "string" && a.title.trim() ? a.title.trim() : it.name;
      const names = [...new Set([title, it.name])];
      place = {
        id, name: title, names, norm_names: [...new Set(names.map(norm))], kind: a.kind, page_id: null,
        lat: it.lat, lon: it.lon, address: it.address, kind_source: `model:${rung}`,
      };
      if (isPublic(a.kind)) {
        place.page_id = apply ? pageFor(place, a.page, { deps, pageOwners, log }) : (a.page || `(new page for ${it.name})`);
        if (place.page_id) pageOwners.set(place.page_id, id);
        out.new_places.push({ id, name: title, kind: a.kind, page_id: place.page_id, adopted: Boolean(a.page) });
      } else {
        out.private.push({ name: it.name, kind: a.kind });
      }
    }
    byId.set(place.id, place);
    for (const s of it.group) s.place_id = place.id;
    if (apply) await upsertPlace(place, deps.request, now);
  }

  // 4. Visits and photo links, a day at a time (a re-swept day replaces its own).
  const touched = new Set();
  const thumbBudget = { left: cfg.thumb_fetch_limit };
  for (const d of days) {
    const dayStops = stops.filter((s) => s.date === d && s.place_id && byId.get(s.place_id)?.page_id);
    const rows = await repo.photoRows(dayStops.flatMap((s) => s.photo_uuids), { request: deps.request });
    const meta = new Map(rows.map((r) => [r.uuid, r]));
    const visits = [];
    const links = [];
    for (const s of dayStops) {
      const place = byId.get(s.place_id);
      const kept = s.photo_uuids.map((u) => meta.get(u)).filter((r) => keepPhoto(r, cfg));
      for (const r of kept) {
        if (!r.thumb_url && thumbBudget.left > 0 && apply) {
          thumbBudget.left--;
          const url = deps.ensureThumb(r.uuid);
          if (url) { r.thumb_url = url; out.thumbs_made++; }
        }
        links.push({ photo_uuid: r.uuid, target: place.page_id, context: `visit:${s.key}`, added_by: TOOL });
      }
      visits.push({
        stop_key: s.key, place_id: place.id, date: s.date, start_at: s.start, end_at: s.end, tz: s.tz,
        duration_min: s.duration_min, name_source: s.source, stop_name: s.name, companions: s.companions, photo_count: kept.length,
      });
      touched.add(place.id);
    }
    // Places whose visits on this day are going away re-render too.
    const before = (await deps.request(`/rest/v1/place_visits?select=place_id&date=eq.${d}`)) || [];
    for (const r of before) touched.add(r.place_id);
    out.visits += visits.length;
    out.photos_linked += links.length;
    if (!apply) continue;
    await deps.request(`/rest/v1/place_visits?date=eq.${d}`, { method: "DELETE", prefer: "return=minimal" });
    if (visits.length) await deps.request("/rest/v1/place_visits", { method: "POST", body: visits, prefer: "return=minimal" });
    await repo.unlinkContext(TOOL, `visit:${d}:`, { request: deps.request });
    await repo.link(links, { request: deps.request });
  }

  // 5. Re-render every page whose visits or photos may have changed.
  for (const id of touched) {
    const place = byId.get(id);
    if (!place || !place.page_id) continue;
    if (!apply) { out.pages.push({ place: id, page_id: place.page_id, would_render: true }); continue; }
    try { out.pages.push(await renderPlace(place, { deps, now })); } catch (e) { out.errors.push(`${place.page_id}: ${e.message}`); }
  }
  return out;
}

/** The page a new public place lives on: one the model found, the tracker's, or a new `place_<slug>`. */
function pageFor(place, foundPage, { deps, pageOwners, log }) {
  const shows = deps.shows ? deps.shows() : null;
  const tracker = place.kind === "restaurant" ? shows?.restaurant : (place.kind === "museum" || place.kind === "gallery") ? shows?.museum : null;
  if (tracker) {
    // Through the tracker, so its ledger knows the page and one restaurant stays one page.
    try { return tracker(place.name, { ...(foundPage ? { page: foundPage } : {}), by: TOOL }).wiki_id; } catch (e) { log(`${place.name}: tracker refused (${e.message})`); }
  }
  if (foundPage && deps.wiki.getPage(foundPage)) return foundPage;
  const base = slug(place.name) || sha(`place|${norm(place.name)}`).slice(0, 8);
  for (let i = 1; i <= 20; i++) {
    const id = `place_${base}${i === 1 ? "" : `_${i}`}`;
    const row = deps.wiki.getPage(id);
    if (row) {
      // Our own page under this id, not yet claimed by another place: reuse it.
      if (frontmatterOf(row).entity === "place" && !pageOwners.has(id)) return id;
      continue;
    }
    deps.wiki.savePage(id, newPageMd(place), { editedBy: TOOL });
    return id;
  }
  throw new Error(`${place.name}: no free page id`);
}

async function upsertPlace(place, request, now) {
  const row = {
    id: place.id, name: place.name, names: place.names || [place.name], norm_names: place.norm_names || [norm(place.name)],
    kind: place.kind, page_id: place.page_id || null, lat: place.lat ?? null, lon: place.lon ?? null, address: place.address || null,
    kind_source: place.kind_source || null, updated_at: new Date(now).toISOString(),
  };
  await request("/rest/v1/places?on_conflict=id", { method: "POST", body: [row], prefer: "resolution=merge-duplicates,return=minimal" });
}

/** Rebuild one place's block from its visits and photo links; refresh its cover and counts. */
async function renderPlace(place, { deps = liveDeps(), now = Date.now(), cfg = config() } = {}) {
  const visits = (await deps.request(`/rest/v1/place_visits?select=*&place_id=eq.${encodeURIComponent(place.id)}&order=start_at.desc`)) || [];
  const photos = await repo.photosFor(place.page_id, { request: deps.request });
  const cover = pickCover(photos, cfg);
  const stats = {
    cover_uuid: cover ? cover.uuid : null, cover_url: cover ? cover.thumb_url : null,
    photo_count: photos.length, visit_count: visits.length,
    first_visit: visits.length ? visits[visits.length - 1].date : null, last_visit: visits.length ? visits[0].date : null,
    updated_at: new Date(now).toISOString(),
  };
  await deps.request(`/rest/v1/places?id=eq.${encodeURIComponent(place.id)}`, { method: "PATCH", body: stats, prefer: "return=minimal" });
  Object.assign(place, stats);
  const row = deps.wiki.getPage(place.page_id);
  if (!row) return { page_id: place.page_id, skipped: "no page" };
  if (["day", "week", "month"].includes(row.type)) return { page_id: place.page_id, skipped: "episodic page" };
  const own = frontmatterOf(row).entity === "place";
  const next = replaceBlock(row.raw_md, renderBlock(place, visits, photos, { own, cfg }));
  if (next === row.raw_md) return { page_id: place.page_id, unchanged: true };
  deps.wiki.savePage(place.page_id, next, { editedBy: TOOL });
  return { page_id: place.page_id, visits: visits.length, photos: photos.length, cover: Boolean(cover) };
}

// ── Lookups for the CLI and for anyone referring to a place ──

/** Places whose names (folded) include `name`, nearest first when a point is given. */
async function findPlaces(name, { lat = null, lon = null, deps = liveDeps() } = {}) {
  const n = norm(name);
  const rows = await loadPlaces(deps.request);
  return rows.filter((p) => (p.norm_names || []).includes(n) || norm(p.name).includes(n))
    .map((p) => ({ ...p, distance_m: lat != null ? Math.round(repo.haversineM(lat, lon, p.lat, p.lon)) : null }))
    .sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0) || (b.visit_count || 0) - (a.visit_count || 0));
}

/** The user's correction of a place's kind: a public kind gets a page, a private one keeps its page but stops getting visits. */
async function setKind(placeId, kind, { deps = liveDeps(), log = () => {} } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const [place] = (await deps.request(`/rest/v1/places?select=*&id=eq.${encodeURIComponent(placeId)}`)) || [];
  if (!place) throw new Error(`no place ${placeId}`);
  place.kind = kind;
  place.kind_source = "user";
  if (isPublic(kind) && !place.page_id) {
    const owners = new Map(((await loadPlaces(deps.request)) || []).filter((p) => p.page_id).map((p) => [p.page_id, p.id]));
    place.page_id = pageFor(place, null, { deps, pageOwners: owners, log });
  }
  await upsertPlace(place, deps.request, deps.now());
  return place;
}

module.exports = {
  TOOL, START, END, DEFAULTS, PUBLIC_KINDS, PRIVATE_KINDS, KINDS, PLACE_ENTITIES,
  config, slug, isPublic, liveDeps, datesToSweep, eligibleStops, matchStop, promptFor, validateAnswer,
  keepPhoto, pickCover, renderBlock, replaceBlock, newPageMd, sweep, renderPlace, findPlaces, setKind, addDays,
};
