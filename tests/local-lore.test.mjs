// local-lore — the local-history harvester (lib/local-lore.mjs): ≤300 m at
// harvest, never a subject already told. The ledger and delivery rules are in
// local-history.test.mjs. Synthetic coordinates; sources stubbed, no network.
// Run: node --test tests/local-lore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mergeSubjects, localLore } from "../lib/local-lore.mjs";

// A landmark and points due north of it.
const TOWER = { lat: 10.00000, lon: 20.00000 };
const north = (m) => ({ lat: TOWER.lat + m / 111320, lon: TOWER.lon });

test("harvest: subject at 250 m kept, 350 m dropped", () => {
  const me = TOWER;
  const near = { id: "wp:en:1", qid: null, title: "Near thing", ...north(250), summary: "x" };
  const far = { id: "wp:en:2", qid: null, title: "Far thing", ...north(350), summary: "y" };
  const osmFar = { id: "osm:node/9", title: "Far monument", ...north(351), facts: {}, kind: "historic=monument" };
  const out = mergeSubjects({ lat: me.lat, lon: me.lon, wiki: [near, far], osm: [osmFar] });
  assert.deepEqual(out.map((s) => s.title), ["Near thing"]);
});

test("localLore drops told subjects and anything past 300 m (stubbed sources, no network)", () => {
  const entries = [{ ping_id: "p", sent_at: new Date().toISOString(), title: "Told", ids: ["Q9"], lat: 0, lon: 0 }];
  const r = localLore(TOWER.lat, TOWER.lon, {
    ledger: entries,
    deps: {
      placeLore: () => ({ items: [
        { id: "wp:en:1", qid: "Q9", title: "Told", ...north(100), summary: "a" },
        { id: "wp:en:2", qid: "Q10", title: "Fresh", ...north(200), summary: "b" },
        { id: "wp:en:3", qid: "Q11", title: "Too far", ...north(400), summary: "c" },
      ] }),
      qidLore: () => null,
      osmLore: () => [{ id: "osm:node/1", title: "Fresh", qid: "Q10", ...north(201), facts: { start_date: "1900" }, kind: "historic=building" }],
    },
  });
  assert.deepEqual(r.items.map((i) => i.title), ["Fresh"]);
  assert.ok(r.items[0].ids.includes("osm:node/1"), "OSM twin merged into the article");
  assert.equal(r.told[0].title, "Told");
});
