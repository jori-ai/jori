// overlay.cjs — an installation's private overlay, checked out over the install.
//
// An install can keep its private files (agent/local/, data/, its own modules
// and apps) in a second git repository whose work tree is the install itself:
// the install's own git sees only the kernel, the overlay's git sees only the
// private files. The overlay's git dir is <install>/.overlay.git (or
// $JORI_OVERLAY_GIT_DIR), kept out of the kernel's git by .gitignore.
//
// What keeps the two apart:
//   - the kernel repo's .git/info/exclude carries a managed block listing every
//     overlay file (syncExcludes), so `git add -A` never picks one up;
//   - check() fails when a path is tracked by both, when an overlay file is
//     staged in the kernel repo (`--staged`, the pre-commit hook), or when the
//     exclude block is stale. With no overlay, every check passes.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { installRoot } = require("./root.cjs");

const BEGIN = "# >>> overlay files (managed by jori-overlay sync-excludes; do not edit)";
const END = "# <<< overlay files";

function overlayGitDir(root = installRoot()) {
  return process.env.JORI_OVERLAY_GIT_DIR || path.join(root, ".overlay.git");
}

function hasOverlay(root = installRoot()) {
  return fs.existsSync(path.join(overlayGitDir(root), "HEAD"));
}

function gitLines(args, opts = {}) {
  const out = execFileSync("git", args, { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"], ...opts }).toString();
  return out.split("\0").filter(Boolean);
}

/** Run git against the overlay (its git dir, the install as work tree). */
function overlayGit(args, root = installRoot(), opts = {}) {
  return execFileSync("git", ["--git-dir", overlayGitDir(root), "--work-tree", root, ...args], { maxBuffer: 1 << 30, ...opts });
}

function overlayFiles(root = installRoot()) {
  if (!hasOverlay(root)) return [];
  return gitLines(["--git-dir", overlayGitDir(root), "--work-tree", root, "ls-files", "-z"]);
}

function kernelFiles(root = installRoot()) {
  return gitLines(["-C", root, "ls-files", "-z"]);
}

function stagedKernelPaths(root = installRoot()) {
  return gitLines(["-C", root, "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]);
}

function excludePath(root = installRoot()) {
  const gd = execFileSync("git", ["-C", root, "rev-parse", "--git-dir"]).toString().trim();
  return path.join(path.isAbsolute(gd) ? gd : path.join(root, gd), "info", "exclude");
}

function block(files) {
  // A leading slash anchors each entry to the repo root; glob characters are escaped.
  const esc = (f) => "/" + f.replace(/([*?[\]\\!#])/g, "\\$1");
  return [BEGIN, ...files.slice().sort().map(esc), END].join("\n");
}

function currentBlock(text) {
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  return a >= 0 && b > a ? text.slice(a, b + END.length) : null;
}

/** Rewrite the managed block in the kernel repo's info/exclude. Returns the file count. */
function syncExcludes(root = installRoot()) {
  const file = excludePath(root);
  const files = overlayFiles(root);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* none yet */ }
  const cur = currentBlock(text);
  const want = block(files);
  const next = cur != null ? text.replace(cur, want) : (text && !text.endsWith("\n") ? text + "\n" : text) + want + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return files.length;
}

/** Problems, as strings; empty when the install and its overlay are kept apart. */
function check({ root = installRoot(), staged = false } = {}) {
  if (!hasOverlay(root)) return [];
  const issues = [];
  const ov = new Set(overlayFiles(root));
  const both = kernelFiles(root).filter((f) => ov.has(f));
  if (both.length) issues.push(`${both.length} path(s) tracked by both the kernel repo and the overlay: ${both.slice(0, 5).join(", ")}${both.length > 5 ? ", …" : ""}`);
  if (staged) {
    const st = stagedKernelPaths(root).filter((f) => ov.has(f));
    if (st.length) issues.push(`${st.length} overlay file(s) staged in the kernel repo: ${st.slice(0, 5).join(", ")}${st.length > 5 ? ", …" : ""} (unstage with git restore --staged)`);
  }
  let text = "";
  try { text = fs.readFileSync(excludePath(root), "utf8"); } catch { /* none */ }
  if (currentBlock(text) !== block([...ov])) issues.push("the overlay exclude block is missing or stale (run jori-overlay sync-excludes)");
  return issues;
}

/**
 * Check out an overlay repository over the install: a bare clone at the
 * overlay git dir whose work tree is the install, the overlay's files written,
 * untracked (kernel) files hidden from its status, then the exclude block.
 */
function init(source, root = installRoot()) {
  const gd = overlayGitDir(root);
  if (fs.existsSync(gd)) throw new Error(`${gd} already exists`);
  execFileSync("git", ["clone", "-q", "--bare", source, gd], { stdio: ["ignore", "pipe", "pipe"] });
  overlayGit(["config", "core.bare", "false"], root);
  overlayGit(["config", "core.worktree", root], root);
  overlayGit(["config", "status.showUntrackedFiles", "no"], root);
  // A bare clone keeps no remote-tracking refs; give it a normal clone's, so
  // `origin/<branch>` exists for the laptop<->host sync (jori-sync).
  overlayGit(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], root);
  overlayGit(["fetch", "-q", "origin"], root, { stdio: ["ignore", "pipe", "pipe"] });
  const branch = overlayGit(["symbolic-ref", "--short", "HEAD"], root).toString().trim();
  overlayGit(["branch", "-q", "--set-upstream-to", `origin/${branch}`, branch], root, { stdio: ["ignore", "pipe", "pipe"] });
  const collide = new Set(kernelFiles(root));
  const incoming = gitLines(["--git-dir", gd, "ls-tree", "-r", "-z", "--name-only", "HEAD"]);
  const clash = incoming.filter((f) => collide.has(f));
  if (clash.length) { fs.rmSync(gd, { recursive: true, force: true }); throw new Error(`overlay would overwrite kernel file(s): ${clash.slice(0, 5).join(", ")}`); }
  overlayGit(["reset", "-q", "--hard", "HEAD"], root);
  return { files: syncExcludes(root) };
}

module.exports = { BEGIN, END, overlayGitDir, hasOverlay, overlayGit, overlayFiles, syncExcludes, check, init };
