// work-records.mjs — the record of one-off work Jori (or any Claude session)
// did for the user: a comparison, an evaluation, research, a plan, a review.
//
// Each piece of work is a wiki page `type: work`, id `work_<YYYY-MM-DD>_<slug>`,
// holding the SUBSTANCE (bottom line, what was asked, the deliverable's full
// text as delivered, dated updates), not just a link. Recall, the speak gate
// and chat find it like any wiki page; nobody has to "open the doc" to know
// what it said. Design: system/wiki-architecture.md § Work records.
//
// Writers: bin/work-record (add | update | sync-project-work), called by the
// project-work trigger, the chat agent and role sessions when they hand over a
// piece of work, the dream as the nightly backstop, and Claude Code sessions.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = () => require("./wiki-store.js");

export const TYPE = "work";
const MAX_DELIVERABLE = 60_000; // chars kept of a deliverable's text

export function slugify(s, max = 48) {
  const slug = String(s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (slug.slice(0, max).replace(/_+$/, "")) || "work";
}

export function pageIdFor(date, title) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error(`work-records: date must be YYYY-MM-DD, got ${date}`);
  return `work_${date}_${slugify(title)}`;
}

export function userTz() {
  try { return require("./instance.cjs").instance().tz || "UTC"; } catch { return "UTC"; }
}

/** YYYY-MM-DD in the user's timezone. */
export function localDate(d = new Date(), tz = userTz()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
}

export function docIdFromUrl(url) {
  const m = String(url || "").match(/\/document\/d\/([\w-]{20,})/);
  return m ? m[1] : null;
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function ownerEmail() {
  try { return require("./instance.cjs").instance().owner_email; } catch { return null; }
}

/** The text of a Google Doc in the owner's Drive (gog docs cat), or null with the reason. */
export function readGoogleDoc(url, { gog = process.env.GOG_BIN || "/opt/homebrew/bin/gog" } = {}) {
  const id = docIdFromUrl(url);
  if (!id) return { text: null, error: "not a Google Doc link" };
  const args = ["docs", "cat", id, "--no-input"];
  const acct = ownerEmail();
  if (acct) args.push("-a", acct);
  const r = spawnSync(gog, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 8 << 20 });
  if (r.status !== 0 || !r.stdout.trim()) return { text: null, error: (r.stderr || r.error?.message || `gog exit ${r.status}`).trim().slice(0, 300) };
  return { text: r.stdout.trim(), error: null };
}

function clip(text) {
  const t = String(text || "").trim();
  return t.length > MAX_DELIVERABLE ? `${t.slice(0, MAX_DELIVERABLE)}\n\n[… cut at ${MAX_DELIVERABLE} characters; the rest is at the link above]` : t;
}

export const HOW_TO_CHANGE = "## How to change it";

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(String).map((s) => s.trim()).filter(Boolean);

/**
 * Build the page markdown. Fields:
 *  title, date (YYYY-MM-DD), by, kind, project (page id), bottom_line (one sentence),
 *  summary (what it concluded — every recommendation, warning, exclusion),
 *  asked, as_of, sources[], links[], deliverable (full text), deliverable_note,
 *  source_key (idempotency: e.g. project-work:pt-123), related[] (page ids), updates[] ({date, by, text}),
 *  how_to_change (where the work's sources live on a machine the assistant can reach, how to rebuild
 *  it, and how a change may land: what lets a later change be made without the session that made it)
 */
export function buildPage(f) {
  const links = asList(f.links);
  const related = asList(f.related);
  const fm = {
    name: f.title,
    description: f.bottom_line || f.title,
    type: TYPE,
    status: f.status || "active",
    work_date: f.date,
    work_kind: f.kind || null,
    by: f.by || null,
    project: f.project || null,
    as_of: f.as_of || null,
    links: links.length ? links : null,
    source_key: f.source_key || null,
  };
  const head = [
    `**When:** ${f.date}`,
    f.by ? `**By:** ${f.by}` : null,
    f.project ? `**Project:** [[${f.project}]]` : null,
    f.as_of ? `**As of:** ${f.as_of}` : null,
  ].filter(Boolean).join(" · ");
  const out = [`# ${f.title}`, "", head, ""];
  if (links.length) out.push(`**Where it lives:** ${links.join(" · ")}`, "");
  out.push("## Bottom line", "", (f.summary || f.bottom_line || "").trim() || "_(not recorded)_", "");
  if (f.how_to_change) out.push(HOW_TO_CHANGE, "", String(f.how_to_change).trim(), "");
  if (f.asked) out.push("## Asked", "", String(f.asked).trim(), "");
  if (asList(f.sources).length) out.push("## Built from", "", ...asList(f.sources).map((s) => `- ${s}`), "");
  out.push("## Deliverable (as delivered)", "");
  if (f.deliverable_note) out.push(`_${String(f.deliverable_note).trim()}_`, "");
  out.push(f.deliverable ? clip(f.deliverable) : "_The full text is not kept here; see the link above._", "");
  if (related.length) out.push("## Related", "", ...related.map((r) => `- [[${r}]]`), "");
  out.push("## Updates", "");
  const ups = (f.updates || []).filter((u) => u && u.text);
  if (ups.length) for (const u of ups) out.push(`- **${u.date}**${u.by ? ` (${u.by})` : ""}: ${String(u.text).trim()}`);
  else out.push("_None yet. Anything learned after this was delivered (a new offer, a decision, a correction) is added here with its date._");
  return `${ws().renderFrontmatter(fm)}\n${out.join("\n").trimEnd()}\n`;
}

function frontmatterOf(page) {
  try { return JSON.parse(page.frontmatter_json || "{}"); } catch { return {}; }
}

/** All work pages, newest first, with their frontmatter. */
export function listWork({ project = null, since = null, status = "active", limit = 0 } = {}) {
  const rows = ws().listPages({ type: TYPE, ...(status ? { status } : {}) });
  let out = rows.map((r) => {
    const p = ws().getPage(r.id);
    const fm = p ? frontmatterOf(p) : {};
    return { id: r.id, title: r.title, description: r.description, status: r.status, date: fm.work_date || r.id.slice(5, 15), by: fm.by || null, project: fm.project || null, kind: fm.work_kind || null, links: asList(fm.links), source_key: fm.source_key || null };
  });
  if (project) out = out.filter((w) => w.project === project || w.project === `project_${project}`);
  if (since) out = out.filter((w) => w.date >= since);
  out.sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.id.localeCompare(b.id));
  return limit ? out.slice(0, limit) : out;
}

export function findBySourceKey(key) {
  if (!key) return null;
  return listWork({ status: null }).find((w) => w.source_key === key) || null;
}

/** Search work records only (wiki FTS restricted to type work). */
export function findWork(query, { k = 8 } = {}) {
  return ws().searchPages(query, { mode: "fts", type: TYPE, limit: k });
}

/** Create a record (or, for an existing source_key / id, refuse unless replace). Returns { id, created }. */
export function recordWork(f, { replace = false, editedBy = "work-record" } = {}) {
  if (!f.title) throw new Error("work-records: title is required");
  if (!f.bottom_line && !f.summary) throw new Error("work-records: a bottom line or summary is required (the substance, not just a link)");
  f = { ...f, date: f.date || localDate() };
  const existing = f.source_key ? findBySourceKey(f.source_key) : null;
  const id = existing?.id || f.id || pageIdFor(f.date, f.title);
  const prior = ws().getPage(id);
  if (prior && !replace) return { id, created: false, skipped: "exists" };
  if (prior && replace) {
    // Keep the updates already recorded.
    const m = (prior.body_md || "").split(/\n## Updates\n/)[1];
    if (m && !f.updates) f.updates_raw = m.trim();
    if (!f.how_to_change) f.how_to_change = howToChangeOf(prior.body_md) || undefined;
  }
  let raw = buildPage(f);
  if (f.updates_raw && !/^_None yet/.test(f.updates_raw)) raw = raw.replace(/## Updates\n\n[\s\S]*$/, `## Updates\n\n${f.updates_raw}\n`);
  ws().savePage(id, raw, { editedBy });
  return { id, created: !prior };
}

/** The "How to change it" section of a record's body, or null. */
export function howToChangeOf(body) {
  const m = String(body || "").match(/\n## How to change it\n\n([\s\S]*?)(?=\n## |$)/);
  return m ? m[1].trim() || null : null;
}

/**
 * Set (or replace) a record's "How to change it" section, which sits after the
 * bottom line. Everything else in the record is kept as it is.
 */
export function setHowToChange(id, text, { editedBy = "work-record" } = {}) {
  const p = ws().getPage(id);
  if (!p) throw new Error(`work-records: no page ${id}`);
  if (p.type !== TYPE) throw new Error(`work-records: ${id} is type ${p.type}, not work`);
  const t = String(text || "").trim();
  if (!t) throw new Error("work-records: the how-to-change text is empty");
  const block = `${HOW_TO_CHANGE}\n\n${t}\n`;
  let raw = p.raw_md;
  if (/\n## How to change it\n/.test(raw)) raw = raw.replace(/## How to change it\n\n[\s\S]*?(?=\n## |$)/, block);
  else if (/\n## Bottom line\n/.test(raw)) raw = raw.replace(/(\n## Bottom line\n\n[\s\S]*?)(?=\n## |$)/, (m) => `${m.trimEnd()}\n\n${block}`);
  else raw = raw.trimEnd() + `\n\n${block}`;
  ws().savePage(id, raw, { editedBy });
  return { id };
}

/** Append a dated update to a record. */
export function addUpdate(id, text, { date = localDate(), by = null, editedBy = "work-record" } = {}) {
  const p = ws().getPage(id);
  if (!p) throw new Error(`work-records: no page ${id}`);
  if (p.type !== TYPE) throw new Error(`work-records: ${id} is type ${p.type}, not work`);
  const line = `- **${date}**${by ? ` (${by})` : ""}: ${String(text).trim()}`;
  let raw = p.raw_md;
  if (/\n## Updates\n/.test(raw)) {
    raw = raw.replace(/(\n## Updates\n\n)_None yet[^\n]*\n?/, "$1");
    raw = raw.trimEnd() + "\n" + line + "\n";
  } else {
    raw = raw.trimEnd() + `\n\n## Updates\n\n${line}\n`;
  }
  ws().savePage(id, raw, { editedBy });
  return { id };
}

const PROJECT_WORK_ROLE = "Chief of Staff (overnight project work)";

/**
 * Record every finished project-work result (data/projects/tasks.json) that has
 * no work record yet. A doc result gets the Google Doc's full text. Idempotent
 * by source_key project-work:<task id>.
 */
export function syncProjectWork({ tasksPath = null, dryRun = false, readDoc = readGoogleDoc } = {}) {
  const p = tasksPath || path.join(process.env.JORI_INSTALL_TOOLS || ROOT, "data", "projects", "tasks.json");
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return { error: `cannot read ${p}: ${e.message}`, recorded: [] }; }
  const recorded = [], skipped = [];
  for (const t of Object.values(ledger.tasks || {})) {
    const r = t.jori?.result;
    if (!r || r.failed || !r.summary) continue;
    const key = `project-work:${t.id}`;
    if (findBySourceKey(key)) { skipped.push(t.id); continue; }
    const date = localDate(r.at || Date.now());
    let deliverable = null, note = null;
    if (r.kind === "doc" && r.link) {
      const d = readDoc(r.link);
      if (d.text) { deliverable = d.text; note = `Full text of the Google Doc, read ${localDate()}.`; }
      else note = `The Google Doc could not be read when this was recorded (${d.error}); open the link.`;
    } else if (r.kind === "note" || r.kind === "research") {
      deliverable = r.summary;
      note = "The result was a note; this is all of it.";
    }
    const f = {
      title: String(t.title || t.id).replace(/\s*\((?:[^()]*)\)\s*$/, "").trim() || t.id,
      date, by: PROJECT_WORK_ROLE, kind: r.kind || null, project: t.project || null,
      bottom_line: String(r.summary).split(/(?<=[.!?])\s+/)[0],
      summary: r.summary, asked: `Project task ${t.id}: ${t.title}`,
      links: r.link ? [r.link] : [], deliverable, deliverable_note: note, source_key: key,
    };
    if (dryRun) { recorded.push({ task: t.id, id: pageIdFor(date, f.title), dry_run: true }); continue; }
    const out = recordWork(f, { editedBy: "work-record:project-work" });
    recorded.push({ task: t.id, ...out });
  }
  return { recorded, skipped };
}
