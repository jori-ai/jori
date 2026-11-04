// health-lab-aliases: the kernel's LOINC map plus an installation's own lab
// codes (agent/local/config/health.json lab_code_aliases), and the health hum
// lane staying quiet on an install with no Supabase project.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { TOOLS_DIR } = require("../lib/root.cjs");

const MOD = path.join(TOOLS_DIR, "lib", "health-lab-aliases.cjs");

function fresh(localDir) {
  process.env.JORI_LOCAL_DIR = localDir;
  delete require.cache[MOD];
  delete require.cache[path.join(TOOLS_DIR, "lib", "instance.cjs")];
  return require(MOD);
}

test("the kernel map is LOINC only and every entry is a {system, code}", () => {
  const { readKernelMap } = require(MOD);
  const map = readKernelMap();
  assert.ok(Object.keys(map).length > 50);
  for (const [k, codes] of Object.entries(map)) {
    assert.equal(k, k.toLowerCase());
    assert.ok(codes.length > 0, k);
    for (const c of codes) assert.equal(c.system, "http://loinc.org", k);
  }
  assert.ok(map.ldl.some((c) => c.code === "13457-7"));
});

test("mergeAliases appends an installation's codes per alias, deduped, and adds new aliases", () => {
  const { mergeAliases } = require(MOD);
  const base = { ldl: [{ system: "http://loinc.org", code: "13457-7" }] };
  const extra = {
    LDL: [{ system: "https://lab.example/test", code: "X1" }, { system: "http://loinc.org", code: "13457-7" }],
    "lab-only": [{ system: "https://lab.example/test", code: "X2" }],
    broken: [{ system: "https://lab.example/test" }],
  };
  const m = mergeAliases(base, extra);
  assert.deepEqual(m.ldl, [{ system: "http://loinc.org", code: "13457-7" }, { system: "https://lab.example/test", code: "X1" }]);
  assert.deepEqual(m["lab-only"], [{ system: "https://lab.example/test", code: "X2" }]);
  assert.deepEqual(m.broken, []);
});

test("labAliases: a fresh install has the kernel map alone; a local config extends it", () => {
  const prev = process.env.JORI_LOCAL_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-cfg-"));
  try {
    let H = fresh(dir);
    const plain = H.labAliases();
    assert.deepEqual(plain, H.mergeAliases(H.readKernelMap(), {}));
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(path.join(dir, "config", "health.json"),
      JSON.stringify({ lab_code_aliases: { a1c: [{ system: "https://lab.example/test", code: "A9" }] } }));
    H = fresh(dir);
    const ext = H.labAliases();
    assert.ok(ext.a1c.some((c) => c.code === "A9"));
    assert.ok(ext.a1c.some((c) => c.system === "http://loinc.org"));
    assert.ok(H.suggest(ext, "cholest").includes("cholesterol"));
  } finally {
    if (prev === undefined) delete process.env.JORI_LOCAL_DIR; else process.env.JORI_LOCAL_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the health hum lane is off (emits null) with no Supabase project configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-off-"));
  const env = { ...process.env, JORI_LOCAL_DIR: dir, HUM_HARVEST_PREVIEW: "1" };
  delete env.SUPABASE_URL;
  delete env.JORI_SUPABASE_PROJECT;
  try {
    const r = spawnSync(process.execPath, [path.join(TOOLS_DIR, "agent", "scripts", "hum-harvesters", "health.mjs")],
      { input: "{}", env, encoding: "utf8", timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "null");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
