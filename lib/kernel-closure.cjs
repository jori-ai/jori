"use strict";
// kernel-closure.cjs — the kernel's closure check (`kernel-guard --closure`).
//
// Generic, like kernel-guard.cjs. The published kernel is a mechanical copy of
// the kernel files, so a kernel file may only lean on what that copy carries:
//
//   1. imports — every static import / require / `source` in a kernel file
//      that names a repo file (a relative specifier, a __dirname join, a
//      sibling script) resolves to a KERNEL file. Node built-ins and npm
//      packages are fine. An import of a personal file has no exception: give
//      the kernel a hook (lib/ext-hooks.mjs, an _ext/ dir) instead.
//   2. paths — every other reference from kernel code to a repo path (a bin
//      run by path, a data or config file, a script a plist launches) is to
//        - a kernel file, a directory holding kernel files, or a file the
//          manifest lists as `jori_owned` (Jori keeps its own copy), or
//        - a runtime path the manifest allows (`closure_runtime_paths`:
//          state and data the installation writes, the local config dir, logs,
//          secrets, the _ext/ hook dirs), or
//        - a guarded one: the code checks it exists / tolerates its absence on
//          that line or within GUARD_WINDOW lines (existsSync, `[ -x ]`,
//          `command -v`, try/catch, `|| true`, `2>/dev/null`), or the line
//          (or the one above) carries `kernel-closure-ok: <reason>`.
//
//   3. portability — kernel code finds the installation through
//      lib/root.cjs (installRoot(), installTools(), TOOLS_DIR) or
//      scripts/lib/root.sh ($JORI_INSTALL_TOOLS, $JORI_TOOLS), and node
//      through root.cjs nodeBin() / process.execPath or root.sh $JORI_NODE —
//      never by spelling the install path (~/Dev/jori, "Dev/jori/...") or
//      Homebrew's node (/opt/homebrew/bin/node) in code. Comments and doc files
//      are not code. Code written before this rule is held to a ratchet: the
//      manifest's `install_path_allowance` ({file: count}) records how many such
//      lines each file still has, and a file over its count (a new file: over
//      zero) is a violation. `kernel-guard --closure --write-install-allowance`
//      records the current counts (run it after converting lines, so the
//      allowance only shrinks); `kernel-closure-ok: <reason>` on the line (or
//      the one above) exempts one.
//
// What counts as a path reference (comments are skipped):
//   tools/<area>/...           (optionally after ~/, $HOME/, Dev/jori/, or a
//                               root variable: "$ROOT/...", `${X}/...`)
//   $JORI_TOOLS/..., $JORI_INSTALL_TOOLS/..., __JORI_TOOLS__/..., ${TOOLS}/...
//   ${BIN}/<name>, path.join(BIN, "<name>")
//   path.join(TOOLS_DIR | installTools() | ..., "a/b"), installTools("a"), toolsPath("a")
//   path.join(<root>, "tools", "a", ...)
// A reference whose tail is computed (`${x}`, `$x`, a glob) is judged by its
// static prefix: a directory reference.

const fs = require("node:fs");
const path = require("node:path");
// The kernel tree inside the repo: "tools" in the old layout, the repo root in
// a root-layout install. A reference to the kernel tree resolves under it.
const { KERNEL_SUBDIR } = require("./root.cjs");
const TREE = KERNEL_SUBDIR ? `${KERNEL_SUBDIR}/` : "";

const AREAS = ["agent", "bin", "lib", "system", "tests", "docs", "data", "browsing-skills", "wiki-worker", "githooks", "secrets", "credentials", "logs", "day-path", "firebase", "cf-email-worker", "sonos-cli"];
const AREA_RX = AREAS.map((a) => a.replace(/[-]/g, "\\-")).join("|");
const GUARD_WINDOW = 4;
const GUARD_RX = /existsSync|accessSync|fs\.access\b|statSync|\[\[? +!? *-[fxedsrL] |\btest +-[fxedL] |command -v|\|\| *true|2> *\/dev\/null|\bcatch\b|\btry\b|\boptional\b|loadHook|\b_ext\b|ENOENT/;
const OK_MARKER = /kernel-closure-ok:\s*\S/;
// A bare "tools/..." string counts as a path only on a line that uses it as one
// (a test's fixture data — a list of file names a function is handed — is not a
// dependency). Shell and plist lines always count.
const PATH_USE_RX = /path\.(?:join|resolve)|readFile|writeFile|appendFile|existsSync|statSync|readdirSync|copyFile|symlink|spawn|exec|require\(|import\(|new URL\(|\$HOME|\$\{HOME\}|~\/|homedir|Dev\/jori|__JORI_|\$\{?\w*(?:TOOLS|ROOT|BIN|REPO)\b|"(?:script|command|args|cwd|path|file|bin)"\s*:|\bnode\s|\bbash\s|`[^`]*bin\//;
const CODE_EXT = /\.(?:m?js|cjs|sh|bash|zsh|py|plist|json)$/;
const JS_EXT = /\.(?:m?js|cjs)$/;
const TEST_RX = /(?:^|\/)(?:tests?)\/|\.test\.m?js$/;
const NODE_EXTS = ["", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs", "/index.cjs"];
// Used when the manifest has no `closure_runtime_paths`.
const DEFAULT_RUNTIME = [
  "data/**", "agent/local/**", "agent/logs/**", "agent/supervisor/state/**",
  "secrets/**", "credentials/**", ".env", "logs/**", "**/_ext/**", "**/_ext",
  "agent/whatsapp-channel/wa-auth/**", "browsing-skills/skills/**",
];

// Rule 3: spelling the install path or Homebrew's node in code. root.cjs and
// root.sh are where the default install path and the node fallback list live.
const INSTALL_PATH_RX = /Dev\/jori(?![\w-])|["']dev["']\s*,\s*["']jori["']|\/opt\/homebrew\/bin\/node\b/;
const INSTALL_PATH_HOME = new Set(["lib/root.cjs", "agent/scripts/lib/root.sh", "lib/places_local.py"]);

/** The code part of a line: "" for a comment line, the text before a trailing ` // ` / ` # ` comment otherwise. */
function codePart(line) {
  if (isComment(line)) return "";
  const m = /\s(?:\/\/|#)\s/.exec(line);
  return m ? line.slice(0, m.index) : line;
}

/** Code lines of a kernel file that spell the install path or Homebrew's node: [{ line, text }]. */
function installPathRefs(rel, text) {
  if (INSTALL_PATH_HOME.has(rel)) return [];
  const lines = text.split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!INSTALL_PATH_RX.test(codePart(lines[i]))) continue;
    if (OK_MARKER.test(lines[i]) || OK_MARKER.test(lines[i - 1] || "")) continue;
    out.push({ line: i + 1, text: lines[i].trim().slice(0, 160) });
  }
  return out;
}

/** Is this kernel file one whose contents are code (scanned for closure)? */
function isCode(rel, head) {
  if (CODE_EXT.test(rel)) return true;
  if (/\.[A-Za-z0-9]+$/.test(path.basename(rel))) return false;
  return /^#!/.test(head || "");
}

const isComment = (line) => /^\s*(?:\/\/|#(?!!)|\*|\/\*)/.test(line) && !/^\s*#!/.test(line);

/** Literal string arguments "a", 'b' in a comma-separated list → ["a","b"] (null if any is not literal). */
function literalArgs(s) {
  const parts = [];
  const rx = /\s*(["'])([^"'`$]*)\1\s*(,|$)/y;
  let m;
  rx.lastIndex = 0;
  while (rx.lastIndex < s.length && (m = rx.exec(s))) {
    parts.push(m[2]);
    if (!m[3]) break;
  }
  return parts.length ? parts : null;
}

/** Cut a referenced path at its first computed part; returns { rel, dynamic }. */
function staticPart(p) {
  let s = p.replace(/[?#].*$/, "");
  let dynamic = false;
  const cut = s.search(/\$|\*|<|%|\{|\[/);
  if (cut !== -1) { s = s.slice(0, cut); dynamic = true; }
  s = s.replace(/[.,;:)\]}>"'`\\]+$/, "");
  if (dynamic) s = s.replace(/[^/]*$/, ""); // a partial name: judge its directory
  s = s.replace(/\/+$/, "");
  return { rel: s, dynamic };
}

function norm(p) {
  return path.posix.normalize(p).replace(/^\.\//, "");
}

/**
 * The references in one kernel file: [{ line, kind: "import"|"path", target, dynamic, text }].
 * `target` is repo-relative (under the kernel tree, TREE).
 */
function references(rel, text) {
  const out = [];
  const dir = path.posix.dirname(rel);
  const lines = text.split("\n");
  const js = JS_EXT.test(rel) || /^#!.*\bnode\b/.test(lines[0] || "");
  const sh = /\.(?:sh|bash|zsh)$/.test(rel) || /^#!.*\b(?:ba|z)?sh\b/.test(lines[0] || "");
  const py = /\.py$/.test(rel) || /^#!.*python/.test(lines[0] || "");
  const add = (i, kind, target, dynamic = false) => {
    if (!target) return;
    out.push({ line: i + 1, kind, target: norm(target), dynamic, text: lines[i].trim().slice(0, 160) });
  };
  const toolsRef = (i, tail) => {
    const { rel: r, dynamic } = staticPart(tail);
    if (r) add(i, "path", `${TREE}${r}`, dynamic);
  };
  let pyLibOnPath = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    let m;
    if (js) {
      // import ... from "x" | export ... from "x" | import "x" | import("x") | require("x")
      const rxs = [/^\s*(?:import|export)\b[^"'`]*\bfrom\s+(["'])([^"']+)\1/g, /^\s*\}\s*from\s+(["'])([^"']+)\1/g, /^\s*import\s+(["'])([^"']+)\1/g, /\bimport\(\s*(["'])([^"'$]+)\1\s*\)/g, /\bimport\(\s*new URL\(\s*(["'])(\.[^"'$]*)\1/g, /\brequire\(\s*(["'])([^"'$]+)\1\s*\)/g];
      for (const rx of rxs) {
        while ((m = rx.exec(line))) {
          const spec = m[2];
          if (spec.startsWith(".")) add(i, "import", path.posix.join(dir, spec));
        }
      }
      // new URL("./x", import.meta.url) outside an import(): a path
      const nu = /(?<!import\(\s*)\bnew URL\(\s*(["'])(\.[^"'$]*)\1\s*,\s*import\.meta\.url/g;
      while ((m = nu.exec(line))) add(i, "path", path.posix.join(dir, m[2]));
      // path.join/resolve(__dirname | import.meta.dirname, "a", "b")
      const dj = /path\.(?:join|resolve)\(\s*(?:__dirname|import\.meta\.dirname)\s*,([^)]*)\)/g;
      while ((m = dj.exec(line))) {
        const args = literalArgs(m[1]);
        if (args) add(i, /require\(\s*path\.(?:join|resolve)/.test(line.slice(0, m.index + 20)) ? "import" : "path", path.posix.join(dir, ...args));
      }
      // path.join(TOOLS_DIR | installTools() | TOOLS, "a/b") ; installTools("a") ; toolsPath("a")
      const tj = /path\.(?:join|resolve)\(\s*(?:TOOLS_DIR|JORI_TOOLS|TOOLS|installTools\(\)|toolsPath\(\))\s*,([^)]*)\)/g;
      while ((m = tj.exec(line))) { const a = literalArgs(m[1]); if (a) toolsRef(i, a.join("/")); }
      const tf = /\b(?:installTools|toolsPath)\(([^)]+)\)/g;
      while ((m = tf.exec(line))) { const a = literalArgs(m[1]); if (a) toolsRef(i, a.join("/")); }
      // path.join(BIN | BIN_DIR, "name")
      const bj = /path\.join\(\s*(?:BIN|BIN_DIR|BINDIR)\s*,\s*(["'])([^"'$]+)\1/g;
      while ((m = bj.exec(line))) toolsRef(i, `bin/${m[2]}`);
      // path.join(<root>, "tools", "a", ...)
      const sj = /(["'])tools\1\s*,([^)]*)\)/g;
      while ((m = sj.exec(line))) {
        if (/["']\s*,\s*$/.test(line.slice(0, m.index))) continue; // an inner "tools" (browsing-skills/tools)
        const a = literalArgs(m[2]); if (a) toolsRef(i, a.join("/"));
      }
    }
    if (sh) {
      // source / . of a sibling script
      const src = /(?:^|[;&|]\s*|\s)(?:source|\.)\s+"?(?:\$\(\s*(?:cd\s+)?"?\$\(dirname\s+"?\$\{?(?:0|BASH_SOURCE\[0\])\}?"?\)"?(?:\s*&&\s*pwd)?\s*\)|\$\{?(?:SCRIPT_DIR|SCRIPTDIR|HERE|DIR|SCRIPTS|_here)\}?)\/([^"\s;)]+)/g;
      while ((m = src.exec(line))) add(i, "import", path.posix.join(dir, m[1]));
    }
    if (py) {
      if (/sys\.path\.(?:insert|append)\(.*["']lib["']/.test(line)) pyLibOnPath = true;
      if (pyLibOnPath && (m = /^\s*(?:from\s+([A-Za-z_]\w*)\s+import|import\s+([A-Za-z_]\w*))/.exec(line))) {
        add(i, "pymod", `lib/${m[1] || m[2]}.py`);
      }
    }
    // tools/<area>/... after nothing, ~/, $HOME/, Dev/jori/, or a root variable
    const usesPath = sh || /\.plist$/.test(rel) || PATH_USE_RX.test(line);
    const tr = new RegExp(`tools\\/((?:${AREA_RX})(?:\\/[^\\s"'\`)\\]},;|<>]*)?|\\.env\\b)`, "g");
    while (usesPath && (m = tr.exec(line))) {
      const pre = line.slice(0, m.index);
      if (/[\w.-]$/.test(pre)) continue;
      if (TEST_RX.test(rel) && /\/Users\/[^/\s]+\/Dev\/jori\/$/.test(pre)) continue; // a test's machine-path fixture text
      if (pre.endsWith("/")) {
        const seg = /([^\s/"'`(=:]*)\/$/.exec(pre)[1];
        if (!/^(?:jori|__JORI_HOME__|\$\{?\w*\}?|\w*(?:ROOT|REPO|HOME|JORI|INSTALL)\w*\}?|\$\{[^}]*\})$/.test(seg) || /skills$/.test(seg)) continue;
      }
      toolsRef(i, m[1]);
    }
    // the kernel tree by variable / placeholder
    const vr = new RegExp(`(?:__JORI_TOOLS__|\\$\\{?(?:JORI_TOOLS|JORI_INSTALL_TOOLS|TOOLS|TOOLS_DIR)\\}?)\\/((?:${AREA_RX})(?:\\/[^\\s"'\`)\\]},;|<>]*)?|\\.env\\b)`, "g");
    while ((m = vr.exec(line))) toolsRef(i, m[1]);
    const br = /\$\{?(?:BIN|BIN_DIR|BINDIR)\}?\/([\w.@+-]+)/g;
    while ((m = br.exec(line))) toolsRef(i, `bin/${m[1]}`);
  }
  // one entry per (line, target)
  const seen = new Set();
  return out.filter((r) => { const k = `${r.line}\0${r.kind}\0${r.target}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Judge every reference of the given kernel files.
 * opts: { manifest, classifier (kernel-guard.cjs), exists(rel) → bool, files: [{ rel, text }] }
 * Returns [{ file, line, kind, target, status, reason, text }] — only violations.
 */
function closureViolations({ manifest, classifier, exists, files }) {
  const c = classifier(manifest);
  const { globToRegExp } = require("./kernel-guard.cjs");
  const runtime = ((manifest && manifest.closure_runtime_paths) || DEFAULT_RUNTIME).map((g) => globToRegExp(g));
  const kernelDirs = new Set();
  for (const f of c.files) for (let d = path.posix.dirname(f); d && d !== "."; d = path.posix.dirname(d)) kernelDirs.add(d);
  const isRuntime = (t) => runtime.some((rx) => rx.test(t) || rx.test(t + "/"));
  const resolveImport = (t) => {
    for (const ext of NODE_EXTS) {
      const cand = norm(t + ext);
      if (c.kernel(cand) || (c.owned && c.owned(cand))) return { status: "kernel", target: cand };
    }
    for (const ext of NODE_EXTS) {
      const cand = norm(t + ext);
      if (exists(cand)) return { status: c.personal(cand) ? "personal" : "unclassified", target: cand };
    }
    return { status: "missing", target: t };
  };
  const out = [];
  for (const { rel, text } of files) {
    const lines = text.split("\n");
    const guarded = (ln) => {
      if (OK_MARKER.test(lines[ln - 1] || "") || OK_MARKER.test(lines[ln - 2] || "")) return true;
      for (let j = Math.max(0, ln - 1 - GUARD_WINDOW); j <= Math.min(lines.length - 1, ln - 1 + GUARD_WINDOW); j++) if (GUARD_RX.test(lines[j])) return true;
      return false;
    };
    const marked = (ln) => OK_MARKER.test(lines[ln - 1] || "") || OK_MARKER.test(lines[ln - 2] || "");
    for (const r of references(rel, text)) {
      if (r.kind === "import") {
        if (/(^|\/)_ext(\/|$)/.test(r.target)) continue; // hook modules: optional by contract
        const res = resolveImport(r.target);
        if (res.status === "kernel") continue;
        if (res.status === "missing" && guarded(r.line)) continue;
        if (res.status === "missing" && TEST_RX.test(rel)) continue; // a test's fixture source (written to a temp dir)
        if (marked(r.line)) continue;
        out.push({ file: rel, ...r, target: res.target, status: res.status, reason: res.status === "missing" ? "imports a file that does not exist" : `imports a ${res.status} file` });
        continue;
      }
      if (r.kind === "pymod") {
        if (c.kernel(r.target) || !exists(r.target)) continue; // a stdlib / pip module, or a kernel one
        if (marked(r.line)) continue;
        out.push({ file: rel, ...r, status: c.personal(r.target) ? "personal" : "unclassified", reason: "imports a non-kernel python module from lib" });
        continue;
      }
      const t = r.target;
      if (c.kernel(t) || kernelDirs.has(t) || (c.owned && c.owned(t))) continue; // an owned file: Jori has its own
      if (isRuntime(t)) continue;
      if (!r.dynamic && NODE_EXTS.some((e) => e && c.kernel(norm(t + e)))) continue; // a module named without its extension
      if (guarded(r.line)) continue;
      if (t === "." || t === "") continue; // the kernel tree's own root
      const status = exists(t) ? (c.personal(t) ? "personal" : "unclassified") : "missing";
      if (status === "missing" && TEST_RX.test(rel)) continue; // a test's fixture path
      out.push({ file: rel, ...r, status, reason: status === "missing" ? "names a repo path that neither exists nor is an allowed runtime path" : `reaches a ${status} file unguarded` });
    }
    // Rule 3 (portability), as a ratchet over install_path_allowance. A test's
    // fixtures (a sample process list, the source text a test checks) name these
    // paths as data, not to find the install, so tests are exempt.
    const refs = TEST_RX.test(rel) ? [] : installPathRefs(rel, text);
    const allowed = Number(((manifest && manifest.install_path_allowance) || {})[rel] || 0);
    if (refs.length > allowed) {
      for (const r of refs) out.push({ file: rel, line: r.line, kind: "install-path", target: "install path / Homebrew node", status: "hard-coded", reason: `spells the install path or Homebrew's node in code (${refs.length} such lines, allowance ${allowed}): use root.cjs installTools()/installRoot()/nodeBin() or root.sh $JORI_INSTALL_TOOLS/$JORI_NODE`, text: r.text });
    }
  }
  return out;
}

const CLOSURE_HELP = [
  "Kernel files are published as Jori without the personal files beside them, so kernel code may only rely on kernel files.",
  "For each reference above, one of:",
  "  - the target is generic: add it to system/kernel-manifest.json `files` (and make it personal-free);",
  "  - personal behaviour: a hook — lib/ext-hooks.mjs loadHook(), or an _ext/ dir the kernel scans;",
  "  - an optional tool or file: guard it where it is used (exists check, `[ -x ]`, `command -v`, try/catch) so its absence is handled;",
  "  - state the installation writes at run time: a path under `closure_runtime_paths` in the manifest;",
  "  - genuinely fine as it is: `kernel-closure-ok: <reason>` on the line (or the line above).",
  "An install-path line: find the installation with lib/root.cjs (installTools(), installRoot(), TOOLS_DIR) or scripts/lib/root.sh",
  "  ($JORI_INSTALL_TOOLS, $JORI_TOOLS) and node with root.cjs nodeBin() / process.execPath or root.sh $JORI_NODE.",
].join("\n");

module.exports = { references, closureViolations, installPathRefs, isCode, staticPart, CLOSURE_HELP, DEFAULT_RUNTIME, GUARD_WINDOW };
