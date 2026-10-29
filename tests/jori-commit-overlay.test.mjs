// jori-commit in a switched install: the named paths split by repo, one
// commit in each, a new file private (overlay) unless --kernel.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const TOOLS = path.resolve(HERE, "..");
const ov = require("../lib/overlay.cjs");
// The kernel tree inside a repo: tools/ here, the repo root in a root-layout install.
const { KERNEL_SUBDIR } = require("../lib/root.cjs");
const K = (p) => (KERNEL_SUBDIR ? `${KERNEL_SUBDIR}/${p}` : p);

const env = (root) => ({ ...process.env, JORI_HOME: root, JORI_OVERLAY_GIT_DIR: path.join(root, ".overlay.git"),
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" });
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { env: env(cwd), stdio: ["ignore", "pipe", "pipe"] }).toString();
const write = (root, p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gcommit-ovl-"));
  const root = path.join(tmp, "install"), src = path.join(tmp, "overlay-src");
  fs.mkdirSync(root); fs.mkdirSync(src);
  git(root, "init", "-q");
  // the tools the commit path runs, at their kernel-tree paths
  for (const f of ["bin/jori-commit", "bin/jori-overlay", "lib/overlay.cjs", "lib/root.cjs"]) {
    write(root, K(f), fs.readFileSync(path.join(TOOLS, f), "utf8"));
    fs.chmodSync(path.join(root, K(f)), 0o755);
  }
  write(root, K("bin/tool"), "kernel v1\n");
  write(root, ".gitignore", "/.overlay.git/\n/data/\n");
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "kernel");
  git(src, "init", "-q");
  write(src, "data/state.json", "{\"v\":1}\n");
  git(src, "add", "-A"); git(src, "commit", "-q", "-m", "overlay");
  ov.init(src, root);
  return root;
}

const commit = (root, ...args) => execFileSync("bash", [path.join(root, K("bin/jori-commit")), ...args], { cwd: root, env: env(root), encoding: "utf8" });
const ovGit = (root, ...a) => ov.overlayGit(a, root, { env: env(root) }).toString();

test("one call, one commit in each repo, each with only its own paths", () => {
  const root = setup();
  write(root, K("bin/tool"), "kernel v2\n");
  write(root, "data/state.json", "{\"v\":2}\n");
  const out = commit(root, "-m", "both", "--", K("bin/tool"), "data/state.json");
  assert.match(out, /kernel repo \(1 path/);
  assert.match(out, /overlay \(1 path/);
  assert.equal(git(root, "show", "--name-only", "--format=%s", "HEAD").trim(), `both\n\n${K("bin/tool")}`);
  assert.equal(ovGit(root, "show", "--name-only", "--format=%s", "HEAD").trim(), "both\n\ndata/state.json");
  assert.deepEqual(ov.check({ root }), []);
});

test("a new file is private unless --kernel says it is generic", () => {
  const root = setup();
  write(root, "data/new-state.json", "{}\n");
  write(root, K("lib/new-generic.mjs"), "export {};\n");
  write(root, K("lib/new-private.mjs"), "export {};\n");
  commit(root, "-m", "private", "--", "data/new-state.json", K("lib/new-private.mjs"));
  commit(root, "-m", "generic", "--kernel", "--", K("lib/new-generic.mjs"));
  const ovFiles = ov.overlayFiles(root);
  assert.ok(ovFiles.includes("data/new-state.json"), "under a path the kernel repo ignores, still tracked (forced)");
  assert.ok(ovFiles.includes(K("lib/new-private.mjs")));
  assert.ok(git(root, "ls-files").split("\n").includes(K("lib/new-generic.mjs")));
  assert.ok(!git(root, "ls-files").split("\n").includes(K("lib/new-private.mjs")));
  assert.deepEqual(ov.check({ root }), [], "the exclude block follows the new overlay file");
});

test("--promote moves an overlay file into the kernel repo, one commit in each", () => {
  const root = setup();
  write(root, K("lib/made-generic.mjs"), "export const v = 1;\n");
  commit(root, "-m", "private first", "--", K("lib/made-generic.mjs"));
  assert.ok(ov.overlayFiles(root).includes(K("lib/made-generic.mjs")));
  const out = commit(root, "-m", "promote it", "--promote", "--", K("lib/made-generic.mjs"));
  assert.match(out, /promoting 1 path/);
  assert.ok(!ov.overlayFiles(root).includes(K("lib/made-generic.mjs")), "the overlay no longer tracks it");
  assert.ok(git(root, "ls-files").split("\n").includes(K("lib/made-generic.mjs")), "the kernel repo does");
  assert.equal(ovGit(root, "log", "-1", "--format=%s").trim(), "promote it");
  assert.equal(ovGit(root, "status", "--porcelain", "-uno").trim(), "", "nothing left staged in the overlay");
  assert.deepEqual(ov.check({ root }), []);
});

test("--promote refuses a path the overlay does not track, and changes nothing", () => {
  const root = setup();
  write(root, K("lib/stray.mjs"), "export {};\n");
  assert.throws(() => commit(root, "-m", "x", "--promote", "--", K("lib/stray.mjs")), (e) => /not an overlay file/.test(e.stderr) && e.status === 1);
  assert.ok(!git(root, "ls-files").split("\n").includes(K("lib/stray.mjs")));
});
