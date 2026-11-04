// schema-migrations.test.mjs — the kernel's Supabase schema (system/migrations,
// lib/schema-migrations.cjs, bin/jori-migrate). Static checks only: nothing
// here connects to a database.
//
//   * every table / view / RPC the kernel's code reaches through PostgREST has
//     a CREATE in system/migrations;
//   * no migration carries an email address or this installation's project ref;
//   * every statement is written to be re-run (IF NOT EXISTS / OR REPLACE /
//     DROP ... IF EXISTS before CREATE POLICY and CREATE TRIGGER);
//   * RLS is enabled on every table, and app-facing policies go through the
//     allowlist instead of naming people;
//   * jori-migrate's dry run plans every file and --apply is gated.
//
// Run: node --test tests/schema-migrations.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sm = require("../lib/schema-migrations.cjs");
const migrate = require("../bin/jori-migrate");

const files = sm.listMigrations();
const texts = files.map((f) => ({ f: path.basename(f), sql: fs.readFileSync(f, "utf8") }));
const objects = sm.schemaObjects();

test("there are ordered migration files, foundation first", () => {
  assert.ok(files.length >= 10, "expected the capability files");
  assert.equal(path.basename(files[0]), "0000_foundation.sql");
  const names = files.map((f) => path.basename(f));
  assert.deepEqual(names, [...names].sort());
});

test("every table the kernel code references has a CREATE", () => {
  const refs = sm.kernelReferences();
  const created = new Set([...objects.tables, ...objects.views]);
  const missing = [...refs.tables.keys()].filter((t) => !created.has(t))
    .map((t) => `${t} (${refs.tables.get(t).slice(0, 3).join(", ")})`);
  assert.deepEqual(missing, [], `tables referenced by kernel code with no CREATE in system/migrations:\n${missing.join("\n")}`);
  assert.ok(refs.tables.size >= 50, `scanner found only ${refs.tables.size} tables; the patterns may have broken`);
});

test("tables reached only through config defaults have a CREATE", () => {
  const created = new Set(objects.tables);
  const defaults = sm.configDefaultTables();
  assert.ok(defaults.length > 0);
  for (const t of defaults) assert.ok(created.has(t), `${t} (a config default) has no CREATE`);
});

test("every RPC the kernel code calls is created", () => {
  const { rpcs } = sm.kernelReferences();
  assert.ok(rpcs.size > 0);
  for (const fn of rpcs.keys()) assert.ok(objects.functions.has(fn), `rpc ${fn} has no CREATE FUNCTION`);
});

test("the storage buckets kernel code writes to are created", () => {
  for (const b of ["daily-photos", "cruise-ships", "jori-attachments"]) assert.ok(objects.buckets.has(b), `bucket ${b}`);
});

test("no migration contains an email address", () => {
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
  for (const { f, sql } of texts) assert.ok(!email.test(sql), `${f} contains an email address: ${(sql.match(email) || [])[0]}`);
});

test("no migration names a Supabase project", () => {
  const ref = (() => { try { return require("../lib/instance.cjs").instance().supabase_project || ""; } catch { return ""; } })();
  for (const { f, sql } of texts) {
    if (ref) assert.ok(!sql.includes(ref), `${f} contains this installation's project ref`);
    assert.ok(!/[a-z0-9]{20}\.supabase\.co/.test(sql), `${f} contains a project URL`);
    assert.ok(!/api\.supabase\.com\/v1\/projects\/[a-z0-9]{20}/.test(sql), `${f} contains a project ref`);
  }
});

test("statements are re-runnable", () => {
  for (const { f, sql: raw } of texts) {
    const sql = sm.stripComments(raw).replace(/\s+/g, " ").toLowerCase();
    for (const m of sql.matchAll(/create (table|index|unique index|sequence|schema|extension) (?!if not exists)/g)) {
      assert.fail(`${f}: "create ${m[1]}" without IF NOT EXISTS`);
    }
    assert.ok(!/create function /.test(sql), `${f}: CREATE FUNCTION without OR REPLACE`);
    assert.ok(!/create view /.test(sql), `${f}: CREATE VIEW without OR REPLACE`);
    // Every CREATE POLICY / CREATE TRIGGER is preceded by its DROP ... IF EXISTS.
    for (const m of sql.matchAll(/create policy ([a-z0-9_"%]+) on ([a-z0-9_.%]+)/g)) {
      if (m[1].includes("%")) continue; // format() template inside a DO loop: checked below
      assert.ok(sql.includes(`drop policy if exists ${m[1]} on ${m[2]}`), `${f}: policy ${m[1]} on ${m[2]} has no DROP POLICY IF EXISTS`);
    }
    for (const m of sql.matchAll(/'create policy %i on public\.%i/g)) {
      assert.ok(sql.includes("'drop policy if exists %i on public.%i'"), `${f}: templated policy without a templated drop`);
    }
    for (const m of sql.matchAll(/create trigger ([a-z0-9_]+) /g)) {
      assert.ok(sql.includes(`drop trigger if exists ${m[1]} `), `${f}: trigger ${m[1]} has no DROP TRIGGER IF EXISTS`);
    }
    // Realtime publication and buckets only through the guarded helpers.
    assert.ok(!/alter publication/.test(sql.replace(/execute format\('alter publication[^;]*;/g, "")), `${f}: use jori_realtime_add()`);
  }
});

test("RLS is enabled on every table", () => {
  const all = texts.map((t) => sm.stripComments(t.sql)).join("\n").toLowerCase();
  // Tables enabled inside a DO loop are listed in an array literal; accept either form.
  for (const t of objects.tables) {
    const direct = new RegExp(`alter table (public\\.)?${t}\\s+enable row level security`).test(all);
    const looped = new RegExp(`'${t}'`).test(all) && /enable row level security', t\)/.test(all);
    assert.ok(direct || looped, `${t}: RLS not enabled`);
  }
});

test("app-facing policies go through the allowlist, never a hard-coded person", () => {
  for (const { f, sql: raw } of texts) {
    const sql = sm.stripComments(raw).toLowerCase();
    assert.ok(!/auth\.jwt\(\)\s*->>\s*'email'\)?\s*in\s*\(\s*'/.test(sql), `${f}: an email list in a policy`);
    assert.ok(!/device_id\s*=\s*'[^']+'/.test(sql), `${f}: a policy pinned to one device id`);
    // anon is never granted a row policy.
    assert.ok(!/create policy[^;]*\bto\s+anon\b/.test(sql.replace(/\s+/g, " ")), `${f}: a policy for anon`);
    for (const m of sql.replace(/\s+/g, " ").matchAll(/create policy [^;]*? to authenticated (using|with check) \(([^;]*)/g)) {
      assert.ok(m[2].includes("jori_is_allowed_user()"), `${f}: an authenticated policy without the allowlist: ${m[0].slice(0, 120)}`);
    }
  }
});

test("jori-migrate dry run plans every file in order and changes nothing", () => {
  const steps = migrate.plan({ only: [] });
  assert.equal(steps.length, files.length);
  assert.deepEqual(steps.map((s) => path.basename(s.file)), files.map((f) => path.basename(f)));
  const only = migrate.plan({ only: ["0010", "0030"] });
  assert.deepEqual(only.map((s) => path.basename(s.file).slice(0, 4)), ["0010", "0030"]);
  assert.ok(steps[1].tables.includes("jori_messages"));
});

test("jori-migrate --apply needs the project, the same ref repeated, and a token", () => {
  assert.equal(migrate.applyGate({ project: "", flagProject: "", token: "t" }).ok, false);
  assert.equal(migrate.applyGate({ project: "refaaaa", flagProject: "", token: "t" }).ok, false);
  assert.equal(migrate.applyGate({ project: "refaaaa", flagProject: "refbbbb", token: "t" }).ok, false);
  assert.equal(migrate.applyGate({ project: "refaaaa", flagProject: "refaaaa", token: "" }).ok, false);
  assert.equal(migrate.applyGate({ project: "refaaaa", flagProject: "refaaaa", token: "t" }).ok, true);
  const a = migrate.parseArgs(["--apply", "--project", "refaaaa", "--only", "0010,0020"]);
  assert.equal(a.apply, true);
  assert.equal(a.project, "refaaaa");
  assert.deepEqual(a.only, ["0010", "0020"]);
  assert.equal(migrate.parseArgs([]).apply, false);
});

test("--allow-user produces an escaped, idempotent insert", () => {
  const sql = migrate.allowSql(["a.b@example.test", "o'neil@example.test"]);
  assert.match(sql, /^insert into public\.jori_allowed_users \(email\) values /);
  assert.match(sql, /'o''neil@example\.test'/);
  assert.match(sql, /on conflict \(email\) do nothing;/);
  assert.equal(migrate.allowSql([]), "");
});
