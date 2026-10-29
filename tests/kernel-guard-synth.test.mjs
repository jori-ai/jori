// kernel-guard in a switched install: no kernel-manifest.json, a private
// overlay checked out over the kernel checkout instead. The kernel is what the
// kernel repo tracks, the personal files are the overlay's, and the derived
// detectors read the overlay's registries.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const BIN = path.resolve(HERE, "../bin/kernel-guard");
const kg = require("../lib/kernel-guard.cjs");
const ov = require("../lib/overlay.cjs");
// The kernel tree inside a repo: tools/ here, the repo root in a root-layout install.
const { KERNEL_SUBDIR } = require("../lib/root.cjs");
const K = (p) => (KERNEL_SUBDIR ? `${KERNEL_SUBDIR}/${p}` : p);
delete process.env.JORI_OVERLAY_GIT_DIR;

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { env: ENV, stdio: ["ignore", "pipe", "pipe"] }).toString();
const write = (root, p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
const PATTERNS = { version: 1, patterns: [{ name: "owner_name", group: "people", severity: "hard", flags: "i", regex: "\\bZorbulon\\b" }] };

function setup({ overlay = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kg-synth-"));
  const root = path.join(tmp, "install"), src = path.join(tmp, "overlay-src");
  fs.mkdirSync(root); fs.mkdirSync(src);
  git(root, "init", "-q");
  write(root, K("lib/generic.mjs"), "export const x = 1;\n");
  write(root, K("lib/icon.png"), "\x89PNG Zorbulon noise\n");
  write(root, ".gitignore", "/.overlay.git/\n");
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "kernel");
  git(src, "init", "-q");
  write(src, K("system/personal-patterns.json"), JSON.stringify(PATTERNS));
  write(src, K("browsing-skills/skills/frobtix.com/SKILL.md"), "# a personal site skill\n");
  write(src, K("bin/zorp-watch"), "#!/bin/sh\n");
  write(src, K("agent/local/instance.json"), "{}\n");
  git(src, "add", "-A"); git(src, "commit", "-q", "-m", "overlay");
  if (overlay) ov.init(src, root);
  return root;
}
const run = (root, ...args) => spawnSync(process.execPath, [BIN, "--root", root, "--patterns", path.join(root, K("system/personal-patterns.json")), ...args], { encoding: "utf8", env: ENV });

test("no overlay and no manifest: nothing to synthesize", () => {
  assert.equal(kg.synthManifest(setup({ overlay: false })), null);
});

test("the kernel is the kernel repo's files, the personal files the overlay's; media is classified, not scanned", () => {
  const root = setup();
  const m = kg.synthManifest(root);
  assert.ok(m._synthesized);
  assert.deepEqual(Object.keys(m.files).sort(), [K("lib/generic.mjs")]);
  assert.ok(K("lib/icon.png") in m.jori_owned && ".gitignore" in m.jori_owned);
  const c = kg.classifier(m);
  assert.equal(c.status(K("bin/zorp-watch")), "personal");
  assert.equal(run(root).status, 0, "the PNG's bytes are not read as text");
});

test("personal data in a kernel file is a hard hit; the overlay's registries feed the derived detectors", () => {
  const root = setup();
  write(root, K("lib/generic.mjs"), "// Zorbulon asked for this\nexport const x = 1;\n");
  let r = run(root, "--json", "--report");
  assert.ok(JSON.parse(r.stdout).hits.some((h) => h.status === "hard" && h.pattern === "owner_name"));
  // The overlay's site skill is a personal registry: its name is a derived token
  // (until the kernel itself uses the word, which makes it the kernel's).
  write(root, K("lib/generic.mjs"), "export const x = 1;\n");
  const t = kg.derivedTable(root, kg.synthManifest(root), PATTERNS, {});
  assert.ok([...t.tokens.keys()].some((k) => /frobtix/.test(k)), "the site skill lives in the overlay and still counts");
});

test("a new file in neither repo is unclassified until one of them tracks it", () => {
  const root = setup();
  write(root, K("lib/brand-new.mjs"), "export {};\n");
  git(root, "add", "-f", K("lib/brand-new.mjs")); git(root, "rm", "-q", "--cached", K("lib/brand-new.mjs"));
  const m = kg.synthManifest(root);
  assert.deepEqual(kg.unclassified([K("lib/brand-new.mjs")], m), [K("lib/brand-new.mjs")]);
  const reasons = kg.changeRefusals({ files: { [K("lib/brand-new.mjs")]: "export {};\n" }, before: {}, manifest: m, patterns: null });
  assert.match(reasons.join("\n"), /is in neither repo: add it to the kernel repo \(generic\) or to the overlay/);
  ov.overlayGit(["add", "-f", K("lib/brand-new.mjs")], root, { env: ENV });
  assert.deepEqual(kg.unclassified([K("lib/brand-new.mjs")], kg.synthManifest(root)), []);
});
