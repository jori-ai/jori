import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A synthetic installation: owner "Alex" (id alex), partner "Sam" (id sam).
const local = fs.mkdtempSync(path.join(os.tmpdir(), "watch-fit-"));
fs.mkdirSync(path.join(local, "config"));
fs.writeFileSync(path.join(local, "config", "watchlist.json"), JSON.stringify({ partner_id: "sam", partner_name: "Sam" }));
process.env.JORI_LOCAL_DIR = local;
process.env.JORI_OWNER_NAME = "Alex";
process.env.JORI_OWNER_ID = "alex";
const { judgeFit, fitState, ratingsDigest, prefLines } = await import("../lib/watch-fit.mjs");
const { combineRatings } = await import("../lib/watch-db.mjs");

const titles = [{ id: 1, name: "Heat", audience: "together" }, { id: 2, name: "Dune", audience: "solo" }, { id: 3, name: "Up", audience: "together" }];
const data = { titles, prefs: [], feedback: [{ title_id: 2, verdict: "loved", source: "chat" }],
  ratings: [{ title_id: 1, person: "alex", verdict: "loved" }, { title_id: 1, person: "sam", verdict: "meh" }, { title_id: 3, person: "sam", verdict: "not_watched" }] };
const cand = { name: "Collateral", kind: "movie", audience: "together", imdb: 7.5, rt: 86 };

test("ratingsDigest: per person by name, not_watched dropped, older verdicts shared", () => {
  const d = ratingsDigest(data);
  assert.deepEqual(d.alex, { loved: ["Heat"] });
  assert.deepEqual(d.sam, { meh: ["Heat"] });
  assert.deepEqual(d.shared, { loved: ["Dune"] });
});

test("prefLines: each pref carries the user's note, so a caveat reaches the judges", () => {
  const p = prefLines([
    { audience: "all", tag: "superhero", weight: -1.5, note: "avoid these unless outstanding (e.g. a festival winner)" },
    { audience: "solo", tag: "sci-fi", weight: 1, note: null },
  ]);
  assert.equal(p.together, "superhero -1.5 (avoid these unless outstanding (e.g. a festival winner))");
  assert.equal(p.solo, "superhero -1.5 (avoid these unless outstanding (e.g. a festival winner)); sci-fi +1");
  assert.equal(prefLines([]).sam, "(none)");
});

test("fitState names who it's for", () => {
  assert.equal(fitState(cand, { profile: "", prefs: {}, ratings: {} }).for, "Alex & Sam together");
  assert.equal(fitState({ ...cand, audience: "solo" }, { profile: "", prefs: {}, ratings: {} }).for, "Alex alone");
});

test("judgeFit: keep/drop from decide, legacy batch called once, fails closed", async () => {
  let legacyCalls = 0;
  const legacyBatch = async () => { legacyCalls++; return new Map([[0, { decision: "keep", reason: "close to Heat" }], [1, { decision: "drop", reason: "stretch" }]]); };
  const decide = async (o) => ({ value: await o.legacy(), used: "legacy" });
  const out = await judgeFit([cand, { ...cand, name: "Tracker" }], data, { decide, legacyBatch });
  assert.deepEqual(out.map((x) => x.keep), [true, false]);
  assert.equal(out[1].reason, "stretch");
  assert.equal(legacyCalls, 1);
  const boom = await judgeFit([cand], data, { decide: async () => { throw new Error("down"); }, legacyBatch });
  assert.equal(boom[0].keep, false);
});

test("combineRatings: solo → the owner's, together → floor of the mean", () => {
  const byId = new Map(titles.map((t) => [t.id, t]));
  const rows = combineRatings([
    { title_id: 1, person: "alex", verdict: "loved", updated_at: "2026-10-10T01:00:00Z" },
    { title_id: 1, person: "sam", verdict: "meh", updated_at: "2026-10-10T02:00:00Z" },
    { title_id: 2, person: "sam", verdict: "disliked", updated_at: "2026-10-10T01:00:00Z" },
    { title_id: 2, person: "alex", verdict: "liked", updated_at: "2026-10-10T01:00:00Z" },
    { title_id: 3, person: "alex", verdict: "not_watched", updated_at: "2026-10-10T01:00:00Z" },
  ], byId);
  const v = Object.fromEntries(rows.map((r) => [r.title_id, r.verdict]));
  assert.deepEqual(v, { 1: "liked", 2: "liked" });
  assert.equal(rows.find((r) => r.title_id === 1).created_at, "2026-10-10T02:00:00Z");
});

test("ratingsDigest: a verdict both gave is listed once under `both`, and no list is cut to 40", () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ id: 100 + i, name: `Film ${i}`, audience: "together" }));
  const rs = many.flatMap((t, i) => ["alex", "sam"].map((person) => ({ title_id: t.id, person, verdict: "liked", updated_at: `2026-10-10T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z` })));
  const d = ratingsDigest({ titles: [...titles, ...many], feedback: [], ratings: [...data.ratings, ...rs] });
  assert.equal(d.both.liked.length, 130);
  assert.ok(d.both.liked.includes("Film 0") && d.both.liked.includes("Film 129"));
  assert.equal(d.both.liked[0], "Film 129"); // most recently marked first
  assert.deepEqual(d.alex, { loved: ["Heat"] }); // they differ on Heat, so it stays per person
  assert.deepEqual(d.sam, { meh: ["Heat"] });
});
