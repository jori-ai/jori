// place-pages: stops → places → pages and photo links. Run: node --test plugins/place-pages/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { at } from "../../../tests/fixtures/fake-geo.mjs";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const local = fs.mkdtempSync(path.join(os.tmpdir(), "place-pages-"));
fs.mkdirSync(path.join(local, "config"));
fs.writeFileSync(path.join(local, "config", "place-pages.json"), JSON.stringify({ exclude_names: ["Home (Main St)"] }));
process.env.JORI_LOCAL_DIR = local;
const require = createRequire(import.meta.url);
const pp = require(path.join(DIR, "lib", "place-pages.js"));

// ── A small PostgREST stand-in: enough of the filters this plugin and photo-repo use ──
function fakeDb(seed = {}) {
  const t = { places: [], place_visits: [], photo_links: [], photos: [], ...seed };
  const parseList = (v) => v.slice(1, -1).split(",").map((x) => x.replace(/^"|"$/g, "")); // test helper
  const test1 = (row, col, op) => {
    const v = row[col];
    if (op.startsWith("eq.")) return String(v) === op.slice(3);
    if (op.startsWith("neq.")) return String(v) !== op.slice(4);
    if (op.startsWith("in.")) return parseList(op.slice(3)).includes(String(v));
    if (op.startsWith("like.")) return String(v ?? "").startsWith(op.slice(5).replace(/\*$/, ""));
    if (op === "not.is.null") return v !== null && v !== undefined;
    if (op.startsWith("ov.")) { const want = op.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, "")); return (v || []).some((x) => want.includes(x)); }
    throw new Error(`fake db: unsupported filter ${col}=${op}`);
  };
  const match = (row, filters) => filters.every(([c, op]) => {
    if (c === "or") return op.slice(1, -1).split(",").some((part) => { const [cc, ...rest] = part.split("."); return test1(row, cc, rest.join(".")); });
    return test1(row, c, op);
  });
  const request = async (pq, { method = "GET", body } = {}) => {
    const [p, qs = ""] = pq.split("?");
    const table = p.replace("/rest/v1/", "");
    const params = qs ? qs.split("&").map((kv) => { const i = kv.indexOf("="); return [decodeURIComponent(kv.slice(0, i)), decodeURIComponent(kv.slice(i + 1))]; }) : [];
    const filters = params.filter(([k]) => !["select", "order", "limit", "on_conflict"].includes(k));
    const conflict = params.find(([k]) => k === "on_conflict")?.[1];
    const rows = t[table];
    if (!rows) throw new Error(`fake db: no table ${table}`);
    if (method === "GET") {
      let out = rows.filter((r) => match(r, filters));
      const order = params.find(([k]) => k === "order")?.[1];
      if (order) { const [col, dir] = order.split("."); out = [...out].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (dir === "desc" ? -1 : 1)); }
      return out.map((r) => ({ ...r }));
    }
    if (method === "DELETE") { t[table] = rows.filter((r) => !match(r, filters)); return []; }
    if (method === "PATCH") { for (const r of rows) if (match(r, filters)) Object.assign(r, body); return []; }
    if (method === "POST") {
      const keys = conflict ? conflict.split(",") : null;
      for (const b of body) {
        const i = keys ? rows.findIndex((r) => keys.every((k) => r[k] === b[k])) : -1;
        if (i >= 0) rows[i] = { ...rows[i], ...b }; else rows.push({ ...b });
      }
      return [];
    }
    throw new Error(`fake db: ${method}`);
  };
  return { t, request };
}

function fakeWiki(pages = {}) {
  const store = new Map(Object.entries(pages).map(([id, md]) => [id, md]));
  const fm = (md) => {
    const m = String(md).match(/^---\n([\s\S]*?)\n---/);
    const out = {};
    if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, ""); }
    return out;
  };
  return {
    store,
    getPage: (id) => (store.has(id) ? { id, type: "reference", raw_md: store.get(id), frontmatter_json: JSON.stringify(fm(store.get(id))) } : null),
    savePage: (id, md) => store.set(id, md),
    superseded: new Map(),
    supersedePage(oldId, newId) { this.superseded.set(oldId, newId); },
    // Like FTS5 unicode61: case- and accent-folded.
    searchPages: (q) => [...store.keys()].filter((id) => store.get(id).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().includes(q)).map((id) => ({ id, type: "reference", title: fm(store.get(id)).name || id, description: "" })),
  };
}

const DAY = {
  date: "2026-11-08",
  tz: "Etc/GMT+5",
  intervals: [
    { type: "stop", start: "2026-11-08T05:00:00Z", start_ts_ms: Date.parse("2026-11-08T05:00:00Z"), end: "2026-11-08T13:12:00Z", duration_min: 492,
      place: { name: "Home (Main St)", source: "user_confirmed", confidence: 1, ...at(-200, -150) }, photos: [] },
    { type: "stop", start: "2026-11-08T13:15:25Z", start_ts_ms: Date.parse("2026-11-08T13:15:25Z"), end: "2026-11-08T14:00:30Z", end_ts_ms: Date.parse("2026-11-08T14:00:30Z"), duration_min: 45,
      place: { name: "Corner Café", source: "user_confirmed", confidence: 1, ...at(0, 0) }, companions: ["Ada", "Ben"],
      photos: [{ uuid: "P1" }, { uuid: "P2" }, { uuid: "S1" }] },
    { type: "stop", start: "2026-11-09T00:03:00Z", start_ts_ms: Date.parse("2026-11-09T00:03:00Z"), end: "2026-11-09T00:13:00Z", duration_min: 10,
      place: { name: "12 Example St", source: "spine_dwell", confidence: 0.85, ...at(300, -300) }, photos: [] },
    { type: "stop", start: "2026-11-09T00:27:00Z", start_ts_ms: Date.parse("2026-11-09T00:27:00Z"), end: "2026-11-09T02:18:00Z", duration_min: 111,
      place: { name: "Grand Theatre", source: "calendar_corroborated", confidence: 0.9, ...at(1500, 4000) }, photos: [{ uuid: "P3" }] },
    { type: "stop", start: "2026-11-09T03:00:00Z", start_ts_ms: Date.parse("2026-11-09T03:00:00Z"), end: "2026-11-09T03:40:00Z", duration_min: 40,
      place: { name: "Joe Coffee", source: "osm_overpass", confidence: 0.8, ...at(-500, -400) }, photos: [] },
  ],
};

const PHOTOS = [
  { uuid: "P1", taken_at: "2026-11-08T13:33:06Z", thumb_url: "https://x/thumbs/P1.jpg", self_captured: true, media_type: "photo", labels: ["dog", "people", "table"], persons: [] },
  { uuid: "P2", taken_at: "2026-11-08T13:33:10Z", thumb_url: null, self_captured: true, media_type: "photo", labels: ["food", "plate"], persons: [] },
  { uuid: "S1", taken_at: "2026-11-08T13:40:00Z", thumb_url: "https://x/thumbs/S1.jpg", self_captured: false, media_type: "screenshot", labels: [], persons: [] },
  { uuid: "P3", taken_at: "2026-11-09T00:38:28Z", thumb_url: "https://x/thumbs/P3.jpg", self_captured: true, media_type: "photo", labels: ["receipt", "document"], persons: [] },
];

function deps({ db, wiki, answer, ladderCalls = [] }) {
  return {
    request: db.request, wiki, now: () => Date.parse("2026-11-10T16:00:00Z"),
    liveDay: (d) => (d === DAY.date ? DAY : null),
    archiveDates: () => [DAY.date],
    // Like `photos thumb-url`: uploads the thumbnail and writes photos.thumb_url.
    ensureThumb: (uuid) => { const url = `https://x/thumbs/${uuid}.jpg`; const row = db.t.photos.find((p) => p.uuid === uuid); if (row) row.thumb_url = url; return url; },
    ladder: async (prompt, validate) => {
      ladderCalls.push(prompt);
      const value = answer(prompt);
      const err = validate(value);
      return err ? { value: null, errors: [err] } : { value, rung: "local" };
    },
    shows: () => null,
  };
}

test("eligibleStops keeps long stops with a settled name or a confident guess, and marks the user's own homes", () => {
  const s = pp.eligibleStops(DAY, { ...pp.config() });
  assert.deepEqual(s.map((x) => x.name), ["Home (Main St)", "Corner Café", "Grand Theatre"]);
  assert.equal(s[0].excluded, true);
  assert.deepEqual(s[1].photo_uuids, ["P1", "P2", "S1"]);
  assert.equal(s[1].key, `2026-11-08:${Date.parse("2026-11-08T13:15:25Z")}`);
});

test("matchStop: the same folded name nearby is the same place; a different name close by goes to the model", () => {
  const places = [{ id: "pl_a", name: "Corner Café", norm_names: ["corner cafe"], ...at(8, 11), kind: "cafe" }];
  const stop = { norm: "corner cafe", ...at(0, 0) };
  assert.equal(pp.matchStop(stop, places).place.id, "pl_a");
  const other = pp.matchStop({ norm: "the corner", ...at(0, 0) }, places);
  assert.equal(other.place, null);
  assert.equal(other.near[0].id, "pl_a");
  // A branch of a chain far away is not the same place.
  assert.equal(pp.matchStop({ norm: "corner cafe", ...at(3000, 6000) }, places).place, null);
});

test("validateAnswer refuses kinds, places and pages it was not offered", () => {
  const items = [{ i: 0, near: [{ id: "pl_a" }], pages: [{ id: "restaurant_x" }] }];
  assert.equal(pp.validateAnswer({ stops: [{ i: 0, kind: "cafe", same_as: null, page: null }] }, items), null);
  assert.match(pp.validateAnswer({ stops: [{ i: 0, kind: "coffee shop" }] }, items), /kind/);
  assert.match(pp.validateAnswer({ stops: [{ i: 0, kind: "cafe", same_as: "pl_zzz" }] }, items), /same_as/);
  assert.match(pp.validateAnswer({ stops: [{ i: 0, kind: "cafe", page: "user_bob" }] }, items), /page/);
  assert.match(pp.validateAnswer({ stops: [] }, items), /no answer/); // lang-regex-ok: matches our own validator error string
  assert.match(pp.validateAnswer({ stops: [{ i: 0, kind: "rental", title: 42 }] }, items), /title/); // lang-regex-ok: matches our own validator error string
});

test("keepPhoto keeps only the user's own camera shots, never screenshots or receipts; pickCover prefers a pin, a favorite, then no people", () => {
  const cfg = pp.config();
  assert.equal(pp.keepPhoto(PHOTOS[0], cfg), true);
  assert.equal(pp.keepPhoto(PHOTOS[2], cfg), false);
  assert.equal(pp.keepPhoto(PHOTOS[3], cfg), false);
  const linked = [{ role: "gallery", photo: { ...PHOTOS[0] } }, { role: "gallery", photo: { ...PHOTOS[1], thumb_url: "u2" } }];
  assert.equal(pp.pickCover(linked, cfg).uuid, "P2");
  assert.equal(pp.pickCover([{ ...linked[0], photo: { ...PHOTOS[0], favorite: true } }, linked[1]], cfg).uuid, "P1");
  assert.equal(pp.pickCover([linked[0], { ...linked[1], role: "cover" }], cfg).uuid, "P2");
});

test("a dry run writes nothing", async () => {
  const db = fakeDb({ photos: PHOTOS.map((p) => ({ ...p })) });
  const wiki = fakeWiki();
  const r = await pp.sweep({ date: DAY.date, deps: deps({ db, wiki, answer: (p) => ({ stops: [{ i: 0, kind: "cafe", same_as: null, page: null }, { i: 1, kind: "theater", same_as: null, page: null }] }) }) });
  assert.equal(r.stops, 3);
  assert.equal(db.t.places.length, 0);
  assert.equal(db.t.photo_links.length, 0);
  assert.equal(wiki.store.size, 0);
});

test("a sweep files places, gives public ones pages, links the user's photos once, and a re-sweep changes nothing", async () => {
  const db = fakeDb({ photos: PHOTOS.map((p) => ({ ...p })) });
  const wiki = fakeWiki();
  const calls = [];
  const answer = (prompt) => {
    // Answer in the order the stops are listed: "[0] "Corner Café"", "[1] "Grand Theatre"".
    const idx = (name) => Number(prompt.match(new RegExp(`\\[(\\d+)\\] "${name}"`))[1]); // lang-regex-ok: reads our own prompt layout
    return { stops: [{ i: idx("Corner Café"), kind: "cafe", same_as: null, page: null }, { i: idx("Grand Theatre"), kind: "theater", same_as: null, page: null }] };
  };
  const r = await pp.sweep({ date: DAY.date, apply: true, deps: deps({ db, wiki, answer, ladderCalls: calls }) });
  assert.equal(r.errors.length, 0, r.errors.join("\n"));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Home \(Main St\)/); // the user's homes are named to the model as theirs
  assert.deepEqual(r.new_places.map((p) => p.page_id).sort(), ["place_corner_cafe", "place_grand_theatre"]);
  // Home is excluded by name before the model: no place row, no page.
  assert.equal(db.t.places.length, 2);
  // Corner Café: two camera shots linked (the screenshot is not); the missing thumbnail was made.
  const bar = db.t.places.find((p) => p.name === "Corner Café");
  assert.equal(r.thumbs_made, 1);
  assert.deepEqual(db.t.photo_links.filter((l) => l.target === "place_corner_cafe").map((l) => l.photo_uuid).sort(), ["P1", "P2"]);
  // The receipt at the theatre is not linked; its page still lists the visit.
  assert.equal(db.t.photo_links.filter((l) => l.target === "place_grand_theatre").length, 0);
  const page = wiki.store.get("place_corner_cafe");
  assert.match(page, /entity: place/);
  assert.match(page, /kind: cafe/);
  assert.match(page, /\*\*Sunday, November 8, 2026\*\* · 8:15am–9:00am \(45 min\) · with Ada, Ben/);
  assert.match(page, /!\[Corner Café\]\(https:\/\/x\/thumbs\/P2\.jpg\)/); // cover: the photo without people
  assert.equal(bar.cover_uuid, "P2");
  assert.equal(bar.visit_count, 1);
  assert.equal(bar.photo_count, 2);
  // Run it again: no model call, no new rows, the same page.
  const before = JSON.stringify([db.t.places.map((p) => ({ ...p, updated_at: null })), db.t.place_visits, db.t.photo_links.map((l) => ({ ...l, added_at: null })), [...wiki.store]]);
  const r2 = await pp.sweep({ date: DAY.date, apply: true, deps: deps({ db, wiki, answer, ladderCalls: calls }) });
  assert.equal(calls.length, 1);
  assert.equal(r2.matched, 2);
  const after = JSON.stringify([db.t.places.map((p) => ({ ...p, updated_at: null })), db.t.place_visits, db.t.photo_links.map((l) => ({ ...l, added_at: null })), [...wiki.store]]);
  assert.equal(after, before);
});

test("an adopted page keeps its own text; only the block between the markers is ours", async () => {
  const db = fakeDb({ photos: PHOTOS.map((p) => ({ ...p })) });
  const lounge = "---\nname: \"Corner Café\"\nentity: lounge\n---\n# Corner Café\n\nHis notes stay.\n";
  const wiki = fakeWiki({ lounge_corner_cafe: lounge });
  const answer = (prompt) => {
    const idx = (name) => Number(prompt.match(new RegExp(`\\[(\\d+)\\] "${name}"`))[1]); // lang-regex-ok: reads our own prompt layout
    return { stops: [{ i: idx("Corner Café"), kind: "lounge", same_as: null, page: "lounge_corner_cafe" }, { i: idx("Grand Theatre"), kind: "theater", same_as: null, page: null }] };
  };
  const r = await pp.sweep({ date: DAY.date, apply: true, deps: deps({ db, wiki, answer }) });
  assert.equal(r.errors.length, 0, r.errors.join("\n"));
  const md = wiki.store.get("lounge_corner_cafe");
  assert.ok(md.startsWith(lounge.trimEnd()));
  assert.match(md, /## Photos/);           // an adopted page gets photos by visit, not a second visit list
  assert.doesNotMatch(md, /## Visits/);
  assert.ok(!wiki.store.has("place_corner_cafe"));
});

test("a day re-swept after a correction moves the photos with the stop", async () => {
  const db = fakeDb({ photos: PHOTOS.map((p) => ({ ...p })) });
  const wiki = fakeWiki();
  const answer = (prompt) => {
    const items = [...prompt.matchAll(/\[(\d+)\] "([^"]+)"/g)].map((m) => ({ i: Number(m[1]), name: m[2] }));
    return { stops: items.map((it) => ({ i: it.i, kind: it.name === "Grand Theatre" ? "theater" : "cafe", same_as: null, page: null })) };
  };
  await pp.sweep({ date: DAY.date, apply: true, deps: deps({ db, wiki, answer }) });
  // The user renames the morning stop: the day now says Café Nine.
  DAY.intervals[1].place.name = "Café Nine";
  try {
    await pp.sweep({ date: DAY.date, apply: true, deps: deps({ db, wiki, answer }) });
  } finally {
    DAY.intervals[1].place.name = "Corner Café";
  }
  assert.deepEqual(db.t.photo_links.filter((l) => l.target === "place_corner_cafe"), []);
  assert.deepEqual(db.t.photo_links.filter((l) => l.target === "place_cafe_nine").map((l) => l.photo_uuid).sort(), ["P1", "P2"]);
  assert.match(wiki.store.get("place_corner_cafe"), /No visits on record/);
});

test("a generic stop name gets the model's title; the stop's own words stay an alias", async () => {
  const db = fakeDb({ photos: PHOTOS.map((p) => ({ ...p })) });
  const wiki = fakeWiki();
  const answer = (prompt) => {
    const items = [...prompt.matchAll(/\[(\d+)\] "([^"]+)"/g)].map((m) => ({ i: Number(m[1]), name: m[2] })); // lang-regex-ok: reads our own prompt layout
    return { stops: items.map((it) => ({ i: it.i, kind: it.name === "Corner Café" ? "rental" : "theater", same_as: null, page: null, title: it.name === "Corner Café" ? "Rental, Example Town" : null })) };
  };
  const r = await pp.sweep({ date: DAY.date, apply: true, deps: deps({ db, wiki, answer }) });
  assert.equal(r.errors.length, 0, r.errors.join("\n"));
  const place = db.t.places.find((p) => p.kind === "rental");
  assert.equal(place.name, "Rental, Example Town");
  assert.deepEqual(place.names, ["Rental, Example Town", "Corner Café"]);
  assert.ok(wiki.store.has("place_rental_example_town"));
  // The next sweep matches the stop by its own words, with no model call.
  const r2 = await pp.sweep({ date: DAY.date, apply: true, deps: deps({ db, wiki, answer: () => { throw new Error("no model call expected"); } }) });
  assert.equal(r2.matched, 2);
});

test("only pages about a place are offered for adoption, never a rule or list that mentions it", async () => {
  const db = fakeDb({ photos: PHOTOS.map((p) => ({ ...p })) });
  const wiki = fakeWiki({
    feedback_corner_cafe_access: "---\nname: \"Corner Café access\"\ntype: feedback\n---\nHow to get into Corner Café.\n",
    lounge_corner_cafe: "---\nname: \"Corner Café\"\nentity: lounge\n---\n# Corner Café\n",
  });
  const prompts = [];
  const answer = (prompt) => {
    prompts.push(prompt);
    const items = [...prompt.matchAll(/\[(\d+)\] "([^"]+)"/g)].map((m) => ({ i: Number(m[1]), name: m[2] })); // lang-regex-ok: reads our own prompt layout
    return { stops: items.map((it) => ({ i: it.i, kind: "theater", same_as: null, page: null })) };
  };
  await pp.sweep({ date: DAY.date, deps: deps({ db, wiki, answer }) });
  assert.match(prompts[0], /lounge_corner_cafe/);
  assert.doesNotMatch(prompts[0], /feedback_corner_cafe_access/);
});

test("a stop through the small hours at a daytime place is not a visit; at a bar it is", async () => {
  assert.equal(pp.overlapsSmallHours("2026-10-21T21:54:00Z", "2026-10-22T06:16:00Z", "Etc/GMT-3"), true);  // 00:54–09:16 local
  assert.equal(pp.overlapsSmallHours("2026-10-21T21:00:00Z", "2026-10-21T22:05:00Z", "Etc/GMT-3"), false); // 00:00–01:05 local
  assert.equal(pp.overlapsSmallHours("2026-10-25T07:05:00Z", "2026-10-25T10:29:00Z", "Etc/GMT-3"), false);
  const night = { type: "stop", start: "2026-11-08T07:00:00Z", start_ts_ms: Date.parse("2026-11-08T07:00:00Z"), end: "2026-11-08T12:00:00Z", duration_min: 300,
    place: { name: "Corner Café", source: "user_confirmed", confidence: 1, ...at(5, 5) }, photos: [] };
  DAY.intervals.push(night);
  try {
    for (const kind of ["cafe", "bar"]) {
      const db = fakeDb({ photos: PHOTOS.map((p) => ({ ...p })) });
      const wiki = fakeWiki();
      const answer = (prompt) => {
        const items = [...prompt.matchAll(/\[(\d+)\] "([^"]+)"/g)].map((m) => ({ i: Number(m[1]), name: m[2] })); // lang-regex-ok: reads our own prompt layout
        return { stops: items.map((it) => ({ i: it.i, kind: it.name === "Corner Café" ? kind : "theater", same_as: null, page: null })) };
      };
      const r = await pp.sweep({ date: DAY.date, apply: true, deps: deps({ db, wiki, answer }) });
      const place = db.t.places.find((p) => p.name === "Corner Café");
      const visits = db.t.place_visits.filter((v) => v.place_id === place.id).length;
      if (kind === "cafe") { assert.equal(visits, 1); assert.equal(r.skipped_small_hours.length, 1); }
      else { assert.equal(visits, 2); assert.equal(r.skipped_small_hours.length, 0); }
    }
  } finally {
    DAY.intervals.pop();
  }
});

test("rename: our own page is retitled in place; a page made under a broken name is replaced and its photos move", async () => {
  const db = fakeDb({ photos: PHOTOS.map((p) => ({ ...p })) });
  const wiki = fakeWiki();
  const answer = (prompt) => {
    const items = [...prompt.matchAll(/\[(\d+)\] "([^"]+)"/g)].map((m) => ({ i: Number(m[1]), name: m[2] })); // lang-regex-ok: reads our own prompt layout
    return { stops: items.map((it) => ({ i: it.i, kind: it.name === "Corner Café" ? "cafe" : "theater", same_as: null, page: null })) };
  };
  const d = deps({ db, wiki, answer });
  await pp.sweep({ date: DAY.date, apply: true, deps: d });
  const cafe = db.t.places.find((p) => p.name === "Corner Café");
  // Our own page: same id, new title, the old name kept as an alias.
  await pp.rename(cafe.id, "Corner Coffee Bar", { deps: d });
  assert.match(wiki.store.get("place_corner_cafe"), /^name: "Corner Coffee Bar"$/m);
  assert.match(wiki.store.get("place_corner_cafe"), /^# Corner Coffee Bar$/m);
  assert.deepEqual(db.t.places.find((p) => p.id === cafe.id).names, ["Corner Coffee Bar", "Corner Café"]);
  // A tracker-style page titled with the broken name: a new page, links moved, the old one superseded.
  const theatre = db.t.places.find((p) => p.name === "Grand Theatre");
  wiki.store.set("restaurant_grand_theatre_id_9", "---\nname: \"Grand Theatre\"\nentity: restaurant\n---\n# Grand Theatre\n");
  theatre.page_id = "restaurant_grand_theatre_id_9";
  db.t.photo_links.push({ photo_uuid: "P1", target: "restaurant_grand_theatre_id_9", role: "gallery", context: "x", added_by: "place-pages" });
  const r = await pp.rename(theatre.id, "Grand Hall", { deps: d });
  assert.deepEqual(r.moved, { from: "restaurant_grand_theatre_id_9", to: "place_grand_hall" });
  assert.equal(wiki.superseded.get("restaurant_grand_theatre_id_9"), "place_grand_hall");
  assert.equal(db.t.photo_links.find((l) => l.context === "x").target, "place_grand_hall");
});
