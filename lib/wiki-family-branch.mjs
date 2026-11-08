// wiki-family-branch.mjs — which side of the family a person is on: the
// owner's, the owner's spouse's, both, or unknown. Derived from the typed
// relations on person pages (`page_facts`, lib/wiki-facts.mjs), by walking the
// graph. Never from names.
//
// Why: on 2026-10-29 a who's-who offered for a family dinner mixed the owner's
// side (an aunt's branch and her children) with the spouse's cousins. The owner:
// "Those are different families … Can't mix these meetups." The person pages
// carry typed relations since 2026-10-26, so which branch someone belongs to
// is a structural question the graph can answer.
//
// The walk, per root (the owner, and the owner's spouse), strongest tier first:
//   1 blood     go UP through parents and siblings, then DOWN through children
//               (and siblings). Never up again after going down, and never
//               across a spouse: that is what keeps the couple's children from
//               carrying the other side's whole family into this one. The
//               couple's own children come out on both sides, as they are.
//   2 in-law    the spouse or partner of someone in tier 1 (an aunt's husband),
//               one hop, not their own family.
//   3 relative  a stated `relative_of` a tier 1/2 person (or the root), and the
//               family of such a person, up to a few hops, never passing through
//               anyone who is tier 1/2 on either side. `relative_of` does not say
//               how, so it is the weakest evidence.
// A person's branch is the side with the stronger tier; equal tiers on both
// sides is "both"; no path is "unknown". Missing relations mean unknown, never
// a guess.
//
// Readers: wiki_read (agent/tools-mcp/index.mjs) prints a person page's branch
// with the path that decided it; `wiki-people branch` lists people by branch, for
// a who's-who or meetup prep that must keep to one side.
// Tests: tests/wiki-family-branch.test.mjs.

import { createRequire } from "node:module";
import { openMemoryDb } from "./memory-db.mjs";
import { CURRENT_FACT_SQL } from "./wiki-assoc.mjs";

export const FAMILY_RELS = ["parent_of", "child_of", "sibling_of", "spouse_of", "partner_of", "relative_of"];
export const TIER_NAMES = { 1: "blood", 2: "in-law", 3: "relative" };
// How far a stated relative's own family is followed. Small on purpose: each
// hop away from a blood relative is weaker evidence of which side they are on.
export const RELATIVE_HOPS = 3;

/**
 * The graph from typed facts [{src_id, rel, dst_id}]. Directed parent edges,
 * symmetric sibling / spouse / relative edges. `persons` (a Set), when given,
 * keeps only person pages, so a hub ("the sons", "the extended family") never
 * joins two people.
 */
export function buildGraph(facts, persons = null) {
  const g = { parents: new Map(), children: new Map(), siblings: new Map(), spouses: new Map(), relatives: new Map(), nodes: new Set() };
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const f of facts || []) {
    const a = f.src_id, b = f.dst_id;
    if (!a || !b || a === b || !FAMILY_RELS.includes(f.rel)) continue;
    if (persons && (!persons.has(a) || !persons.has(b))) continue;
    g.nodes.add(a); g.nodes.add(b);
    if (f.rel === "parent_of") { add(g.parents, b, a); add(g.children, a, b); }
    else if (f.rel === "child_of") { add(g.parents, a, b); add(g.children, b, a); }
    else {
      const m = f.rel === "sibling_of" ? g.siblings : f.rel === "relative_of" ? g.relatives : g.spouses;
      add(m, a, b); add(m, b, a);
    }
  }
  return g;
}

const nb = (m, id) => [...(m.get(id) || [])].sort();

// Each reached person: {tier, path: [{rel, to}]} — the path reads from the person
// back to the root, each step "<the person before> <rel> <to>": a cousin's path is
// "child_of aunt → sibling_of parent → parent_of root".
function walkSide(g, root, otherRoot) {
  const best = new Map([[root, { tier: 0, path: [] }]]);
  const set = (id, tier, via, rel) => {
    if (id === root || id === otherRoot) return false;
    const cur = best.get(id);
    if (cur && cur.tier <= tier) return false;
    best.set(id, { tier, path: [{ rel, to: via }, ...best.get(via).path] });
    return true;
  };
  // Tier 1: up (parents, siblings), then down (children, siblings).
  const seen = new Set();
  const queue = [[root, "up"]];
  while (queue.length) {
    const [id, phase] = queue.shift();
    const key = `${id}|${phase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const step = (to, nextPhase, rel) => {
      if (to === otherRoot) return;
      set(to, 1, id, rel);
      if (best.get(to) && best.get(to).tier === 1) queue.push([to, nextPhase]);
    };
    // `rel` is the reached person's relation to `id`: a parent of id is parent_of id.
    if (phase === "up") for (const p of nb(g.parents, id)) step(p, "up", "parent_of");
    for (const s of nb(g.siblings, id)) step(s, phase, "sibling_of");
    for (const c of nb(g.children, id)) step(c, "down", "child_of");
  }
  const blood = [...best.keys()];
  // Tier 2: the spouse of a blood relative (the root's own spouse is the other root).
  for (const id of blood) for (const s of nb(g.spouses, id)) set(s, 2, id, "spouse_of");
  return best;
}

function walkRelatives(g, best, strong, root, otherRoot) {
  const seeds = [];
  for (const [id, b] of [...best]) {
    if (b.tier > 2) continue;
    for (const r of nb(g.relatives, id)) seeds.push([r, id, "relative_of"]);
  }
  const blocked = (id) => id === root || id === otherRoot || strong.has(id);
  const frontier = [];
  for (const [r, via, rel] of seeds) {
    if (blocked(r)) continue;
    const cur = best.get(r);
    if (!cur || cur.tier > 3) { best.set(r, { tier: 3, path: [{ rel, to: via }, ...best.get(via).path], hops: 1 }); frontier.push(r); }
  }
  while (frontier.length) {
    const id = frontier.shift();
    const hops = best.get(id).hops || 1;
    if (hops >= RELATIVE_HOPS) continue;
    const next = [
      ...nb(g.parents, id).map((x) => [x, "parent_of"]), ...nb(g.children, id).map((x) => [x, "child_of"]),
      ...nb(g.siblings, id).map((x) => [x, "sibling_of"]), ...nb(g.spouses, id).map((x) => [x, "spouse_of"]),
      ...nb(g.relatives, id).map((x) => [x, "relative_of"]),
    ];
    for (const [to, rel] of next) {
      if (blocked(to) || best.has(to)) continue;
      best.set(to, { tier: 3, path: [{ rel, to: id }, ...best.get(id).path], hops: hops + 1 });
      frontier.push(to);
    }
  }
}

/**
 * Branch of every person the graph reaches. Returns Map id → {branch, owner, spouse}
 * where branch is "owner" | "spouse" | "both" | "unknown" and owner/spouse are
 * {tier, path} or null. `ids` adds people with no family edge at all (unknown).
 */
export function familyBranches(facts, { owner, spouse, persons = null, ids = [] } = {}) {
  const g = buildGraph(facts, persons);
  const out = new Map();
  if (!owner) return out;
  const o = walkSide(g, owner, spouse);
  const s = spouse ? walkSide(g, spouse, owner) : new Map();
  // Anyone tier 1/2 on either side is a boundary for the weaker relative walk.
  const strong = new Set([...o, ...s].filter(([, b]) => b.tier >= 1 && b.tier <= 2).map(([id]) => id));
  walkRelatives(g, o, strong, owner, spouse);
  if (spouse) walkRelatives(g, s, strong, spouse, owner);
  const all = new Set([...g.nodes, ...ids, owner, ...(spouse ? [spouse] : [])]);
  for (const id of all) {
    const a = o.get(id) || null, b = s.get(id) || null;
    let branch = "unknown";
    if (id === owner) branch = "owner";
    else if (id === spouse) branch = "spouse";
    else if (a && b) branch = a.tier < b.tier ? "owner" : b.tier < a.tier ? "spouse" : "both";
    else if (a) branch = "owner";
    else if (b) branch = "spouse";
    const strip = (x) => (x ? { tier: x.tier, path: x.path } : null);
    out.set(id, { branch, owner: strip(a), spouse: strip(b) });
  }
  return out;
}

/** "The user's side, blood: child_of user_x → sibling_of user_y → …" (titles optional). */
export function describeBranch(entry, { ownerName = "the owner", spouseName = "the spouse", title = (id) => id } = {}) {
  if (!entry) return "unknown (no family relations recorded)";
  const side = { owner: `${ownerName}'s side`, spouse: `${spouseName}'s side`, both: `both sides (${ownerName}'s and ${spouseName}'s)`,
    unknown: "unknown (no family relations recorded that reach either side)" }[entry.branch];
  const way = (x) => (x && x.path.length ? `${TIER_NAMES[x.tier]}: ${x.path.map((p) => `${p.rel} ${title(p.to)}`).join(" → ")}` : null);
  if (entry.branch === "owner") return [side, way(entry.owner)].filter(Boolean).join(", ");
  if (entry.branch === "spouse") return [side, way(entry.spouse)].filter(Boolean).join(", ");
  if (entry.branch === "both") return `${side}; ${[way(entry.owner), way(entry.spouse)].filter(Boolean).join("; ")}`;
  return side;
}

// The owner's page (agent/local/config/wiki.json `owner_page`, as wiki-facts reads it).
function ownerPage() {
  return process.env.WIKI_OWNER_PAGE
    || createRequire(import.meta.url)("./instance.cjs").localConfig("wiki", { owner_page: "user_owner" }).owner_page;
}

/**
 * Read the facts and person pages from the wiki DB and compute every branch.
 * The spouse is the owner's current spouse_of / partner_of fact (one-valued),
 * unless agent/local/config/wiki.json `spouse_page` names one.
 * Returns {owner, spouse, branches: Map, title(id)} or null when the DB is absent.
 */
export function loadFamilyBranches({ d = openMemoryDb() } = {}) {
  if (!d) return null;
  let facts = [], pages = [];
  try {
    facts = d.prepare(`SELECT f.src_id, f.rel, f.dst_id FROM page_facts f
      WHERE f.dst_id IS NOT NULL AND f.rel IN (${FAMILY_RELS.map(() => "?").join(",")}) AND ${CURRENT_FACT_SQL}`).all(...FAMILY_RELS);
    pages = d.prepare("SELECT id, title, frontmatter_json FROM pages WHERE status = 'active'").all();
  } catch { return null; }
  const titles = new Map(pages.map((p) => [p.id, p.title || p.id]));
  const persons = new Set(pages.filter((p) => { try { return JSON.parse(p.frontmatter_json || "{}").entity === "person"; } catch { return false; } }).map((p) => p.id));
  const owner = ownerPage();
  if (owner) persons.add(owner);
  const cfg = createRequire(import.meta.url)("./instance.cjs").localConfig("wiki", { spouse_page: null });
  let spouse = cfg.spouse_page || null;
  if (!spouse) {
    const mine = facts.filter((f) => (f.rel === "spouse_of" || f.rel === "partner_of") && (f.src_id === owner || f.dst_id === owner))
      .map((f) => (f.src_id === owner ? f.dst_id : f.src_id));
    const uniq = [...new Set(mine)];
    spouse = uniq.length === 1 ? uniq[0] : null; // two different spouses on record: name none, say unknown
  }
  if (spouse) persons.add(spouse);
  const branches = familyBranches(facts, { owner, spouse, persons, ids: [...persons] });
  return { owner, spouse, branches, title: (id) => titles.get(id) || id };
}

// The names the sides are called by: the owner's configured name, and
// agent/local/config/wiki.json `spouse_name` (else the spouse page's title).
export function sideNames(loaded) {
  const req = createRequire(import.meta.url);
  const inst = req("./instance.cjs");
  const ownerName = inst.instance().owner_name || loaded.title(loaded.owner);
  const spouseName = inst.localConfig("wiki", { spouse_name: null }).spouse_name
    || (loaded.spouse ? loaded.title(loaded.spouse) : "the spouse");
  return { ownerName, spouseName };
}

/** One line for a person page, or null when the page is not a person in the graph. */
export function branchLine(id, loaded = loadFamilyBranches()) {
  if (!loaded || !loaded.branches.has(id)) return null;
  return describeBranch(loaded.branches.get(id), { ...sideNames(loaded), title: (x) => x });
}
