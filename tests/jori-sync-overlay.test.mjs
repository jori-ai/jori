// jori-sync in a switched install: the kernel checkout (on `install`) and
// the overlay are each synced with origin, and the exclude block follows.
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

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
delete ENV.JORI_OVERLAY_GIT_DIR;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { env: ENV, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const write = (root, p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsync-ovl-"));
  const kOrigin = path.join(tmp, "kernel.git"), oOrigin = path.join(tmp, "overlay.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "install", kOrigin]);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", oOrigin]);
  // seed the kernel origin: the sync tooling at its kernel-tree paths
  const seed = path.join(tmp, "seed");
  execFileSync("git", ["init", "-q", "-b", "install", seed]);
  for (const f of ["bin/jori-sync", "bin/jori-overlay", "lib/overlay.cjs", "lib/root.cjs"]) {
    write(seed, K(f), fs.readFileSync(path.join(TOOLS, f), "utf8"));
    fs.chmodSync(path.join(seed, K(f)), 0o755);
  }
  write(seed, K("bin/tool"), "v1\n"); write(seed, ".gitignore", "/.overlay.git/\n/data/\n");
  git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "kernel"); git(seed, "push", "-q", kOrigin, "install");
  const oseed = path.join(tmp, "oseed");
  execFileSync("git", ["init", "-q", "-b", "main", oseed]);
  write(oseed, "data/state.json", "1\n"); git(oseed, "add", "-A"); git(oseed, "commit", "-q", "-m", "overlay"); git(oseed, "push", "-q", oOrigin, "main");
  const host = (name) => {
    const root = path.join(tmp, name);
    execFileSync("git", ["clone", "-q", "-b", "install", kOrigin, root]);
    ov.init(oOrigin, root);
    return root;
  };
  return { laptop: host("laptop"), mini: host("mini") };
}

const sync = (root) => execFileSync("bash", [path.join(root, K("bin/jori-sync"))], { cwd: root, env: { ...ENV, JORI_HOME: root }, encoding: "utf8" });
const ovGit = (root, ...a) => ov.overlayGit(a, root, { env: ENV }).toString().trim();

test("a commit in each repo on one host reaches the other through origin", () => {
  const { laptop, mini } = setup();
  write(laptop, K("bin/tool"), "v2\n"); git(laptop, "commit", "-qam", "kernel fix");
  write(laptop, "data/state.json", "2\n"); ovGit(laptop, "commit", "-qam", "state");
  write(laptop, "data/new.json", "{}\n"); ovGit(laptop, "add", "-f", "data/new.json"); ovGit(laptop, "commit", "-qm", "new state");
  const up = sync(laptop);
  assert.match(up, /kernel\] pushed 1 commit/);
  assert.match(up, /overlay\] pushed 2 commit/);
  const down = sync(mini);
  assert.match(down, /kernel\] pulled 1 commit/);
  assert.match(down, /overlay\] pulled 2 commit/);
  assert.equal(fs.readFileSync(path.join(mini, K("bin/tool")), "utf8"), "v2\n");
  assert.equal(fs.readFileSync(path.join(mini, "data/state.json"), "utf8"), "2\n");
  assert.ok(fs.existsSync(path.join(mini, "data/new.json")));
  assert.deepEqual(ov.check({ root: mini }), [], "the mini's exclude block covers the pulled overlay file");
  assert.equal(git(mini, "status", "--porcelain"), "", "the kernel repo sees none of it");
});

test("the kernel checkout refuses to sync on any branch but install", () => {
  const { laptop } = setup();
  git(laptop, "checkout", "-q", "-b", "main");
  assert.throws(() => sync(laptop), (e) => /expected the kernel repo on install/.test(e.stdout) && e.status === 1);
});

test("a promotion (overlay → kernel repo) reaches the other host with no drift conflict", () => {
  const { laptop, mini } = setup();
  write(laptop, K("lib/feature.mjs"), "export const v = 1;\n");
  ovGit(laptop, "add", "-f", K("lib/feature.mjs")); ovGit(laptop, "commit", "-qm", "private feature");
  sync(laptop); sync(mini);
  assert.equal(fs.readFileSync(path.join(mini, K("lib/feature.mjs")), "utf8"), "export const v = 1;\n");
  // promote on the laptop: the overlay drops it, the kernel repo takes it (edited on the way)
  write(laptop, K("lib/feature.mjs"), "export const v = 2;\n");
  ovGit(laptop, "rm", "-q", "--cached", K("lib/feature.mjs")); ovGit(laptop, "commit", "-qm", "promoted");
  ov.syncExcludes(laptop);
  git(laptop, "add", K("lib/feature.mjs")); git(laptop, "commit", "-qm", "feature, generic");
  sync(laptop);
  const down = sync(mini);
  assert.doesNotMatch(down, /DRIFT CONFLICT|stashed/);
  assert.equal(fs.readFileSync(path.join(mini, K("lib/feature.mjs")), "utf8"), "export const v = 2;\n");
  assert.ok(git(mini, "ls-files").split("\n").includes(K("lib/feature.mjs")), "the kernel repo tracks it");
  assert.ok(!ov.overlayFiles(mini).includes(K("lib/feature.mjs")), "the overlay no longer does");
  assert.deepEqual(ov.check({ root: mini }), []);
});
