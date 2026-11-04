// Every symbol a reader uses from lib/rental-ledger.js (or
// lib/finance-real-estate.js) must be in that reader's own import list.
//
// WHY THIS TEST EXISTS. The ledger semantics were lifted out of the portfolio
// CLI into a shared library so the CLI and the finance reviews could not answer
// "what did one house cost last year" with two different numbers. The
// extraction was verified by diffing 17 command shapes against the
// pre-extraction binary and finding them byte-identical — and it was still
// wrong, because `contributionsOf` was left out of the CLI's import list and
// none of those 17 shapes reached it. `transactions --category income` died
// with "contributionsOf is not defined" for anyone who ran it.
//
// A golden-output diff only covers the commands somebody thought to include.
// This covers all of them at once, in milliseconds, with no network: a static
// check that the intersection of {what the library exports} and {what the file
// references} is a subset of {what the file imports}. The readers are found,
// not listed: every file under bin/ that requires one of the libraries.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { toolsPath } = require("../lib/root.cjs");

const LIBS = [
  { module: "lib/rental-ledger.js", spec: "../lib/rental-ledger.js" },
  { module: "lib/finance-real-estate.js", spec: "../lib/finance-real-estate.js" },
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The named bindings a file destructures out of `spec`, if it does. */
function destructuredFrom(source, spec) {
  const m = source.match(new RegExp(String.raw`const\s*\{([^}]*)\}\s*=\s*require\(\s*["']${esc(spec)}["']\s*\)`, "s"));
  if (!m) return null;
  return new Set(m[1].split(",").map((x) => x.split(":")[0].trim()).filter(Boolean));
}

/** Whole-namespace imports (`const ledger = require(...)`) need no per-symbol check. */
function namespacedFrom(source, spec) {
  return new RegExp(String.raw`const\s+\w+\s*=\s*require\(\s*["']${esc(spec)}["']\s*\)`, "s").test(source);
}

/** The calls `source` makes to `exports` without importing them from `spec`. */
function missingImports(source, spec, exports) {
  const imported = destructuredFrom(source, spec);
  if (!imported) return [];
  // Strip the require statement itself, so the import list does not count as a use of its own names.
  const body = source.replace(new RegExp(String.raw`const\s*\{[^}]*\}\s*=\s*require\(\s*["']${esc(spec)}["']\s*\)`, "s"), "");
  return exports.filter((name) => !imported.has(name) && new RegExp(String.raw`\b${name}\s*\(`).test(body));
}

const readers = () => {
  const dir = toolsPath("bin");
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    let src;
    try { if (!fs.statSync(p).isFile()) continue; src = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (LIBS.some(({ spec }) => src.includes(spec))) out.push({ name: `bin/${f}`, src });
  }
  return out;
};

test("the portfolio CLI is among the readers found", () => {
  assert.ok(readers().some((r) => r.name === "bin/rentals"), "bin/rentals should require lib/rental-ledger.js");
});

test("every reader imports every ledger symbol it uses", () => {
  for (const { module, spec } of LIBS) {
    const exports = Object.keys(require(toolsPath(module)));
    assert.ok(exports.length > 0, `${module} exports nothing`);
    for (const r of readers()) {
      const missing = missingImports(r.src, spec, exports);
      assert.deepEqual(missing, [],
        `${r.name} calls ${missing.join(", ")} from ${module} without importing ${missing.length > 1 ? "them" : "it"} — ` +
        `it will throw "<name> is not defined" the moment that code path runs.`);
    }
  }
});

test("the check catches a missing import and exempts a namespaced one", () => {
  const exports = ["statement", "contributionsOf"];
  const bad = `const { statement } = require("../lib/rental-ledger.js");\nstatement(); contributionsOf(t);`;
  assert.deepEqual(missingImports(bad, "../lib/rental-ledger.js", exports), ["contributionsOf"]);
  const ns = `const ledger = require("../lib/rental-ledger.js");\nledger.contributionsOf(t);`;
  assert.ok(namespacedFrom(ns, "../lib/rental-ledger.js"));
  assert.deepEqual(missingImports(ns, "../lib/rental-ledger.js", exports), []);
});

test("the shared library has no write path", () => {
  // The ledger has three authors and a tax return at the end of it. A fourth
  // arriving over a library is how a correction gets silently overwritten.
  for (const { module } of LIBS) {
    const source = fs.readFileSync(toolsPath(module), "utf8");
    for (const forbidden of [".set(", ".update(", ".delete(", ".create(", "commitWrite", "patch("]) {
      assert.ok(!source.includes(`db${forbidden}`) && !source.includes(`firestore()${forbidden}`),
        `${module} appears to contain a Firestore write (${forbidden}) — this layer is read-only by construction`);
    }
  }
});
