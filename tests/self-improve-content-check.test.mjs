// self-improve-content-check.test.mjs — pins the content checks every
// self-improvement door runs (lib/self-improve-content-check.mjs) and the
// bundling tool that replaces hand-written bundle commands (bin/self-improve-bundle).
// The incident it replays: a bundle written over a 2,000-line changelog.
//
// Run: node --test tests/self-improve-content-check.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isFilesBundle, largeRemovals, contentRefusals, removalNote, SHRINK_MIN_LINES } from "../lib/self-improve-content-check.mjs";

// The kernel directory this test sits in, and its place in a repo ("tools" here,
// "" where the kernel is the repo root): the sandbox repo mirrors that layout.
const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { KERNEL_SUBDIR } = createRequire(import.meta.url)("../lib/root.cjs");
const K = (rel) => (KERNEL_SUBDIR ? `${KERNEL_SUBDIR}/${rel}` : rel);

const lines = (n, word = "entry") => Array.from({ length: n }, (_, i) => `- ${word} ${i}`).join("\n") + "\n";
const bundleOf = (files) => JSON.stringify({ files });

test("a bundle is recognised by shape; ordinary JSON and text are not", () => {
  assert.equal(isFilesBundle(bundleOf({ "bin/x": "code" })), true);
  assert.equal(isFilesBundle(`  ${bundleOf({ "a/b.md": "x" })}\n`), true);
  assert.equal(isFilesBundle(JSON.stringify({ files: ["a/b"] })), false);
  assert.equal(isFilesBundle(JSON.stringify({ files: { name: "x" } })), false);   // keys are not paths
  assert.equal(isFilesBundle(JSON.stringify({ targets: [] })), false);
  assert.equal(isFilesBundle("# a changelog\n"), false);
  assert.equal(isFilesBundle("{ not json"), false);
});

test("the incident is refused: a bundle written over the changelog", () => {
  const changelog = "system/changelog.md";
  const files = {
    [changelog]: bundleOf({ "bin/daily-summary-fix": "code", "tests/t.test.mjs": "test" }),
    "bin/daily-summary-fix": "code",
  };
  const reasons = contentRefusals({ files, before: { [changelog]: lines(2023), "bin/daily-summary-fix": "old" } });
  assert.equal(reasons.length, 2, reasons.join("\n"));
  assert.ok(reasons[0].includes("changelog.md: its new content is a self-improve bundle"), reasons[0]);
  assert.ok(reasons[1].includes("changelog.md: would go from 2024 lines to 1"), reasons[1]);
});

test("large removals: both the fraction and the floor must be met", () => {
  const before = { "a/big.md": lines(1000), "a/small.md": lines(150), "a/trim.md": lines(1000), "a/new.md": null };
  const files = {
    "a/big.md": lines(10),          // -990 lines, 99% → large
    "a/small.md": lines(1),         // -149 lines, under the floor → fine
    "a/trim.md": lines(500),        // -500 lines, 50% → fine
    "a/new.md": "",                 // a new file never counts
  };
  assert.deepEqual(largeRemovals({ files, before }).map((r) => r.rel), ["a/big.md"]);
  assert.ok(SHRINK_MIN_LINES <= 200);
});

test("a declared large removal passes and is named on the card", () => {
  const files = { "a/big.md": lines(10) }, before = { "a/big.md": lines(1000) };
  assert.equal(contentRefusals({ files, before }).length, 1);
  assert.deepEqual(contentRefusals({ files, before, allowShrink: ["a/big.md"] }), []);
  assert.equal(removalNote({ files, before }), "Large removals: a/big.md 1,001 → 11 lines.");
  assert.equal(removalNote({ files: { "a/big.md": lines(990) }, before }), "");
});

test("a file that already held a bundle (a fixture) may keep one", () => {
  const fixture = bundleOf({ "a/b.md": "x" });
  assert.deepEqual(contentRefusals({ files: { "t/fixture.json": bundleOf({ "a/b.md": "y" }) }, before: { "t/fixture.json": fixture } }), []);
  assert.equal(contentRefusals({ files: { "t/fixture.json": fixture }, before: { "t/fixture.json": "{}" } }).length, 1);
});

// The CLI, run from a throwaway repo holding just the tool and its libraries.
const CHANGELOG = K("system/changelog.md"), CODE = K("system/code.mjs");
function sandboxRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "si-bundle-"));
  for (const rel of ["bin/self-improve-bundle", "lib/self-improve-content-check.mjs", "lib/root.cjs", "lib/overlay.cjs"]) {
    fs.mkdirSync(path.join(dir, path.dirname(K(rel))), { recursive: true });
    fs.copyFileSync(path.join(KERNEL, rel), path.join(dir, K(rel)));
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  fs.mkdirSync(path.join(dir, path.dirname(K("system/x"))), { recursive: true });
  fs.writeFileSync(path.join(dir, CHANGELOG), lines(2023));
  fs.writeFileSync(path.join(dir, CODE), "export const a = 1;\n");
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "si-bundle-out-"));
  const env = { ...process.env };
  delete env.JORI_HOME;   // never the caller's installation
  delete env.JORI_OVERLAY_GIT_DIR;   // nor its overlay: the sandbox's own <dir>/.overlay.git, if a test makes one
  return { dir, out, rev: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(),
    run: (...args) => spawnSync(process.execPath, [path.join(dir, K("bin/self-improve-bundle")), ...args], { cwd: dir, encoding: "utf8", env }),
    cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); } };
}

test("bundle CLI: builds the bundle with base_sha256 from the working tree", (t) => {
  const s = sandboxRepo(); t.after(s.cleanup);
  fs.writeFileSync(path.join(s.dir, CODE), "export const a = 2;\n");
  fs.appendFileSync(path.join(s.dir, CHANGELOG), "- one more\n");
  const out = path.join(s.out, "b.json");
  const r = s.run("--out", out, "--base-rev", s.rev, CODE, CHANGELOG);
  assert.equal(r.status, 0, r.stderr);
  const item = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(item.files[CODE], "export const a = 2;\n");
  assert.equal(item.files[CHANGELOG].split("\n").length, 2025);
  assert.equal(item.base_sha256[CODE], createHash("sha256").update("export const a = 1;\n").digest("hex"));
});

test("bundle CLI: refuses a truncated file and writes nothing", (t) => {
  const s = sandboxRepo(); t.after(s.cleanup);
  fs.writeFileSync(path.join(s.dir, CHANGELOG), bundleOf({ [CODE]: "x" }));
  const out = path.join(s.out, "b.json");
  const r = s.run("--out", out, CHANGELOG);
  assert.equal(r.status, 65);
  assert.ok(r.stderr.includes("self-improve bundle"), r.stderr);
  assert.equal(fs.existsSync(out), false);
});

test("bundle CLI: --allow-shrink lets a declared removal through and records it", (t) => {
  const s = sandboxRepo(); t.after(s.cleanup);
  fs.writeFileSync(path.join(s.dir, CHANGELOG), "# trimmed\n");
  const out = path.join(s.out, "b.json");
  const r = s.run("--out", out, "--allow-shrink", CHANGELOG, CHANGELOG);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).allow_shrink, [CHANGELOG]);
});

test("bundle CLI: --out inside the repo, or equal to an input, is refused", (t) => {
  const s = sandboxRepo(); t.after(s.cleanup);
  const inRepo = s.run("--out", path.join(s.dir, "bundle.json"), CODE);
  assert.equal(inRepo.status, 64);
  assert.ok(inRepo.stderr.includes("outside the repo"), inRepo.stderr);
  const self = s.run("--out", path.join(s.dir, CHANGELOG), CHANGELOG);
  assert.equal(self.status, 64);
  assert.equal(fs.readFileSync(path.join(s.dir, CHANGELOG), "utf8"), lines(2023));
});

// Overlay files (lib/overlay.cjs): an install's private files live in a second
// repository whose git dir is <root>/.overlay.git and whose work tree is the
// install, so the kernel repo has no committed version of them. The bundle reads
// theirs from the overlay's HEAD. Guards the landing refusal
// "<path> did not exist when this fix was written, and it does now" (exit 7 from
// self-improve-auto-apply) that every fix to an overlay file used to hit.
const OVERLAY_FILE = K("agent/local/config/x.json");
function withOverlay(s, content) {
  const gd = path.join(s.dir, ".overlay.git");
  const ov = (...a) => execFileSync("git", ["--git-dir", gd, "--work-tree", s.dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: s.dir, stdio: "ignore" });
  execFileSync("git", ["init", "-q", "--bare", gd], { stdio: "ignore" });
  ov("config", "core.bare", "false");
  ov("config", "status.showUntrackedFiles", "no");
  fs.mkdirSync(path.join(s.dir, path.dirname(OVERLAY_FILE)), { recursive: true });
  fs.writeFileSync(path.join(s.dir, OVERLAY_FILE), content);
  ov("add", "--", OVERLAY_FILE);
  ov("commit", "-q", "-m", "overlay base");
  // The kernel repo does not track it: its only committed version is the overlay's.
  assert.equal(execFileSync("git", ["ls-files", "--", OVERLAY_FILE], { cwd: s.dir, encoding: "utf8" }), "");
}

test("bundle CLI: an overlay-tracked file's base_sha256 is the overlay's committed version", (t) => {
  const s = sandboxRepo(); t.after(s.cleanup);
  const committed = JSON.stringify({ a: 1 }, null, 2) + "\n";
  withOverlay(s, committed);
  fs.writeFileSync(path.join(s.dir, OVERLAY_FILE), JSON.stringify({ a: 2 }, null, 2) + "\n");
  fs.writeFileSync(path.join(s.dir, CODE), "export const a = 2;\n");
  const out = path.join(s.out, "b.json");
  const r = s.run("--out", out, "--base-rev", s.rev, OVERLAY_FILE, CODE);
  assert.equal(r.status, 0, r.stderr);
  const item = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(item.files[OVERLAY_FILE], JSON.stringify({ a: 2 }, null, 2) + "\n");
  assert.equal(item.base_sha256[OVERLAY_FILE], createHash("sha256").update(committed).digest("hex"));
  // A kernel file in the same bundle still takes its base from the kernel commit.
  assert.equal(item.base_sha256[CODE], createHash("sha256").update("export const a = 1;\n").digest("hex"));
});

test("bundle CLI: a truncated overlay file is refused like a kernel file", (t) => {
  const s = sandboxRepo(); t.after(s.cleanup);
  withOverlay(s, lines(1000));
  fs.writeFileSync(path.join(s.dir, OVERLAY_FILE), lines(5));
  const out = path.join(s.out, "b.json");
  const r = s.run("--out", out, "--base-rev", s.rev, OVERLAY_FILE);
  assert.equal(r.status, 65, r.stderr);
  assert.ok(r.stderr.includes(`${OVERLAY_FILE}: would go from 1001 lines to 6`), r.stderr);
  assert.equal(fs.existsSync(out), false);
  // Declared, it passes, and still carries the overlay base.
  const ok = s.run("--out", out, "--base-rev", s.rev, "--allow-shrink", OVERLAY_FILE, OVERLAY_FILE);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).base_sha256[OVERLAY_FILE], createHash("sha256").update(lines(1000)).digest("hex"));
});

test("bundle CLI: a file neither repo tracks is new, with or without an overlay", (t) => {
  for (const overlay of [false, true]) {
    const s = sandboxRepo(); t.after(s.cleanup);
    if (overlay) withOverlay(s, "{}\n");
    const rel = K("agent/local/config/new.json");
    fs.mkdirSync(path.join(s.dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(s.dir, rel), "{\"fresh\": true}\n");
    const out = path.join(s.out, "b.json");
    const r = s.run("--out", out, "--base-rev", s.rev, rel);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).base_sha256, {}, `overlay=${overlay}`);
  }
});
