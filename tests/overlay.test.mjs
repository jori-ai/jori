// overlay.cjs: an overlay repo checked out over a kernel checkout, kept apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ov = require("../lib/overlay.cjs");
delete process.env.JORI_OVERLAY_GIT_DIR;

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();
const write = (root, p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-"));
  const kernel = path.join(tmp, "install"), src = path.join(tmp, "overlay-src");
  fs.mkdirSync(kernel); fs.mkdirSync(src);
  git(kernel, "init", "-q");
  write(kernel, "bin/tool", "kernel\n"); write(kernel, ".gitignore", "/.overlay.git/\n");
  git(kernel, "add", "-A"); git(kernel, "commit", "-q", "-m", "kernel");
  git(src, "init", "-q");
  write(src, "agent/local/instance.json", "{}\n"); write(src, "bin/private-tool", "mine\n");
  git(src, "add", "-A"); git(src, "commit", "-q", "-m", "overlay");
  return { kernel, src };
}

test("no overlay: every check passes", () => {
  const { kernel } = setup();
  assert.equal(ov.hasOverlay(kernel), false);
  assert.deepEqual(ov.check({ root: kernel, staged: true }), []);
});

test("init writes the overlay files and hides them from the kernel repo", () => {
  const { kernel, src } = setup();
  const r = ov.init(src, kernel);
  assert.equal(r.files, 2);
  assert.equal(fs.readFileSync(path.join(kernel, "bin/private-tool"), "utf8"), "mine\n");
  assert.deepEqual(ov.check({ root: kernel, staged: true }), []);
  git(kernel, "add", "-A");
  assert.equal(git(kernel, "status", "--porcelain"), "", "git add -A in the kernel repo picks up no overlay file");
  assert.equal(ov.overlayGit(["status", "--porcelain"], kernel).toString(), "", "the overlay sees no kernel file");
});

test("a force-added overlay file is caught before the commit", () => {
  const { kernel, src } = setup();
  ov.init(src, kernel);
  git(kernel, "add", "-f", "bin/private-tool");
  const issues = ov.check({ root: kernel, staged: true }).join("\n");
  assert.match(issues, /staged in the kernel repo: bin\/private-tool/);
  assert.match(issues, /tracked by both/);
  assert.match(ov.check({ root: kernel }).join("\n"), /tracked by both/, "even without --staged, the index counts as tracked");
});

test("a new overlay file leaves the exclude block stale until synced", () => {
  const { kernel, src } = setup();
  ov.init(src, kernel);
  write(kernel, "data/state.json", "{}\n");
  ov.overlayGit(["add", "-f", "data/state.json"], kernel);
  assert.match(ov.check({ root: kernel }).join("\n"), /stale/);
  ov.syncExcludes(kernel);
  assert.deepEqual(ov.check({ root: kernel }), []);
});

test("init refuses an overlay that would overwrite a kernel file", () => {
  const { kernel, src } = setup();
  write(src, "bin/tool", "clash\n"); git(src, "add", "-A"); git(src, "commit", "-q", "-m", "clash");
  assert.throws(() => ov.init(src, kernel), /overwrite kernel file/);
  assert.equal(fs.readFileSync(path.join(kernel, "bin/tool"), "utf8"), "kernel\n");
  assert.equal(ov.hasOverlay(kernel), false);
});

test("add tracks a file the kernel repo's .gitignore hides", () => {
  const { kernel, src } = setup();
  write(kernel, ".gitignore", "/.overlay.git/\n/data/\n"); git(kernel, "add", "-A"); git(kernel, "commit", "-q", "-m", "ignore data");
  ov.init(src, kernel);
  write(kernel, "data/new.json", "{}\n");
  const r = execFileSync(process.execPath, [path.resolve(path.dirname(new URL(import.meta.url).pathname), "../bin/jori-overlay"), "add", "data/new.json"],
    { cwd: kernel, env: { ...process.env, JORI_OVERLAY_GIT_DIR: path.join(kernel, ".overlay.git"), JORI_HOME: kernel } });
  assert.ok(ov.overlayFiles(kernel).includes("data/new.json"));
  assert.deepEqual(ov.check({ root: kernel }), []);
});
