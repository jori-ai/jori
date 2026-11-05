// packages/create-jori: argument parsing, and the packed tarball carries the
// installer next to the bin.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "create-jori");
const { parseArgs } = await import(path.join(PKG, "bin.mjs"));

test("arguments map onto the installer's environment", () => {
  assert.deepEqual(parseArgs([], { HOME: "/Users/sam" }).env, {});
  assert.equal(parseArgs(["~/apps/jori"], { HOME: "/Users/sam" }).env.JORI_HOME, "/Users/sam/apps/jori");
  const o = parseArgs(["--no-setup", "--no-ollama"]);
  assert.equal(o.env.JORI_NO_SETUP, "1");
  assert.equal(o.env.JORI_NO_OLLAMA, "1");
  assert.ok(parseArgs(["-h"]).help);
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
});

test("the packed package holds bin.mjs and install.sh", () => {
  const out = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: PKG, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  // npm 10 prints an array of packs; npm 11 an object keyed by package name.
  const pack = Array.isArray(out) ? out[0] : Object.values(out)[0];
  const files = pack.files.map((f) => f.path).sort();
  assert.deepEqual(files, ["README.md", "bin.mjs", "install.sh", "package.json"]);
});
