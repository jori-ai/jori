// jori-commit-manifest.test.mjs — the manifest must describe what the CALLER
// declared, not whatever happens to be in the index.
//
// The bug this pins (2026-08-09): the manifest was built from
// `git diff --cached --name-only`, and the pre-commit hook checks
// "staged ⊆ manifest" — so the check compared the staged set against itself and
// could never fail. Anything a concurrent session had already staged in the
// shared index rode into the commit silently.
//
// It happened twice in one day, once in each direction, and both were pushed:
// each of two concurrent sessions' commits swallowed work the other had
// staged. Neither commit message described what it contained.
//
// These tests drive a real throwaway repo, because the failure was an
// interaction between the tool, the hook and git's index — not something any
// single unit could have shown.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT_BIN = path.join(ROOT, "bin", "jori-commit");
// A stand-in for an installation's pre-commit hook, with the one contract
// jori-commit relies on: a commit must be declared (JORI_COMMIT_MANIFEST, or the
// JORI_ALLOW_BARE_COMMIT escape hatch) and every staged path must be in the
// declaration. The test does not need the installation's own hook.
const HOOK_SRC = `#!/usr/bin/env bash
if [ -z "\${JORI_COMMIT_MANIFEST:-}" ]; then
  [ "\${JORI_ALLOW_BARE_COMMIT:-}" = "1" ] && exit 0
  echo "pre-commit: undeclared commit" >&2; exit 1
fi
extra=$(comm -23 <(git diff --cached --name-only | sort -u) <(sort -u "$JORI_COMMIT_MANIFEST"))
[ -z "$extra" ] || { echo "pre-commit: staged but not declared: $extra" >&2; exit 1; }
`;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });
}

/** A real git repo with the real hook wired in, thrown away after. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-test-"));
  sh("git", ["init", "-q", dir]);
  const g = (...a) => sh("git", ["-C", dir, ...a]);
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  const hooks = path.join(dir, ".githooks");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "pre-commit"), HOOK_SRC);
  fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);
  g("config", "core.hooksPath", ".githooks");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  g("add", "seed.txt");
  // The hook refuses undeclared non-interactive commits — which is its job, and
  // it fires on our own seed. Use the documented escape hatch for setup only.
  sh("git", ["-C", dir, "commit", "-q", "-m", "seed"], { env: { ...process.env, JORI_ALLOW_BARE_COMMIT: "1" } });
  return { dir, g };
}

function runCommit(dir, args) {
  try {
    const stdout = sh(COMMIT_BIN, args, { cwd: dir });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

test("a foreign staged file is REFUSED, not swept into the commit", () => {
  const { dir, g } = makeRepo();
  fs.writeFileSync(path.join(dir, "mine.txt"), "mine\n");
  fs.writeFileSync(path.join(dir, "theirs.txt"), "theirs\n");
  // Another session stages its work in the shared index first.
  g("add", "theirs.txt");

  const r = runCommit(dir, ["-m", "just mine", "--", "mine.txt"]);

  assert.equal(r.code, 3, `expected refusal, got ${r.code}\n${r.stderr}`);
  assert.match(r.stderr, /theirs\.txt/, "the refusal must name the foreign file");
  // And nothing was committed.
  const head = sh("git", ["-C", dir, "log", "--oneline"], {}).trim().split("\n");
  assert.equal(head.length, 1, "no commit should have been created");
});

test("--unstage-foreign commits only the declared file and leaves theirs on disk", () => {
  const { dir, g } = makeRepo();
  fs.writeFileSync(path.join(dir, "mine.txt"), "mine\n");
  fs.writeFileSync(path.join(dir, "theirs.txt"), "theirs\n");
  g("add", "theirs.txt");

  const r = runCommit(dir, ["-m", "just mine", "--unstage-foreign", "--", "mine.txt"]);
  assert.equal(r.code, 0, `expected success, got ${r.code}\n${r.stderr}`);

  const files = sh("git", ["-C", dir, "show", "--name-only", "--format=", "HEAD"]).trim().split("\n").filter(Boolean);
  assert.deepEqual(files, ["mine.txt"], "the commit must contain only the declared file");

  // Unstaged, never discarded — the other session's content is intact.
  assert.equal(fs.readFileSync(path.join(dir, "theirs.txt"), "utf8"), "theirs\n");
});

test("the ordinary case still works: declared files commit cleanly", () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");

  const r = runCommit(dir, ["-m", "two files", "--", "a.txt", "b.txt"]);
  assert.equal(r.code, 0, `expected success, got ${r.code}\n${r.stderr}`);

  const files = sh("git", ["-C", dir, "show", "--name-only", "--format=", "HEAD"]).trim().split("\n").filter(Boolean);
  assert.deepEqual(files.sort(), ["a.txt", "b.txt"]);
});

test("a declared DIRECTORY covers the files beneath it", () => {
  // Regression guard for the fix itself: resolving the manifest through
  // `git diff --cached -- <path>` is what makes a directory work. A naive
  // string comparison would call every file inside it foreign.
  const { dir } = makeRepo();
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "x.txt"), "x\n");
  fs.writeFileSync(path.join(dir, "sub", "y.txt"), "y\n");

  const r = runCommit(dir, ["-m", "a directory", "--", "sub"]);
  assert.equal(r.code, 0, `expected success, got ${r.code}\n${r.stderr}`);

  const files = sh("git", ["-C", dir, "show", "--name-only", "--format=", "HEAD"]).trim().split("\n").filter(Boolean);
  assert.deepEqual(files.sort(), ["sub/x.txt", "sub/y.txt"]);
});
