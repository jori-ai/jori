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

test("judgeFit: a title the batch judgement left out is a drop, marked unjudged", async () => {
  const legacyBatch = async () => new Map([[0, { decision: "keep", reason: "close to Heat" }]]);
  const decide = async (o) => ({ value: await o.legacy(), used: "legacy" });
  const out = await judgeFit([cand, { ...cand, name: "Tracker" }], data, { decide, legacyBatch });
  assert.deepEqual(out.map((x) => [x.keep, x.judged]), [[true, true], [false, false]]);
  const jev = await judgeFit([cand], data, { decide: async () => ({ value: "drop", used: "jev" }), legacyBatch });
  assert.deepEqual([jev[0].keep, jev[0].judged], [false, true]);
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

// --- the review check for shows too new for a settled IMDb rating (2026-11-09) ---------
const { judgeQuality, qualityState, hasEvidence, receptionSummary, receptionPrompt, QUALITY_DEF } = await import("../lib/watch-fit.mjs");
const BAR = "IMDb 7.5 or higher (on 1,000+ votes)";
const show = (name, extra = {}) => ({ name, year: 2026, genres: "Crime, Drama", platform: "Apple TV+", finale: "2026-11-05", synopsis: "A heist goes wrong.", imdb: null, imdb_votes: null, rt: null, metacritic: null, tmdb_average: null, tmdb_votes: 3, ...extra });

test("qualityState prefers what code already has, fills the rest from the search, and keeps a thin IMDb rating", () => {
  const s = qualityState(show("Lucky", { imdb: 8.1, imdb_votes: 420, rt: 91 }), { scores: { rt_critics: 60, rt_audience: 85, metacritic: 77 }, consensus: "Taut and stylish.", sources: ["Rotten Tomatoes", "Variety"] }, BAR);
  assert.equal(s.bar, BAR);
  assert.deepEqual(s.evidence.imdb, { rating: 8.1, votes: 420 });
  assert.equal(s.evidence.rotten_tomatoes_critics, 91);
  assert.equal(s.evidence.rotten_tomatoes_audience, 85);
  assert.equal(s.evidence.metacritic, 77);
  assert.equal(s.evidence.tmdb.votes, 3);
  assert.equal(receptionSummary(s), "Rotten Tomatoes 91% (audience 85%), Metacritic 77, IMDb 8.1 on 420 votes; sources: Rotten Tomatoes, Variety; critics: Taut and stylish.");
});

test("hasEvidence: a TMDB average on a handful of votes alone is not evidence", () => {
  assert.equal(hasEvidence(qualityState(show("X", { tmdb_average: 9, tmdb_votes: 3 }), null, BAR)), false);
  assert.equal(hasEvidence(qualityState(show("X", { tmdb_average: 8, tmdb_votes: 12 }), null, BAR)), true);
  assert.equal(hasEvidence(qualityState(show("X"), { consensus: "Glowing reviews." }, BAR)), true);
  assert.equal(receptionSummary(qualityState(show("X"), null, BAR)), "no reviews or scores found yet");
});

test("receptionPrompt lists every show with what is known and asks for found numbers only", () => {
  const p = receptionPrompt([show("Lucky", { rt: 91 })], { bar: BAR, today: "2026-11-09" });
  assert.ok(p.includes('"title": "Lucky"') && p.includes('"rotten_tomatoes": 91'));
  assert.ok(p.includes(BAR) && p.includes("never estimate a score"));
});

test("judgeQuality: Jev decides on the evidence, the search's verdict is the fallback, no evidence is too_early", async () => {
  const cands = [show("Strong"), show("Weak"), show("Unknown"), show("Fallback")];
  const research = async () => new Map([
    [0, { scores: { rt_critics: 96, rt_audience: 90 }, consensus: "A triumph.", sources: ["Rotten Tomatoes"], verdict: "clears", equivalent_imdb: 8.3 }],
    [1, { scores: { rt_critics: 55 }, consensus: "Uneven.", verdict: "below" }],
    [3, { scores: { metacritic: 82 }, verdict: "clears" }],
  ]);
  const asked = [];
  const decide = async (o) => {
    asked.push(o.id);
    assert.equal(o.site, "watchlist-quality");
    assert.deepEqual(Object.keys(o.questions), ["reception"]);
    assert.equal(o.state.bar, BAR);
    if (o.id === "Fallback") return { value: await o.legacy(), used: "legacy" };
    return { value: o.interpret({ reception: { choice: o.id === "Strong" ? "clears" : "below", probabilities: { clears: 0.95 } } }).value, used: "jev" };
  };
  const v = await judgeQuality(cands, { bar: BAR, today: "2026-11-09" }, { research, decide });
  assert.deepEqual(asked, ["Strong", "Weak", "Fallback"], "no decision is asked without evidence");
  assert.deepEqual(v.map((x) => [x.verdict, x.used, x.judged]), [["clears", "jev", true], ["below", "jev", true], ["too_early", "none", true], ["clears", "legacy", true]]);
  assert.equal(v[0].equivalent, 8.3);
  assert.ok(v[0].reason.startsWith("Rotten Tomatoes 96% (audience 90%)"));
});

test("judgeQuality: a failed search holds every show and is not remembered as a verdict", async () => {
  const v = await judgeQuality([show("A")], { bar: BAR, today: "2026-11-09" }, { research: async () => { throw new Error("timeout"); }, decide: async () => assert.fail("no decision without evidence") });
  assert.equal(v[0].verdict, "too_early");
  assert.equal(v[0].judged, false);
  // Evidence on file but the search failed: Jev may still decide; with no Jev answer the
  // legacy throws and the show is held, unremembered.
  const w = await judgeQuality([show("B", { rt: 92 })], { bar: BAR, today: "2026-11-09" }, {
    research: async () => { throw new Error("timeout"); },
    decide: async (o) => ({ value: await o.legacy(), used: "legacy" }),
  });
  assert.deepEqual([w[0].verdict, w[0].judged], ["too_early", false]);
});

test("judgeQuality: an implausible estimate read off the web is dropped", async () => {
  const v = await judgeQuality([show("A", { rt: 95 })], { bar: BAR, today: "2026-11-09" }, {
    research: async () => new Map([[0, { verdict: "clears", equivalent_imdb: 85 }]]),
    decide: async (o) => ({ value: await o.legacy(), used: "legacy" }),
  });
  assert.deepEqual([v[0].verdict, v[0].equivalent], ["clears", null]);
});

test("QUALITY_DEF is a generic choice question over the three answers", () => {
  const q = QUALITY_DEF.questions.reception;
  assert.equal(q.type, "choice");
  assert.deepEqual(Object.keys(q.criteria), ["clears", "below", "too_early"]);
});
