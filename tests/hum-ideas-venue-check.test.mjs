// hum-ideas-venue-check.test.mjs — hum-ideas-append's venue check and as-of
// stamp. An idea that names a place carries `venue: {name, near}`; before it
// is stored the place is looked up on the map (an installation's
// lib/_ext/venue.mjs `lookupVenue`, injected here) and only a real, open
// listing near `near` is written. A name that matches no listing is the
// model's call (`judge`, stubbed); a lookup that fails holds the idea; a
// country-wide `near` is refused as too broad. "live" is never stored as the
// evidence as-of stamp. All places, ids and coordinates are invented
// (tests/fixtures/fake-geo.mjs); no test here calls a map API or a model.
// Run: node --test tests/hum-ideas-venue-check.test.mjs
import "./synthetic-instance.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { at } from "./fixtures/fake-geo.mjs";
import { checkVenue, judgeVenue } from "../bin/hum-ideas-append";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hum-venue-")); dirs.push(d); return d; };

const CREATED = "2026-10-17T23:06:00Z";
// A reservoir row of the shape the ideation agent writes; `venue` is what the playbook has the model add.
const GHOST = {
  id: "idea-ghost-tavern", created_at: CREATED, source: "hum-ideation-agent", category: "taste-match", idea_lens: "adapt",
  subject: "Tasca Fantasma, an old tavern in the market lanes, for a lunch",
  rationale: "Slow-cooked home food is a favourite and two such places are already on file; this would be a third.",
  why_now: "The stay in the old quarter runs another week and the flat is a short walk away.",
  urgency: 0.45, time_sensitive_until: "2099-10-30T23:59:00Z", draws_on: ["websearch", "memory"],
  supporting_data: { location_claim: { city: "Old Quarter", on: "2026-10-25" }, already_visited: ["Casa Azul", "Taberna Norte"], evidence_as_of: "live" },
  confidence: "low", verify_question: "Want one more slow-food lunch in the old quarter, at Tasca Fantasma, before you leave?",
};
const NEAR = "Old Quarter, Example City";
const C = at(0, 0);
const AREA = { lat: C.lat, lon: C.lon, label: "Old Quarter", span_km: 2 };
const L = (id, name, address, e, n, status = "OPERATIONAL") => ({ id, name, address, ...(({ lat, lon }) => ({ lat, lon }))(at(e, n)), status });
const MAP = {
  "Tasca Fantasma": [
    L("place-001", "Porto Velho", "Harbour side, Example City", -820, 230),
    L("place-002", "Hotel do Largo", "Main square, Example City", -440, 340),
    L("place-003", "Tasca Fina", "Uptown, Example City", 1150, 2290),
    L("place-004", "Laranjeira Suspensa", "Smiths' lane, Example City", -440, 400),
    L("place-005", "Luz do Bairro", "Star steps, Example City", -770, 460),
  ],
  "Casa Azul": [L("place-azul", "Casa Azul", "Garden quarter, Example City", -220, 540)],
};
const lookup = async ({ name }) => ({ area: AREA, candidates: MAP[name] || [] });
const noJudge = async () => { throw new Error("judge must not be consulted"); };

test("a name no listing near `near` carries is refused after the model judged them all; an exact name passes alone", async () => {
  const seen = [];
  const judge = async (venue, cands) => { seen.push(cands.map((c) => c.name)); return null; };
  assert.equal((await checkVenue({ name: "Tasca Fantasma", near: NEAR }, { lookup, judge })).rule, "venue-not-found");
  assert.deepEqual(seen, [MAP["Tasca Fantasma"].map((c) => c.name)]);
  const venue = { name: "Casa Azul", near: NEAR };
  assert.equal(await checkVenue(venue, { lookup, judge: noJudge }), null);
  assert.deepEqual([venue.place_id, venue.listing], ["place-azul", "Casa Azul"]);
});

test("another script is the model's call; a judge that cannot answer holds; a far twin, a closed one, an unknown `near` and a country-wide one refuse", async () => {
  const only = (...c) => async () => ({ area: c.length ? AREA : null, candidates: c });
  const check = (lk, judge = noJudge) => checkVenue({ name: "Casa Azul", near: NEAR }, { lookup: lk, judge });
  const otherScript = only(L("x1", "Κάσα Άζουλ", "Garden quarter", -220, 540));
  assert.equal(await check(otherScript, async () => 0), null);
  assert.equal((await check(otherScript, async () => { throw new Error("not_logged_in"); })).rule, "venue-unverified");
  assert.equal((await check(only(L("x2", "Casa Azul", "Far Town", 60000, 75000)))).rule, "venue-not-found");
  assert.ok((await check(only(L("x3", "Casa Azul", "Old Quarter", -220, 540, "CLOSED_PERMANENTLY")))).detail.includes("permanently closed"));
  assert.equal((await check(only())).rule, "schema");
  const country = async () => ({ area: { lat: C.lat, lon: C.lon, span_km: 220 }, candidates: MAP["Casa Azul"] });
  assert.equal((await checkVenue({ name: "Casa Azul", near: "Example Country" }, { lookup: country, judge: noJudge })).rule, "venue-near-too-broad");
});

test("judge: in its shadow week the Claude ladder's answer is the verdict; after it, a confident Jev decides", async () => {
  const cands = MAP["Tasca Fantasma"];
  const tpl = { type: "choice", instructions: "x", fixed_criteria: { none: "none" } };
  const jevSays = (pick) => async (o) => { if (o.alwaysShadow) o.legacy().catch(() => {}); return { value: pick, used: "jev" }; };
  const week = (until) => ({ venue_template: tpl, shadow_until: until });
  const venue = { name: "Tasca Fantasma", near: NEAR };
  assert.equal(await judgeVenue(venue, cands, { def: week("2099-01-01T00:00:00Z"), decide: jevSays("c2"), ladder: async () => "none" }), null);
  assert.equal(await judgeVenue(venue, cands, { def: week("2020-01-01T00:00:00Z"), decide: jevSays("c2"), ladder: async () => "none" }), 2);
  await assert.rejects(judgeVenue(venue, cands, { def: week("2099-01-01T00:00:00Z"), decide: jevSays("c2"), ladder: async () => { throw new Error("not_logged_in"); } }));
  assert.equal(await judgeVenue(venue, cands, { def: {}, decide: noJudge, ladder: async () => "c4" }), 4);
});

// The writer itself, through the hook it loads (HUM_VENUE_HOOK_DIR stands in for lib).
function append(ideas, hook) {
  const d = mk();
  const hookDir = path.join(d, "hook");
  fs.mkdirSync(path.join(hookDir, "_ext"), { recursive: true });
  fs.writeFileSync(path.join(hookDir, "_ext", "venue.mjs"), hook);
  const r = spawnSync(process.execPath, [path.join(HERE, "../bin/hum-ideas-append"), "--no-claim-check"], {
    input: ideas.map((i) => JSON.stringify(i)).join("\n"), encoding: "utf8",
    env: { ...process.env, JORI_DATA_DIR: d, HUM_IDEAS_NO_EMBED: "1", HUM_VENUE_HOOK_DIR: hookDir },
  });
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(d, "hum-ideas.jsonl");
  return { out: JSON.parse(r.stdout), rows: fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [] };
}
const AZUL_HOOK = `export async function lookupVenue({ name }) {
  if (name !== "Casa Azul") throw new Error("map month ceiling");
  return { area: ${JSON.stringify(AREA)}, candidates: ${JSON.stringify(MAP["Casa Azul"])} };
}`;
const idea = (o) => ({ ...GHOST, ...o });

test("hum-ideas-append: a real place is written with its listing, an unchecked one held, a place-less one untouched; no lookup installed = written, reported", () => {
  const { out, rows } = append([
    idea({ id: "idea-azul", subject: "Casa Azul for lunch", venue: { name: "Casa Azul", near: NEAR } }),
    idea({ id: "idea-ghost", venue: { name: "Tasca Fantasma", near: NEAR } }),
    idea({ id: "idea-bad-venue", venue: "Tasca Fantasma" }),
    idea({ id: "idea-no-place", subject: "Book the dentist", created_at: undefined }),
  ], AZUL_HOOK);
  assert.deepEqual(out.written, ["idea-azul", "idea-no-place"], JSON.stringify(out));
  assert.deepEqual(Object.fromEntries(out.rejected.map((x) => [x.id, x.rule])), { "idea-ghost": "venue-unverified", "idea-bad-venue": "schema" });
  assert.equal(rows[0].venue.place_id, "place-azul");
  assert.equal(rows[1].venue, undefined);
  // The as-of stamp: "live" is never stored; it becomes the idea's own creation time.
  assert.equal(rows[0].supporting_data.evidence_as_of, CREATED);
  assert.equal(rows[1].supporting_data.evidence_as_of, rows[1].created_at);
  assert.ok(Date.parse(rows[1].created_at) > Date.parse(CREATED));
  assert.equal(rows.length, 2);
  const bare = append([idea({ id: "idea-ghost", venue: { name: "Tasca Fantasma", near: NEAR } })], "export const nothing = 1;").out;
  assert.deepEqual([bare.written, bare.venue_unchecked], [["idea-ghost"], ["idea-ghost"]]);
});
