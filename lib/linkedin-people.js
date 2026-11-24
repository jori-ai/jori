// linkedin-people.js — ties the LinkedIn connections table (lib/linkedin-connections.js)
// to the wiki's person pages, both ways:
//   - a connection row carries `page_id` when the person has a page;
//   - that page carries a code-written `## LinkedIn` block (between
//     <!-- linkedin:start --> / <!-- linkedin:end -->) with the row's facts.
// Only people who already have a page are linked; no page is ever created here.
//
// Who is who:
//   - a LinkedIn profile URL already on the page is certain (code links it);
//   - otherwise candidates are connections whose name equals the page's name
//     or one of its unambiguous concept-map aliases (first + last name tokens),
//     and a MODEL decides whether one of them is this person (Rule #0b: same
//     name is not same person). `autoDecide` asks Haiku (lib/local-llm.mjs);
//     it fails open (left pending) where Max is unreadable (cron, SSH). The
//     weekly wiki-link-weave job settles what is still pending with
//     `linkedin-connections link --pending` / `--decide`.
// Decisions (linked or not) persist in li_page_links, so a re-import keeps
// them and a "not this person" is not asked again unless the candidates change.

"use strict";

const crypto = require("node:crypto");
const li = require("./linkedin-connections.js");

const START = "<!-- linkedin:start -->";
const END = "<!-- linkedin:end -->";

function schema() {
  const d = li.db();
  const cols = d.prepare("PRAGMA table_info(li_connections)").all().map((c) => c.name);
  if (!cols.includes("page_id")) d.exec("ALTER TABLE li_connections ADD COLUMN page_id TEXT DEFAULT ''");
  d.exec(`
    CREATE TABLE IF NOT EXISTS li_page_links (
      page_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL DEFAULT '',      -- '' = decided: none of the candidates is this person
      method TEXT NOT NULL,               -- url | model | manual
      candidates_hash TEXT NOT NULL DEFAULT '',
      decided_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS li_conn_page ON li_connections(page_id);
  `);
  return d;
}

// ── Pages ────────────────────────────────────────────────────────────────────
function personPages(ws) {
  const out = [];
  for (const p of ws.listPages({ status: "active" })) {
    const row = ws.getPage(p.id);
    let fm = {};
    try { fm = JSON.parse(row.frontmatter_json || "{}"); } catch {}
    if (fm.entity === "person") out.push({ ...row, fm });
  }
  return out;
}

function aliasesByTarget(conceptsPath) {
  const map = new Map();
  try {
    for (const c of require("./wiki-linker.js").loadConcepts(conceptsPath ? { conceptsPath } : {})) {
      map.set(c.target, c.aliases);
    }
  } catch {} // no concept map yet: titles only
  return map;
}

// The names a page goes by: its title (minus a parenthesised qualifier) and
// its unambiguous aliases, as folded "first … last" strings.
function pageNames(page, aliases) {
  // The id rule is user_<first>_<last>[_qualifier]; its first two parts are a name too.
  const idName = String(page.id).startsWith("user_") ? String(page.id).slice(5).split("_").slice(0, 2).join(" ") : "";
  const raw = [page.title, page.fm?.name, page.fm?.title, idName, ...(aliases.get(page.id) || [])].filter(Boolean);
  const names = new Set();
  for (const n of raw) {
    const f = li.fold(String(n).replace(/\([^)]*\)/g, " ")); // lang-regex-ok: strips a "(qualifier)" bracket
    if (f.split(" ").length >= 2) names.add(f);
  }
  return [...names];
}

function slugsOnPage(rawMd) {
  const out = new Set();
  for (const m of String(rawMd || "").matchAll(/linkedin\.com\/in\/([^/?#\s)\]]+)/gi)) { // lang-regex-ok: URL structure
    try { out.add(decodeURIComponent(m[1]).toLowerCase()); } catch { out.add(m[1].toLowerCase()); }
  }
  return [...out];
}

function nameCandidates(names) {
  const d = li.db();
  const byExact = d.prepare("SELECT * FROM li_connections WHERE name_folded = ?");
  const byFirstLast = d.prepare("SELECT * FROM li_connections WHERE name_folded LIKE ? AND name_folded LIKE ?");
  const seen = new Map();
  for (const n of names) {
    for (const r of byExact.all(n)) seen.set(r.slug || `id${r.id}`, r);
    const t = n.split(" ");
    for (const r of byFirstLast.all(`${t[0]} %`, `% ${t[t.length - 1]}`)) seen.set(r.slug || `id${r.id}`, r);
  }
  return [...seen.values()];
}

const hashOf = (rows) => crypto.createHash("sha1").update(rows.map((r) => r.slug).sort().join(",")).digest("hex").slice(0, 12);

function excerpt(rawMd, n = 1200) {
  const body = String(rawMd || "").replace(/^---\n[\s\S]*?\n---\n/, ""); // lang-regex-ok: frontmatter fence
  const cut = body.indexOf(START);
  return (cut >= 0 ? body.slice(0, cut) : body).trim().slice(0, n);
}

// ── Scan: certain links are recorded, the rest come back as pending ──────────
function scan({ ws, conceptsPath } = {}) {
  ws = ws || require("./wiki-store.js");
  const d = schema();
  const aliases = aliasesByTarget(conceptsPath);
  const decided = new Map(d.prepare("SELECT * FROM li_page_links").all().map((r) => [r.page_id, r]));
  const bySlug = d.prepare("SELECT * FROM li_connections WHERE slug = ?");
  const now = new Date().toISOString();
  const pending = [];
  let urlLinked = 0;
  for (const page of personPages(ws)) {
    const prior = decided.get(page.id);
    // A profile URL on the page is certain.
    const urlHit = slugsOnPage(page.raw_md).map((s) => bySlug.get(s)).find(Boolean);
    if (urlHit) {
      if (!prior || prior.slug !== urlHit.slug) {
        record(page.id, urlHit.slug, "url", "", now);
        urlLinked++;
      }
      continue;
    }
    if (prior?.method === "manual") continue;
    const cands = nameCandidates(pageNames(page, aliases));
    if (!cands.length) continue;
    const h = hashOf(cands);
    if (prior && prior.candidates_hash === h) continue; // already decided on these candidates
    pending.push({
      page_id: page.id,
      title: page.title,
      page_excerpt: excerpt(page.raw_md),
      candidates_hash: h,
      candidates: cands.map((r) => ({
        slug: r.slug, name: r.full_name, company: r.company, position: r.position,
        connected_on: r.connected_on, url: r.url, tie: li.tie(r),
        msgs: r.msgs_sent + r.msgs_received, last_msg_at: r.last_msg_at,
      })),
    });
  }
  return { url_linked: urlLinked, pending };
}

function record(pageId, slug, method, candidatesHash, at = new Date().toISOString()) {
  const d = schema();
  d.exec("BEGIN");
  try {
    // One page ↔ one connection.
    if (slug) d.prepare("DELETE FROM li_page_links WHERE slug = ? AND page_id != ?").run(slug, pageId);
    d.prepare(`INSERT INTO li_page_links (page_id, slug, method, candidates_hash, decided_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(page_id) DO UPDATE SET slug=excluded.slug, method=excluded.method, candidates_hash=excluded.candidates_hash, decided_at=excluded.decided_at`)
      .run(pageId, slug || "", method, candidatesHash || "", at);
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
}

// `slug` = the candidate that is this person, or "" / "none" for none of them.
function decide(pageId, slug, { method = "manual", candidatesHash = "" } = {}) {
  const s = slug === "none" ? "" : String(slug || "").toLowerCase();
  if (s && !li.get(s)) throw new Error(`no connection with profile ${slug}`);
  record(pageId, s, method, candidatesHash);
}

// ── The model step ───────────────────────────────────────────────────────────
function prompt(item) {
  return {
    system: "You match a person's wiki page to their LinkedIn connection. Same name is not proof of same person: use the page's facts (work, places, relations, how they know the owner) against each candidate's company, title and contact history. Answer with JSON only: {\"slug\": \"<candidate slug>\"} or {\"slug\": \"none\"} when none clearly is this person, plus \"why\" (one short sentence). When unsure, answer none.",
    user: JSON.stringify({ page_id: item.page_id, page_title: item.title, page: item.page_excerpt, candidates: item.candidates }),
  };
}

function parseAnswer(text, item) {
  const m = String(text || "").match(/\{[\s\S]*\}/); // lang-regex-ok: JSON object in model output
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const s = String(j.slug || "").toLowerCase();
  if (s === "none") return { slug: "", why: j.why || "" };
  return item.candidates.some((c) => c.slug === s) ? { slug: s, why: j.why || "" } : null;
}

async function autoDecide(pending, { chat } = {}) {
  chat = chat || (async (o) => (await import("./local-llm.mjs")).localLlmChat({ ...o, timeoutMs: 60000 }));
  const out = { linked: 0, none: 0, left: 0, errors: [] };
  for (const item of pending) {
    let ans = null;
    try { ans = parseAnswer(await chat(prompt(item)), item); }
    catch (e) { out.errors.push(`${item.page_id}: ${e.message}`); }
    if (!ans) { out.left++; continue; }
    decide(item.page_id, ans.slug || "none", { method: "model", candidatesHash: item.candidates_hash });
    if (ans.slug) out.linked++; else out.none++;
  }
  return out;
}

// ── Apply: page_id on rows, ## LinkedIn block on pages ───────────────────────
function block(r, asOf) {
  const role = [r.position, r.company].filter(Boolean).join(" @ ");
  const ties = [];
  if (r.msgs_sent || r.msgs_received) ties.push(`${r.msgs_sent} messages sent / ${r.msgs_received} received on LinkedIn (last ${r.last_msg_at})`);
  if (r.rec_received) ties.push(`recommended the user${r.rec_received > 1 ? ` ${r.rec_received}×` : ""}`);
  if (r.rec_given) ties.push(`the user recommended them${r.rec_given > 1 ? ` ${r.rec_given}×` : ""}`);
  if (r.endorsed_me) ties.push(`endorsed the user ${r.endorsed_me}×`);
  if (r.i_endorsed) ties.push(`the user endorsed them ${r.i_endorsed}×`);
  const lines = [
    START,
    `_From the user's LinkedIn connections (export of ${asOf}); the role may have changed since._`,
    `- ${role || "No role listed"}${r.url ? ` · [LinkedIn profile](${r.url})` : ""}`,
    `- Connected on LinkedIn ${r.connected_on || "(date unknown)"}`,
  ];
  if (r.email) lines.push(`- Email (shared on LinkedIn): ${r.email}`);
  lines.push(`- LinkedIn tie: **${li.tie(r)}**${ties.length ? ` (${ties.join("; ")})` : ""}`);
  lines.push(END);
  return lines.join("\n");
}

function renderOnto(rawMd, blk) {
  const re = new RegExp(`${START}[\\s\\S]*?${END}`); // lang-regex-ok: our own block markers
  if (blk == null) {
    if (!re.test(rawMd)) return rawMd;
    return rawMd.replace(new RegExp(`\\n*## LinkedIn\\n${START}[\\s\\S]*?${END}\\n?`), "\n").replace(re, ""); // lang-regex-ok: our own block markers
  }
  if (re.test(rawMd)) return rawMd.replace(re, () => blk);
  return `${rawMd.replace(/\s*$/, "")}\n\n## LinkedIn\n${blk}\n`;
}

function apply({ ws, dryRun = false } = {}) {
  ws = ws || require("./wiki-store.js");
  const d = schema();
  const links = d.prepare("SELECT page_id, slug FROM li_page_links WHERE slug != ''").all();
  const asOf = (d.prepare("SELECT v FROM li_meta WHERE k = 'imported_at'").get()?.v || "").slice(0, 10) || "unknown date";
  const out = { linked: 0, pages_written: 0, pages_unchanged: 0, missing: [], unlinked_pages: 0 };
  if (!dryRun) {
    d.exec("BEGIN");
    d.exec("UPDATE li_connections SET page_id = ''");
    const set = d.prepare("UPDATE li_connections SET page_id = ? WHERE slug = ?");
    for (const l of links) set.run(l.page_id, l.slug);
    d.exec("COMMIT");
  }
  const linkedPages = new Set();
  for (const l of links) {
    const row = li.get(l.slug);
    const page = ws.getPage(l.page_id);
    if (!row || !page || page.status !== "active") { out.missing.push(`${l.page_id} → ${l.slug}`); continue; }
    out.linked++;
    linkedPages.add(l.page_id);
    const next = renderOnto(page.raw_md, block(row, asOf));
    if (next === page.raw_md) { out.pages_unchanged++; continue; }
    if (!dryRun) ws.savePage(l.page_id, next, { editedBy: "linkedin-connections" });
    out.pages_written++;
  }
  // A page whose link was removed loses its block.
  for (const p of personPages(ws)) {
    if (linkedPages.has(p.id) || !String(p.raw_md).includes(START)) continue;
    if (!dryRun) ws.savePage(p.id, renderOnto(p.raw_md, null), { editedBy: "linkedin-connections" });
    out.unlinked_pages++;
  }
  return out;
}

function linkedFor(pageId) {
  const l = schema().prepare("SELECT * FROM li_page_links WHERE page_id = ?").get(pageId);
  return l ? { ...l, connection: l.slug ? li.get(l.slug) : null } : null;
}

module.exports = { START, END, schema, scan, decide, autoDecide, apply, linkedFor, pageNames, slugsOnPage, parseAnswer, prompt, block, renderOnto };
