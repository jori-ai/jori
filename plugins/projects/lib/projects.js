// projects — the code half of the project pages (plugins/projects, jobs/projects.md).
//
// The user's projects (a trip being planned, a product being built, a house
// being renovated, a family event) each get a wiki page with `entity: project`.
// Code gathers the evidence and owns the page plumbing; the agent turn owns the
// meaning: which threads of evidence are one project, what its goal is, and
// what the user might need to finish it.
//
//   gather()        calendar (past + upcoming), Google Tasks (open + recently
//                   completed), the wiki's project and recently-changed pages,
//                   and commit activity in the user's repos → one bundle.
//   listProjects()  every page that is a project page (entity: project), with
//                   its status and whether it carries the managed block.
//   renderBlock()   replace (or append) the managed block on a page.
//
// Every source is read best-effort: a failure lands in `errors[source]` and the
// rest of the bundle still ships (a missing source is "not captured", never an
// empty one).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LIB = path.join(__dirname, "..", "..", "..", "lib");
const { localConfig, instance, instanceValue } = require(path.join(LIB, "instance.cjs"));

const DEFAULTS = {
  // Calendar window, in days before and after today.
  calendar_past_days: 90,
  calendar_future_days: 180,
  // Calendars to leave out, by id or by name (holiday calendars are always left out).
  exclude_calendars: [],
  // Completed tasks older than this are not read.
  tasks_completed_days: 120,
  // Folders whose direct sub-folders are git repositories to read activity from ([] = none).
  repo_roots: [],
  repo_days: 60,
  // How many days of recently changed wiki pages the bundle lists.
  wiki_recent_days: 30,
  // How many project pages a single run may create (the backlog drains over nights).
  max_new_pages_per_run: 25,
};

const SECTION_START = "<!-- projects:start -->";
const SECTION_END = "<!-- projects:end -->";
const STATUSES = ["active", "upcoming", "paused", "done"];
// The two sections every project page must carry (the user's requirement).
const REQUIRED_HEADINGS = ["## Goal", "## What you might need"];

const GOG = process.env.GOG_BIN || "/opt/homebrew/bin/gog";

function settings() {
  return localConfig("projects", DEFAULTS);
}

function isoDay(ms) {
  const tz = instanceValue("tz") || "UTC";
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });
}

function expandHome(p) {
  return String(p).startsWith("~") ? path.join(os.homedir(), String(p).slice(1)) : String(p);
}

function clip(s, n) {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, " ").trim(); // lang-regex-ok: whitespace collapse, not meaning
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// ── gog ──────────────────────────────────────────────────────────────────────

function gogJson(args, timeout = 60000) {
  const account = process.env.JORI_CAL_ACCOUNT || instance().owner_email;
  const r = spawnSync(GOG, [...args, "-a", account, "--json", "--results-only", "--no-input"], {
    encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `gog exited ${r.status}`).trim().slice(0, 300));
  const out = (r.stdout || "").trim();
  if (!out) return [];
  return JSON.parse(out);
}

function asList(j, ...keys) {
  if (Array.isArray(j)) return j;
  for (const k of keys) if (j && Array.isArray(j[k])) return j[k];
  return [];
}

// ── sources ──────────────────────────────────────────────────────────────────

function readCalendar(cfg, now = Date.now(), gog = gogJson) {
  const from = new Date(now - cfg.calendar_past_days * 864e5).toISOString();
  const to = new Date(now + cfg.calendar_future_days * 864e5).toISOString();
  const exclude = new Set((cfg.exclude_calendars || []).map(String));
  const calendars = asList(gog(["calendar", "calendars"]), "calendars", "items")
    .filter((c) => c && c.id && !String(c.id).includes("#holiday")
      && !exclude.has(String(c.id)) && !exclude.has(String(c.summary || "")));
  const events = [];
  const errors = [];
  for (const c of calendars) {
    let rows;
    try {
      rows = asList(gog(["calendar", "events", c.id, "--from", from, "--to", to, "--max", "2500", "--all-pages"]), "events", "items");
    } catch (e) {
      errors.push(`${c.summary || c.id}: ${e.message}`);
      continue;
    }
    for (const ev of rows) {
      if (!ev || ev.status === "cancelled") continue;
      const start = (ev.start && (ev.start.dateTime || ev.start.date)) || null;
      const end = (ev.end && (ev.end.dateTime || ev.end.date)) || null;
      const others = (ev.attendees || []).filter((a) => a && !a.self && !a.resource);
      events.push({
        start, end,
        all_day: !!(ev.start && ev.start.date && !ev.start.dateTime),
        title: clip(ev.summary, 160) || "(no title)",
        calendar: c.summary || c.id,
        location: clip(ev.location, 120),
        description: clip(ev.description, 300),
        attendees: others.map((a) => a.displayName || a.email).slice(0, 12),
        recurring: !!ev.recurringEventId,
      });
    }
  }
  events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  // A weekly standing event is one row per occurrence: collapse repeats so the
  // bundle shows a series once, with its count and next date.
  const series = new Map();
  const out = [];
  for (const ev of events) {
    if (!ev.recurring) { out.push(ev); continue; }
    const key = `${ev.calendar}|${ev.title}`;
    const s = series.get(key);
    if (!s) {
      const row = { ...ev, occurrences: 1, last_start: ev.start };
      series.set(key, row);
      out.push(row);
    } else {
      s.occurrences += 1;
      s.last_start = ev.start;
    }
  }
  return { window: { from, to }, calendars: calendars.map((c) => c.summary || c.id), events: out, errors };
}

function readTasks(cfg, now = Date.now(), gog = gogJson) {
  const lists = asList(gog(["tasks", "lists"]), "items", "lists", "taskLists");
  const cutoff = now - cfg.tasks_completed_days * 864e5;
  const tasks = [];
  for (const l of lists) {
    const rows = asList(gog(["tasks", "list", l.id, "--show-completed", "--show-hidden", "--max", "100", "--all"]), "tasks", "items");
    for (const t of rows) {
      if (!t || t.deleted) continue;
      if (t.status === "completed" && t.completed && Date.parse(t.completed) < cutoff) continue;
      tasks.push({
        title: clip(t.title, 200) || "(untitled)",
        notes: clip(t.notes, 300),
        list: l.title || l.id,
        status: t.status === "completed" ? "completed" : "open",
        due: t.due ? String(t.due).slice(0, 10) : null,
        completed: t.completed ? String(t.completed).slice(0, 10) : null,
        updated: t.updated ? String(t.updated).slice(0, 10) : null,
      });
    }
  }
  return { lists: lists.map((l) => l.title || l.id), tasks };
}

function wikiStore() {
  return require(path.join(LIB, "wiki-store.js"));
}

function frontmatterOf(row) {
  try { return JSON.parse(row.frontmatter_json || "{}"); } catch { return {}; }
}

function hasBlock(rawMd) {
  return String(rawMd || "").includes(SECTION_START);
}

// Every project page: `entity: project`. Pages of `type: project` that are not
// yet project pages (decision notes, older project memories) are listed apart,
// so the turn can adopt the ones that are really a project.
function listProjects(ws = wikiStore()) {
  const projects = [];
  const candidates = [];
  for (const meta of ws.listPages({})) {
    if (meta.status && meta.status !== "active") continue;
    const row = ws.getPage(meta.id);
    if (!row) continue;
    const fm = frontmatterOf(row);
    const base = {
      id: row.id, name: fm.name || row.title, description: fm.description || row.description || null,
      type: row.type, updated_at: row.updated_at || null, pin_locked: !!row.pin_locked,
    };
    if (fm.entity === "project") {
      projects.push({ ...base, project_status: fm.project_status || null, has_block: hasBlock(row.raw_md) });
    } else if (row.type === "project") {
      candidates.push(base);
    }
  }
  return { projects, candidates };
}

function readWiki(cfg, ws = wikiStore()) {
  const { projects, candidates } = listProjects(ws);
  let recent = [];
  try {
    recent = ws.recentlyUpdated({ limit: 150, sinceDays: cfg.wiki_recent_days })
      .filter((p) => !["day", "week", "month"].includes(p.type))
      .map((p) => ({ id: p.id, type: p.type, title: p.title, description: clip(p.description, 200), updated_at: p.updated_at }));
  } catch { /* the recent list is a hint, not a source */ }
  return { projects, project_type_pages: candidates, recently_changed: recent };
}

function readRepos(cfg, now = Date.now()) {
  const repos = [];
  const since = new Date(now - cfg.repo_days * 864e5).toISOString().slice(0, 10);
  for (const root of cfg.repo_roots || []) {
    const dir = expandHome(root);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const repo = path.join(dir, e.name);
      if (!fs.existsSync(path.join(repo, ".git"))) continue;
      const r = spawnSync("git", ["-C", repo, "log", "--all", "--no-merges", `--since=${since}`, "--date=short", "--format=%ad%x09%s"], {
        encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024,
      });
      if (r.status !== 0) continue;
      const lines = (r.stdout || "").split("\n").filter(Boolean);
      if (!lines.length) continue;
      const rows = lines.map((l) => { const i = l.indexOf("\t"); return { date: l.slice(0, i), subject: clip(l.slice(i + 1), 140) }; });
      repos.push({
        repo: e.name, commits: rows.length, first: rows.at(-1).date, last: rows[0].date,
        recent_subjects: rows.slice(0, 12).map((x) => `${x.date} ${x.subject}`),
      });
    }
  }
  repos.sort((a, b) => b.last.localeCompare(a.last) || b.commits - a.commits);
  return { since, repos };
}

function gather({ now = Date.now(), cfg = settings(), gog = gogJson, ws = null } = {}) {
  const bundle = { generated_at: new Date(now).toISOString(), date: isoDay(now), settings: cfg, errors: {} };
  const run = (key, fn) => {
    try { bundle[key] = fn(); } catch (e) { bundle[key] = null; bundle.errors[key] = String(e.message || e).slice(0, 300); }
  };
  run("calendar", () => readCalendar(cfg, now, gog));
  if (bundle.calendar && bundle.calendar.errors.length) bundle.errors.calendar_partial = bundle.calendar.errors;
  run("tasks", () => readTasks(cfg, now, gog));
  run("wiki", () => readWiki(cfg, ws || wikiStore()));
  run("repos", () => readRepos(cfg, now));
  return bundle;
}

// ── the managed block ────────────────────────────────────────────────────────

function checkSection(section) {
  const s = String(section || "");
  const missing = REQUIRED_HEADINGS.filter((h) => !s.split("\n").some((l) => l.trim() === h));
  if (missing.length) throw new Error(`section is missing ${missing.join(" and ")}`);
  if (s.includes(SECTION_START) || s.includes(SECTION_END)) throw new Error("section must not contain the block markers");
  return s.trim();
}

function renderBlock(rawMd, { section, status, today = Date.now() }) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join("|")}`);
  const body = checkSection(section);
  const facts = `_Project page · ${status} · kept current by the projects job and the dream · updated ${isoDay(today)}_`;
  const block = `${SECTION_START}\n${facts}\n\n${body}\n${SECTION_END}`;
  const raw = String(rawMd || "");
  const a = raw.indexOf(SECTION_START);
  const b = raw.indexOf(SECTION_END);
  if (a !== -1 && b > a) return raw.slice(0, a) + block + raw.slice(b + SECTION_END.length);
  return `${raw.replace(/\s*$/, "")}\n\n${block}\n`; // lang-regex-ok: trailing whitespace trim
}

function currentBlock(rawMd) {
  const raw = String(rawMd || "");
  const a = raw.indexOf(SECTION_START);
  const b = raw.indexOf(SECTION_END);
  if (a === -1 || b < a) return null;
  // The sections only: the italic facts line is code's, rewritten on every save.
  const lines = raw.slice(a + SECTION_START.length, b).trim().split("\n");
  if ((lines[0] || "").startsWith("_Project page ·")) lines.shift();
  return lines.join("\n").trim();
}

// YAML-safe scalar for the frontmatter we write on a new page.
function yamlScalar(s) {
  return JSON.stringify(String(s));
}

function newPage({ id, name, description, scope, intro, section, status, today = Date.now() }) {
  if (!/^project_[a-z0-9_]+$/.test(String(id))) throw new Error("id must be project_<lowercase_ascii>"); // lang-regex-ok: id shape
  if (!name || !description) throw new Error("name and description are required");
  const fm = [
    "---",
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(description)}`,
    "type: project",
    "entity: project",
    `project_status: ${status}`,
    `scope: [projects${scope ? `, ${scope}` : ""}]`,
    "---",
  ].join("\n");
  const head = `${fm}\n# ${name}\n\n${String(intro || "").trim()}\n`;
  return renderBlock(head, { section, status, today });
}

module.exports = {
  DEFAULTS, SECTION_START, SECTION_END, STATUSES, REQUIRED_HEADINGS,
  settings, gather, readCalendar, readTasks, readWiki, readRepos, listProjects,
  renderBlock, currentBlock, checkSection, newPage, hasBlock, frontmatterOf,
};
