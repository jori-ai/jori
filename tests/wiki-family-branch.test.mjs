// Which side of the family a person is on, walked from typed relations
// (lib/wiki-family-branch.mjs). The case: 2026-10-29, a who's-who for a family
// dinner mixed the owner's aunt's branch with the spouse's cousins ("Can't mix
// these meetups").

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { familyBranches, describeBranch, loadFamilyBranches, buildGraph } from "../lib/wiki-family-branch.mjs";

const F = (src_id, rel, dst_id) => ({ src_id, rel, dst_id });

// The owner (o) married to s. o's father f has a sister (aunt) a, married to au,
// with a daughter c (o's cousin) who has a son cc. s's mother m has a niece n
// (written as a stated relative, the way pages often put it) whose brother is
// nb, and nb's wife nw. o and s have two children k1, k2; k1 has a fiancée kf.
// x and y share a surname with the aunt's family and nothing else.
const FACTS = [
  F("o", "spouse_of", "s"),
  F("f", "parent_of", "o"),
  F("a", "sibling_of", "f"),
  F("a", "spouse_of", "au"),
  F("c", "child_of", "a"),
  F("cc", "child_of", "c"),
  F("m", "parent_of", "s"),
  F("n", "relative_of", "m"),
  F("nb", "sibling_of", "n"),
  F("nb", "spouse_of", "nw"),
  F("k1", "child_of", "o"), F("k1", "child_of", "s"),
  F("k2", "child_of", "o"), F("s", "parent_of", "k2"),
  F("k1", "sibling_of", "k2"),
  F("k1", "partner_of", "kf"),
];

const run = (facts = FACTS, opts = {}) => familyBranches(facts, { owner: "o", spouse: "s", ids: ["x", "y"], ...opts });

test("the owner's aunt's branch is the owner's side; the spouse's relatives are the spouse's", () => {
  const b = run();
  for (const id of ["f", "a", "c", "cc"]) assert.equal(b.get(id).branch, "owner", id);
  assert.equal(b.get("au").branch, "owner", "the aunt's husband is an in-law on the owner's side");
  assert.equal(b.get("au").owner.tier, 2);
  for (const id of ["m", "n", "nb", "nw"]) assert.equal(b.get(id).branch, "spouse", id);
  assert.equal(b.get("n").spouse.tier, 3, "a stated relative_of is the weakest tier");
  assert.equal(b.get("o").branch, "owner");
  assert.equal(b.get("s").branch, "spouse");
});

test("the couple's children are both sides, and do not carry either family into the other", () => {
  const b = run();
  assert.equal(b.get("k1").branch, "both");
  assert.equal(b.get("k2").branch, "both");
  assert.equal(b.get("kf").branch, "both", "a child's partner is an in-law of both");
  // Walking down to the children never walks back up to the other parent's family.
  assert.equal(b.get("m").owner, null);
  assert.equal(b.get("a").spouse, null);
});

test("missing relations are unknown, never a guess from a name", () => {
  const b = run();
  assert.equal(b.get("x").branch, "unknown");
  assert.equal(b.get("y").branch, "unknown");
  assert.match(describeBranch(b.get("x")), /^unknown/);
});

test("a blood path on one side beats a stated relative_of on the other", () => {
  // The owner's nephew, written as relative_of both the owner and the spouse
  // ("nephew of o and s"), with a child_of edge to the owner's sister.
  const facts = [...FACTS, F("sis", "sibling_of", "o"), F("nep", "child_of", "sis"), F("nep", "relative_of", "o"), F("nep", "relative_of", "s")];
  const b = run(facts);
  assert.equal(b.get("nep").branch, "owner");
  assert.equal(b.get("nep").owner.tier, 1);
  // With only the two relative_of lines, it is honestly both.
  const only = run([...FACTS, F("nep2", "relative_of", "o"), F("nep2", "relative_of", "s")]);
  assert.equal(only.get("nep2").branch, "both");
});

test("a stated relative's family does not walk through someone on the other side", () => {
  // r is a stated relative of the spouse and the sibling of the owner's aunt's
  // daughter: the aunt's family stays the owner's.
  const b = run([...FACTS, F("r", "relative_of", "s"), F("r", "sibling_of", "c")]);
  assert.equal(b.get("c").branch, "owner");
  assert.equal(b.get("cc").branch, "owner");
});

test("a hub page never joins two people", () => {
  const facts = [F("o", "spouse_of", "s"), F("hub", "relative_of", "o"), F("hub", "relative_of", "q")];
  const persons = new Set(["o", "s", "q"]);
  assert.equal(familyBranches(facts, { owner: "o", spouse: "s", persons, ids: ["q"] }).get("q").branch, "unknown");
  assert.equal(familyBranches(facts, { owner: "o", spouse: "s", ids: ["q"] }).get("q").branch, "owner", "without the person filter the hub would");
  assert.equal(buildGraph(facts, persons).nodes.has("hub"), false);
});

test("the path says how the branch was decided", () => {
  const line = describeBranch(run().get("c"), { ownerName: "Owner", spouseName: "Spouse" });
  assert.equal(line, "Owner's side, blood: child_of a → sibling_of f → parent_of o");
  assert.match(describeBranch(run().get("k1"), { ownerName: "Owner", spouseName: "Spouse" }), /^both sides/);
});

test("loadFamilyBranches reads current facts and person pages from the wiki DB, and finds the spouse", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-branch-"));
  const d = new DatabaseSync(path.join(dir, "m.db"));
  d.exec(`CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT, frontmatter_json TEXT, status TEXT);
          CREATE TABLE page_facts (src_id TEXT, rel TEXT, dst_id TEXT, expired_at TEXT, invalid_at TEXT);`);
  const page = d.prepare("INSERT INTO pages VALUES (?, ?, ?, 'active')");
  for (const id of ["o", "s", "f", "a", "m", "old"]) page.run(id, id.toUpperCase(), JSON.stringify({ entity: "person" }));
  page.run("hub", "Hub", JSON.stringify({ entity: "people-hub" }));
  const fact = d.prepare("INSERT INTO page_facts VALUES (?, ?, ?, ?, NULL)");
  fact.run("o", "spouse_of", "s", null);
  fact.run("f", "parent_of", "o", null);
  fact.run("a", "sibling_of", "f", null);
  fact.run("m", "parent_of", "s", null);
  fact.run("old", "sibling_of", "o", "2026-01-01"); // expired: no longer asserted
  fact.run("hub", "relative_of", "m", null);
  const prev = process.env.WIKI_OWNER_PAGE;
  process.env.WIKI_OWNER_PAGE = "o";
  try {
    const L = loadFamilyBranches({ d });
    assert.equal(L.owner, "o");
    assert.equal(L.spouse, "s");
    assert.equal(L.branches.get("a").branch, "owner");
    assert.equal(L.branches.get("m").branch, "spouse");
    assert.equal(L.branches.get("old").branch, "unknown", "an expired fact is not walked");
    assert.equal(L.branches.has("hub"), false);
  } finally {
    if (prev === undefined) delete process.env.WIKI_OWNER_PAGE; else process.env.WIKI_OWNER_PAGE = prev;
  }
  assert.equal(loadFamilyBranches({ d: null }), null);
});
