"use strict";
// schema-migrations — the kernel's Supabase schema (system/migrations/*.sql):
// list the files in apply order, say what each one creates, and find the
// tables, views and RPCs the kernel's own code reaches through PostgREST, so a
// test can prove that every one of them has a CREATE (tests/schema-migrations.test.mjs).
// Used by bin/jori-migrate. Pure file reading: nothing here talks to a database.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "system", "migrations");

/** The migration files, in apply order (name order), as absolute paths. */
function listMigrations(dir = MIGRATIONS_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort().map((n) => path.join(dir, n));
}

/** Drop -- comments (outside quotes is close enough for our own files). */
function stripComments(sql) {
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

/** What a SQL text creates: { tables, views, functions, buckets }. */
function createdObjects(sql) {
  const s = stripComments(sql);
  const grab = (re) => [...s.matchAll(re)].map((m) => m[1].toLowerCase());
  return {
    tables: grab(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi),
    views: grab(/create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi),
    functions: grab(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi),
    buckets: grab(/jori_ensure_bucket\(\s*'([a-z0-9-]+)'/gi),
  };
}

/** Every object the migration directory creates, merged. */
function schemaObjects(dir = MIGRATIONS_DIR) {
  const out = { tables: new Set(), views: new Set(), functions: new Set(), buckets: new Set() };
  for (const f of listMigrations(dir)) {
    const o = createdObjects(fs.readFileSync(f, "utf8"));
    for (const k of Object.keys(out)) for (const n of o[k]) out[k].add(n);
  }
  return out;
}

/** Kernel source files to scan: tracked by the kernel repo when git can say so. */
function kernelSourceFiles(root = ROOT, dirs = ["bin", "lib", "agent"]) {
  let files = [];
  try {
    files = execFileSync("git", ["-C", root, "ls-files", "--", ...dirs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);
  } catch {
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.name === "node_modules" || e.name === "local" || e.name === "_ext") continue;
        if (e.isDirectory()) walk(rel); else files.push(rel);
      }
    };
    for (const d of dirs) { try { walk(d); } catch { /* absent */ } }
  }
  return files.filter((f) => !/\.(md|json|lock|png|jpg|svg|txt)$/.test(f) && !f.includes("node_modules/"));
}

/**
 * Tables / views and RPC functions the kernel code names in PostgREST calls:
 *   `/rest/v1/<t>`, `rest/v1/rpc/<fn>`, `"<t>?select=…"` style paths,
 *   `.from("<t>")`, and `<helper>("<t>", …)` for the REST helpers in use.
 * Returns { tables: Map(name → [files]), rpcs: Map(name → [files]) }.
 */
function kernelReferences(root = ROOT, files = kernelSourceFiles(root)) {
  const tables = new Map();
  const rpcs = new Map();
  const add = (m, n, f) => { if (!m.has(n)) m.set(n, []); if (!m.get(n).includes(f)) m.get(n).push(f); };
  const OPS = "(?:eq|neq|gte|gt|lte|lt|in|is|not|like|ilike)";
  const patterns = [
    /rest\/v1\/(?!rpc\/)([a-z_][a-z0-9_]*)/g,
    new RegExp(`["'\`]\\/?([a-z][a-z0-9]*_[a-z0-9_]*)\\?(?:select=|on_conflict=|order=|limit=|[a-z_]+=${OPS}\\.)`, "g"),
    /\.from\(\s*["'`]([a-z][a-z0-9_]*)["'`]\)/g,
    /\b(?:[A-Z_]*TABLE|table)\s*[:=]\s*["'`]([a-z][a-z0-9]*_[a-z0-9_]*)["'`]/g,
    /\b(?:supabaseSelect|sbSelect|requestAll|request|rest|sb|upsert|watermark)\(\s*(?:deps,\s*)?["'`]([a-z][a-z0-9]*_[a-z0-9_]*)["'`]/g,
    /\(\s*["'](?:GET|POST|PATCH|DELETE)["']\s*,\s*["'`]\/?([a-z][a-z0-9]*_[a-z0-9_]*)[?"'`]/g,
  ];
  for (const rel of files) {
    let s;
    try { s = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue; }
    if (s.includes("\0")) continue;
    for (const re of patterns) for (const m of s.matchAll(re)) if (m[1] !== "rpc") add(tables, m[1], rel);
    for (const m of s.matchAll(/(?:rest\/v1\/rpc\/|["'`]rpc\/)([a-z_][a-z0-9_]*)/g)) add(rpcs, m[1], rel);
  }
  return { tables, rpcs };
}

/** Tables the kernel reaches only through a config default (not a literal path). */
function configDefaultTables() {
  const out = [];
  try {
    // The brokerage adapter's defaults, read with no local config in the way.
    const saved = process.env.JORI_LOCAL_DIR;
    process.env.JORI_LOCAL_DIR = path.join(require("node:os").tmpdir(), "jori-schema-no-local");
    try {
      delete require.cache[require.resolve("./broker-config.cjs")];
      const bc = require("./broker-config.cjs");
      const cfg = (bc.brokerConfig || bc)();
      out.push(...Object.values(cfg.tables || {}));
    } finally {
      if (saved === undefined) delete process.env.JORI_LOCAL_DIR; else process.env.JORI_LOCAL_DIR = saved;
      delete require.cache[require.resolve("./broker-config.cjs")];
    }
  } catch { /* adapter absent: nothing to add */ }
  return out;
}

module.exports = {
  ROOT, MIGRATIONS_DIR, listMigrations, stripComments, createdObjects, schemaObjects,
  kernelSourceFiles, kernelReferences, configDefaultTables,
};
