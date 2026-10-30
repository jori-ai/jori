// kernel-guard.cjs — the logic behind bin/kernel-guard, shared with the
// commit gate (githooks/pre-commit) and the self-improvement landing hook
// (lib/_ext/self-improve-landing.mjs).
//
// This code is generic and published with the kernel; what it looks for is
// not. The kernel is what the kernel repo tracks (or, in the old single-repo
// layout, system/kernel-manifest.json `files`); the static pattern list is the
// installation's own private file (patternsFile below) and the derived
// detectors are built from the installation's own registries and config. With
// no pattern list the scan still runs its shape and derived detectors, and
// nothing is ever written on its behalf. No dependencies beyond node.
//
// Two checks:
//   personal data — kernel files are scanned line by line with the private
//     pattern list. A hard hit is personal data in a file that is published.
//   classification — every tracked file in a kernel area (a directory that holds
//     manifest files, and everything below it; the repo root only for its own
//     files) is either in the manifest or matched by the manifest's
//     `personal_globs`. A file that is neither has not been decided, and an
//     undecided file is never published and never scanned.

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_BYTES = 16 * 1024 * 1024;
const ALLOW_MARKER = /kernel-guard-ok:\s*\S/;
const SNIPPET = 160;

// Where personal content goes instead of a kernel file. Printed by every
// refusal so the fix is a move, not a deletion.
const DESTINATIONS = [
  "Kernel files (system/kernel-manifest.json) are published as Jori and must stay generic. Move the content, don't delete it:",
  "  - history, incidents, dated narrative, quotes -> system/changelog.md (a dated bullet) or the commit message, never a code comment;",
  "  - rules about this installation's people, places, accounts, decisions -> agent/local/{shared,chat,ops}.md or agent/local/jobs/<job>.md;",
  "  - values (names, zones, addresses, senders, thresholds) -> agent/local/config/<module>.json, read with localConfig(name, generic defaults);",
  "  - behaviour only this installation needs -> an _ext/ hook module next to the kernel code (lib/ext-hooks.mjs), or a registry entry;",
  "  - a test that needs real data -> a *-local.test.mjs file.",
  "  - a derived_* hit names something this installation registered (a personal job, bin, site, config value) and a shape hit a real id, mailbox, place or the home zone: use a generic example or a placeholder (`kernel-guard --explain` shows which registry or rule produced it);",
  "A line that is genuinely generic despite matching may carry `kernel-guard-ok: <reason>`.",
].join("\n");

const CLASSIFY_HELP = [
  "Every new file under a kernel directory must be classified in system/kernel-manifest.json:",
  "  - kernel (published as Jori, scanned for personal data): add it to `files` with its Jori path,",
  "    e.g. \"lib/foo.mjs\": \"lib/foo.mjs\" (Jori drops the leading tools/);",
  "  - personal (Jori only, never published): add its path, or a glob that covers its family,",
  "    to `personal_globs` (`*` within a directory, `**` across directories).",
].join("\n");

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function manifestFiles(manifest) {
  return Object.keys((manifest && (manifest.files || manifest)) || {}).filter((k) => !k.startsWith("_"));
}

/**
 * Distribution-owned files (manifest `jori_owned`, Jori path → Jori
 * path): files both repos have that must differ by nature (.gitignore, the
 * root package.json, an agent's MCP set). The Jori sync never copies them —
 * Jori keeps its own — so they are classified, but neither scanned for
 * personal data nor held to the closure rule.
 */
function ownedFiles(manifest) {
  return Object.keys((manifest && manifest.jori_owned) || {}).filter((k) => !k.startsWith("_"));
}

function compilePatterns(raw, where = "patterns") {
  const list = Array.isArray(raw) ? raw : raw && raw.patterns;
  if (raw && raw._none) return [];
  if (!Array.isArray(list) || !list.length) throw new Error(`${where} has no patterns`);
  return list.map((p) => {
    if (!p || !p.name || !p.regex) throw new Error(`a pattern in ${where} lacks name/regex`);
    try {
      return {
        name: p.name,
        group: p.group || "",
        severity: p.severity === "report" ? "report" : "hard",
        rx: new RegExp(p.regex, (p.flags || "").replace(/g/g, "")),
        only: p.only_paths ? new RegExp(p.only_paths) : null,
        excl: p.exclude_paths ? new RegExp(p.exclude_paths) : null,
      };
    } catch (e) {
      throw new Error(`pattern ${p.name}: ${e.message}`);
    }
  });
}

const lineKey = (name, line) => crypto.createHash("sha256").update(`${name}\0${line.trim().replace(/\s+/g, " ")}`).digest("hex").slice(0, 12);

function isBinary(buf) {
  // More than 1% NUL bytes in the first 8000 (a text file may hold a stray
  // literal NUL, as a .mjs separator constant does).
  const head = buf.subarray(0, 8000);
  let nul = 0;
  for (const b of head) if (b === 0) nul++;
  return nul > head.length / 100;
}

/** Scan one file's content. `content` is a Buffer or a string. */
function scanContent(rel, content, patterns) {
  if (content == null) return { skipped: true, hits: [] };
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (buf.length > MAX_BYTES || isBinary(buf)) return { skipped: true, hits: [] };
  const pats = patterns.filter((p) => (!p.only || p.only.test(rel)) && (!p.excl || !p.excl.test(rel)));
  const lines = buf.toString("utf8").split("\n");
  const hits = [];
  // Detectors (derived / shape) take a second argument: where the line is.
  const ctx = { rel, kind: fileKind(rel) };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const allowed = ALLOW_MARKER.test(line);
    for (const p of pats) {
      const m = p.rx.exec(line, ctx);
      if (!m) continue;
      const hit = { file: rel, line: i + 1, pattern: p.name, group: p.group, severity: p.severity, match: m[0], text: line.trim().slice(0, SNIPPET), key: lineKey(p.name, line), status: allowed ? "allowed" : p.severity };
      if (m.source || p.source) hit.source = m.source || p.source;
      hits.push(hit);
    }
  }
  return { skipped: false, hits };
}

/**
 * Hard hits in `after` that `before` did not already have (a multiset by
 * pattern + normalised line, so moving a line does not make it new). `before`
 * null means a new file: every hard hit is added.
 */
function addedHardHits(rel, before, after, patterns) {
  const hard = (c) => scanContent(rel, c, patterns).hits.filter((h) => h.status === "hard");
  const budget = new Map();
  if (before != null) for (const h of hard(before)) budget.set(`${h.pattern}\0${h.key}`, (budget.get(`${h.pattern}\0${h.key}`) || 0) + 1);
  const out = [];
  for (const h of hard(after)) {
    const id = `${h.pattern}\0${h.key}`;
    const left = budget.get(id) || 0;
    if (left > 0) budget.set(id, left - 1);
    else out.push(h);
  }
  return out;
}

// ── classification ──────────────────────────────────────────────────────────

/**
 * A repo-relative glob as a RegExp: `**` spans directories (`a/**` is every
 * file below a, `**\/x` is x at any depth), `*` and `?` stay within one path
 * segment, `[...]` is a character class. Everything else is literal.
 */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:[^/]*/)*"; i += 2; }
      else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else { re += "[" + glob.slice(i + 1, end).replace(/\\/g, "\\\\") + "]"; i = end; }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

const dirOf = (f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");

/**
 * The classifier for one manifest: kernel(path), owned(path), personal(path),
 * inArea(path) and status(path) → "kernel" | "owned" | "personal" | "outside" |
 * "unclassified". The manifest wins over personal_globs (an `_ext/.gitkeep`
 * that documents a hook contract is kernel even though `**\/_ext/**` is
 * personal); `jori_owned` counts as classified and as part of the areas.
 */
function classifier(manifest) {
  const files = manifestFiles(manifest);
  const kernel = new Set(files);
  const ownedSet = new Set(ownedFiles(manifest));
  const dirs = new Set(files.concat([...ownedSet]).map(dirOf));
  const globs = ((manifest && manifest.personal_globs) || []).map((g) => ({ glob: g, rx: globToRegExp(g) }));
  // A manifest directory and everything below it, except the root: a root
  // file is in an area only because the root holds manifest files itself.
  const inArea = (rel) => {
    if (dirs.has(dirOf(rel))) return true;
    for (let d = dirOf(rel); d; d = dirOf(d)) if (dirs.has(d)) return true;
    return false;
  };
  const personal = (rel) => globs.some((g) => g.rx.test(rel));
  const status = (rel) => (kernel.has(rel) ? "kernel" : ownedSet.has(rel) ? "owned" : personal(rel) ? "personal" : inArea(rel) ? "unclassified" : "outside");
  return { kernel: (rel) => kernel.has(rel), owned: (rel) => ownedSet.has(rel), personal, inArea, status, globs, files };
}

/** Tracked (or staged-new) paths that are in a kernel area and unclassified. */
function unclassified(paths, manifest) {
  const c = classifier(manifest);
  return paths.filter((p) => c.status(p) === "unclassified");
}

/** personal_globs entries that match no path in `paths` (stale entries). */
function unusedGlobs(paths, manifest) {
  const c = classifier(manifest);
  return c.globs.filter((g) => !paths.some((p) => g.rx.test(p))).map((g) => g.glob);
}

// Files a root-layout install's kernel repo carries that differ by nature
// (lockfiles, the repo's own ignore and secret-scan config) or are media
// (compressed bytes read as noise): classified, not scanned, as `jori_owned`
// is in the manifest.
const SYNTH_OWNED = /(^|\/)(package-lock\.json|package\.json|\.gitignore|\.gitleaks\.toml|\.gitleaksignore|\.pre-commit-config\.yaml|\.kernel-sync\.json)$|\.(png|jpe?g|gif|ico|icns|webp|pdf|mp4|mov|ttf|otf|woff2?)$/i;

/**
 * The manifest of a switched install, built from its two repos: an install
 * whose private overlay is checked out over the kernel checkout
 * (lib/overlay.cjs) has no kernel-manifest.json. The kernel is what the kernel
 * repo tracks (each file at its own path), the personal files are what the
 * overlay tracks, and the runtime paths and install-path allowance come from
 * agent/local/config/kernel-guard.json. Null when the install has no overlay.
 */
function synthManifest(root) {
  let ov;
  try { ov = require("./overlay.cjs"); } catch { return null; }
  if (!ov.hasOverlay(root)) return null;
  const { execFileSync } = require("node:child_process");
  const kernel = execFileSync("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 1 << 30 }).toString().split("\0").filter(Boolean);
  const { KERNEL_SUBDIR } = require("./root.cjs");
  const cfgFile = path.join(root, KERNEL_SUBDIR, "agent/local/config/kernel-guard.json");
  const cfg = (fs.existsSync(cfgFile) && readJsonFile(cfgFile)) || {};
  const files = {}, owned = {};
  for (const p of kernel) (SYNTH_OWNED.test(p) ? owned : files)[p] = p;
  const esc = (p) => p.replace(/[*?[\]]/g, "\\$&");
  return {
    _synthesized: true,
    files,
    jori_owned: owned,
    personal_globs: ov.overlayFiles(root).map(esc),
    closure_runtime_paths: cfg.closure_runtime_paths || [],
    install_path_allowance: cfg.install_path_allowance || {},
  };
}

/**
 * The manifest of a kernel-only checkout: a plain clone of the published
 * kernel repo, with no kernel-manifest.json and no overlay (what CI checks
 * out). Every tracked file is kernel, nothing is personal; the runtime paths
 * are lib/kernel-closure.cjs's defaults and there is no install-path allowance
 * (an installation records those in its private config). Null with an overlay
 * (synthManifest's case) or outside a git work tree.
 */
function kernelOnlyManifest(root) {
  try { if (require("./overlay.cjs").hasOverlay(root)) return null; } catch { /* no overlay helper: kernel-only */ }
  const { execFileSync } = require("node:child_process");
  let kernel;
  try { kernel = execFileSync("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\0").filter(Boolean); }
  catch { return null; }
  if (!kernel.length) return null;
  const files = {}, owned = {};
  for (const p of kernel) (SYNTH_OWNED.test(p) ? owned : files)[p] = p;
  return { _synthesized: true, _kernel_only: true, files, jori_owned: owned, personal_globs: [] };
}

// The private static pattern list. The installation provides it; the kernel
// never ships one. First found wins:
//   1. $KERNEL_GUARD_PATTERNS (a path, relative to the root or absolute)
//   2. agent/local/config/kernel-guard.json `patterns_file` (same)
//   3. system/personal-patterns.json (the private overlay's copy)
const DEFAULT_PATTERNS_REL = "system/personal-patterns.json";
/** { file, rel, source } of the pattern list to use, or null when the installation has none. */
function patternsFile(root, env = process.env) {
  const at = (p, source) => {
    const file = path.resolve(root, p);
    return fs.existsSync(file) ? { file, rel: path.isAbsolute(p) ? null : p, source } : null;
  };
  if (env.KERNEL_GUARD_PATTERNS) return at(env.KERNEL_GUARD_PATTERNS, "$KERNEL_GUARD_PATTERNS");
  let cfg = null;
  try {
    const { KERNEL_SUBDIR } = require("./root.cjs");
    const f = path.join(root, KERNEL_SUBDIR || "", "agent/local/config/kernel-guard.json");
    if (fs.existsSync(f)) cfg = readJsonFile(f);
  } catch { /* unreadable config: fall through to the default path */ }
  if (cfg && typeof cfg.patterns_file === "string" && cfg.patterns_file) {
    const hit = at(cfg.patterns_file, "agent/local/config/kernel-guard.json patterns_file");
    if (hit) return hit;
  }
  return at(DEFAULT_PATTERNS_REL, DEFAULT_PATTERNS_REL);
}
// Stand-in when the installation has no list: no static patterns, the shape
// and derived detectors still run.
const NO_PATTERNS = Object.freeze({ patterns: [], _none: true });

/** Load the manifest and pattern list of a repo; the manifest is null when absent. */
function loadRepo(root) {
  const f = path.join(root, "system/kernel-manifest.json");
  const manifest = (fs.existsSync(f) ? readJsonFile(f) : null) || synthManifest(root);
  const pf = patternsFile(root);
  const rawPatterns = pf ? readJsonFile(pf.file) : NO_PATTERNS;
  return { manifest, patterns: allPatterns(root, rawPatterns, manifest, pf ? pf.source : "no pattern list"), patternsFile: pf };
}

/**
 * The installation check for a proposed change (path → new content; before:
 * path → current content or null for a new file): personal data it would add
 * to a kernel file, and new files it would leave unclassified. A change that
 * edits the manifest is judged against the edited manifest.
 * Returns human-readable refusal reasons (empty = clean).
 */
function changeRefusals({ files, before = {}, manifest, patterns }) {
  const reasons = [];
  const MANIFEST = "system/kernel-manifest.json";
  let m = manifest;
  if (files && typeof files[MANIFEST] === "string") {
    try { m = JSON.parse(files[MANIFEST]); } catch (e) { reasons.push(`${MANIFEST} in this change is not valid JSON: ${e.message}`); }
  }
  if (!m) return reasons;
  const c = classifier(m);
  for (const [rel, content] of Object.entries(files || {})) {
    if (c.kernel(rel) && patterns) {
      for (const h of addedHardHits(rel, before[rel] ?? null, content, patterns)) {
        reasons.push(`personal data in kernel file ${rel}:${h.line} [${h.pattern}] ${h.text}`);
      }
    }
    if ((before[rel] ?? null) === null && c.status(rel) === "unclassified") {
      reasons.push(m._synthesized
        ? `new file ${rel} is in neither repo: add it to the kernel repo (generic) or to the overlay (personal: jori-overlay git add), in this same change`
        : `new file ${rel} is not classified: add it to ${MANIFEST} \`files\` (kernel, with its Jori path) or \`personal_globs\` (personal), in this same change`);
    }
  }
  return reasons;
}

// ── derived patterns and shape detectors ────────────────────────────────────
//
// The static list in personal-patterns.json holds what someone thought to write
// down. Two more kinds of detector close the gap mechanically, so a class of
// leak found once is caught at commit time from then on:
//
//   derived — built at scan time from this installation's own registries and
//     config: every personal task / job / service name (agent/local/
//     tasks.json, job-routing.json, services.json, chrome-jobs.json, playbooks
//     under agent/ops-agent/jobs/ that are not in the manifest), the
//     basenames of personal bins and libs (tracked files the manifest's
//     personal_globs match under bin, lib, agent/scripts),
//     personal browsing-skill site names, every identity value in
//     agent/local/instance.json, and the proper nouns, emails, domains,
//     street addresses, ids and wiki page ids in agent/local/config/*.json.
//     Registering a personal thing makes it a hard pattern, with no list to
//     keep. Matching is whole-token and identifier-aware (`-`, `_` and camelCase
//     humps separate words; a kernel identifier that merely contains a token is
//     not a hit). Generic words never become tokens: a stoplist of common English
//     words, public product names and the kernel's own identifiers (manifest
//     file and directory names, kernel registry names) drops them, and a token
//     that is still generic in kernel text goes in personal-patterns.json
//     `derived_allow` with its reason.
//   shapes — personal data recognisable by its shape: ids next to the words that
//     name them, dated incident ids, commit SHAs in prose, real mailboxes,
//     tenant subdomains, the home time zone, coordinates, street addresses.
//     Placeholders (example.com, abc123def456, 12 Main St, <team>…) never hit;
//     personal-patterns.json `shape_placeholders` extends the built-in lists.
//
// Both are pattern objects whose `rx` is a detector with exec(line, ctx) in
// place of a RegExp, so scanContent, the baseline and the landing hook run them
// like the regex patterns. A hit's `source` says which rule or registry
// produced it (kernel-guard --explain).

const TEST_PATH = /(^|\/)(tests?|__tests__|fixtures)\/|\.test\.[a-z]+$/;
const LOCK_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const DOC_FILE = /\.(md|markdown|txt|rst)$/i;

/** "doc" (every line is prose) or "code" (only comments are). JSON counts as doc: its strings are descriptions. */
function fileKind(rel) {
  return DOC_FILE.test(rel) || (/\.json$/i.test(rel) && !LOCK_FILE.test(rel)) ? "doc" : "code";
}

/** The prose part of a line: all of it in a doc, the comment in code ("" when none). */
function commentText(line, kind) {
  if (kind === "doc") return line;
  const t = line.trimStart();
  if (/^(?:\/\/|\/\*|\*|#(?!!)|<!--|--\s|;)/.test(t)) return line;
  const m = /\s(?:\/\/|#)\s/.exec(line);
  return m ? line.slice(m.index) : "";
}

const detector = (exec) => ({ exec, source: undefined });
const hitAt = (text, index, source) => { const m = [text]; m.index = index; m.source = source; return m; };

// ── placeholders ──

const LEET_HEX = /c0ffee|coffee|decaf|dead|beef|babe|cafe|face|feed|fade|bead|f00d|d00d|0ff1ce|abba/g;
const unitStep = (a, b) => Math.abs(parseInt(a, 16) - parseInt(b, 16)) === 1;
function mostlySequential(s) {
  if (s.length < 3) return true;
  let n = 0;
  for (let i = 1; i < s.length; i++) if (unitStep(s[i - 1], s[i])) n++;
  return n / (s.length - 1) >= 0.6;
}
function repeatsUnit(s) {
  for (let p = 1; p <= 4 && p <= s.length / 2; p++) {
    let ok = true;
    for (let i = p; i < s.length && ok; i++) if (s[i] !== s[i % p]) ok = false;
    if (ok) return true;
  }
  return false;
}
function lowEntropyHex(s) {
  if (new Set(s).size <= Math.max(2, Math.floor(s.length / 4))) return true;
  if (repeatsUnit(s) || mostlySequential(s)) return true;
  const even = [...s].filter((_, i) => i % 2 === 0).join(""), odd = [...s].filter((_, i) => i % 2 === 1).join("");
  return s.length >= 6 && mostlySequential(even) && mostlySequential(odd); // a1b2c3d4, 9c8d7e6f
}
/** An obviously made-up hex id: abc123def456, deadbeef, 44444444, a1b2c3d4, c0ffee01, or one in `extra`. */
function isPlaceholderHex(h, extra = []) {
  h = h.toLowerCase();
  for (const p of extra) if (h === p || (p.length >= 6 && h.includes(p))) return true;
  if (lowEntropyHex(h)) return true;
  const rest = h.replace(LEET_HEX, "");
  return rest !== h && (rest.length <= 3 || lowEntropyHex(rest));
}
const hasDigitAndLetter = (s) => /\d/.test(s) && /[a-f]/i.test(s);

const DEFAULT_PLACEHOLDERS = {
  hex: ["deadbeef", "cafebabe", "feedface", "badc0ffee", "abc123def456", "a1b2c3d4e5f6", "0123456789ab", "abcdef0123456789"], // kernel-guard-ok: the placeholder list itself
  email_domains: ["example.com", "example.org", "example.net", "localhost", "acme.com", "acme.org", "company.com", "domain.com", "email.com", "test.com", "spammer.com", "evil.com", "attacker.com", "else.com", "letter.com"],
  email_tlds: ["example", "test", "invalid", "localhost", "local", "tld", "internal", "lan"],
  consumer_email_domains: ["gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "fastmail.com", "hey.com", "zoho.com", "yandex.com", "mail.com"],
  subdomain_labels: ["team", "your-team", "yourteam", "my-team", "myteam", "example", "acme", "demo", "test", "foo", "bar", "baz", "xxx", "xyz", "abc", "project", "your-project", "yourproject", "my-project", "project-ref", "ref", "app", "my-app", "your-app", "yourapp", "name", "your-name", "yourname", "user", "username", "org", "your-org", "tenant", "account", "your-account", "sub", "subdomain", "worker", "my-worker", "your-worker", "api", "www", "hooks", "files", "status", "docs", "help", "support", "blog", "cdn", "static", "assets", "dash", "dashboard", "console", "slack", "edgeapi", "app-name"],
  streets: ["Main", "Oak", "Elm", "Maple", "Pine", "Cedar", "Birch", "Example", "Evergreen", "Fake", "Sample", "Test", "Nowhere", "Anystreet", "Placeholder"],
};
function placeholders(raw) {
  const extra = (raw && raw.shape_placeholders) || {};
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_PLACEHOLDERS)) out[k] = v.concat(Array.isArray(extra[k]) ? extra[k] : []);
  return out;
}

// ── shape detectors ──

const ID_CONTEXT = /approv|decision|disagree|cluster|dispatch|(?<![\w-])sic?-/i;
const HEX_ID = /(?<![0-9A-Za-z_-])(?:[0-9a-f]{12}|[0-9a-f]{8})(?![0-9A-Za-z_]|-[0-9a-f]{4}-)/g;
const INCIDENT_ID = /(?<![\w-])sic?-20\d{6}(?:-[0-9a-z]+)*/;
const SHA = /(?<![0-9A-Za-z_#])(?<!0x)[0-9a-f]{7,40}(?![0-9A-Za-z_])/g;
const UUID_AROUND = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
const ROLE_MAILBOX = /^(?:[\w.+-]*[._+-])?(?:no-?reply|do-?not-?reply|noreply[\w-]*|mailer-daemon|postmaster|support|notifications?|notify|alerts?|info|billing|orders?|receipts?|auto-?confirm|confirm\w*|updates?|news(?:letter)?|security|accounts?|team|hello|help|contact|bounces?|statements?|reservations?|communications?|devprograms|marketing|sales|admin|service|reply|push|feedback|digest|calendar-notification|shipment|shipping|tracking|delivery|store|payments?|invoices?|verify|verification|auth|login|welcome|events|invites?|careers|jobs)(?:[._+-][\w.+-]*)?$/i;
// Local parts that are placeholders even at a consumer domain (owner@gmail.com).
const PLACEHOLDER_MAILBOX = /^(?:owner|user|someone|somebody|me|you|example|test|name|nobody|foo|bar|first\.?last|firstname\.?lastname|jane\.?doe|john\.?doe|your\.?name|your-?email|email)$/i;
// A domain label that marks the whole domain as made up (example-project.iam…, test-project.supabase.co).
const PLACEHOLDER_LABEL = /^(?:example|test|sample|demo|fake|dummy|placeholder|my|your)(?:-|$)/i;
const sequentialLetters = (s) => s.length >= 4 && [...s].every((c, i) => !i || Math.abs(c.charCodeAt(0) - s.charCodeAt(i - 1)) === 1);
const TENANT_SUFFIXES = "cloudflareaccess\\.com|workers\\.dev|pages\\.dev|vercel\\.app|netlify\\.app|herokuapp\\.com|myshopify\\.com|atlassian\\.net|slack\\.com|zendesk\\.com|github\\.io|notion\\.site|fly\\.dev|onrender\\.com|supabase\\.co|firebaseio\\.com|firebaseapp\\.com|web\\.app|ngrok-free\\.app|ngrok\\.app|ngrok\\.io|substack\\.com|azurewebsites\\.net|trycloudflare\\.com|freshdesk\\.com|webflow\\.io|bubbleapps\\.io|glitch\\.me";
const TENANT_HINT = new RegExp(`\\.(?:${TENANT_SUFFIXES})`, "i");
const TENANT = new RegExp(`(?<![\\w-])([a-z0-9][a-z0-9-]*)\\.(${TENANT_SUFFIXES})(?![\\w-])`, "gi");
const COORD_PAIR = /(?<![\d.])(-?\d{1,3}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})(?![\d.])/g;
// Keyed (lat: …, lon: …) the keys make the pair unambiguous, so 3 decimals (~100 m) count.
const COORD_LAT = /\b(?:lat|latitude)["']?\s*[:=]\s*(-?\d{1,2}\.\d{3,})/i;
const COORD_LON = /\b(?:lng|lon|long|longitude)["']?\s*[:=]\s*(-?\d{1,3}\.\d{3,})/i;
const STREET = /(?<![\w.$])(\d{1,5}[A-Za-z]?)\s+(?:(?:[NSEW]\.?|North|South|East|West)\s+)?((?:(?:\p{Lu}[\p{Ll}'’]+|\d{1,3}(?:st|nd|rd|th))\s+){1,3})(St|Ave|Rd|Blvd|Street|Avenue|Alley|Road|Boulevard|Lane|Ln|Drive|Pkwy|Parkway|Terrace)\b\.?/gu;
const MARKET_HOURS = /market[\s_-]*hours|\bNYSE\b|\bNasdaq\b|\bU\.?S\.? Eastern\b/i;
// A line that also names another zone ("ET", "PT", "CT"; Europe/Paris) is
// about zone labels in general, not the home zone.
const ZONE_ABBRS = /(?<![A-Za-z0-9])(?:ET|EST|EDT|PT|PST|PDT|CT|CST|CDT|MT|MST|MDT|GMT|BST|CET|CEST|EET|WET|JST|KST|IST|AEST|AEDT|HST|AKST|NZST)(?![A-Za-z0-9])/g;
const IANA_ZONE_VALUE = /^(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?$/; // kernel-guard-ok: the IANA zone areas
const ZONE_IDS = /\b(?:America|Europe|Asia|Africa|Australia|Pacific|Atlantic|Indian)\/[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_]+)?/g; // kernel-guard-ok: the IANA zone areas

function isPlaceholderCoord(v) {
  const digits = v.replace(/[^\d]/g, ""), dec = v.split(".")[1] || "";
  return new Set(dec).size <= 1 || mostlySequential(digits) || /^-?0+\.0+$/.test(v);
}

/** Abbreviations and names a zone is written as: JST and "Japan Standard Time" for Asia/Tokyo. */
function zoneNames(tz) {
  const abbr = new Set(), names = new Set();
  for (const month of [0, 6]) {
    const d = new Date(Date.UTC(2026, month, 15, 12));
    try {
      // en-US abbreviates only US zones; the zone's own locales know theirs (JST, CET, AEST).
      for (const loc of ["en-US", "en-GB", "en-AU", "en-IN", "en-NZ", "ja-JP", "ko-KR"]) {
        const short = new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value;
        if (!short || !/^[A-Z]{2,5}$/.test(short) || /^(GMT|UTC)$/.test(short)) continue;
        abbr.add(short);
        if (/^[A-Z][SD]T$/.test(short)) abbr.add(short[0] + "T");
      }
      for (const style of ["long", "longGeneric"]) {
        const long = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: style }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value;
        if (long && !/^GMT|UTC|Coordinated/.test(long)) names.add(long);
      }
    } catch { /* unknown zone: its IANA name still counts */ }
  }
  return { abbr: [...abbr], names: [...names] };
}

function shapeDetectors(raw, instanceTz) {
  const ph = placeholders(raw);
  const out = [];
  const add = (name, group, severity, desc, exec, paths = {}) => out.push({ name, group, severity, rx: detector(exec), only: paths.only || null, excl: paths.excl || null, describe: desc, kind: "shape" });

  add("hex_id_near_context", "infra_ids", "hard", "an 8- or 12-hex id within 48 characters of approval/decision/disagreement/cluster/dispatch/si-/sic- (non-test files)", (line) => {
    if (!ID_CONTEXT.test(line)) return null;
    for (const m of line.matchAll(HEX_ID)) {
      const h = m[0];
      if (!hasDigitAndLetter(h) || isPlaceholderHex(h, ph.hex)) continue;
      const win = line.slice(Math.max(0, m.index - 48), m.index + h.length + 48);
      if (ID_CONTEXT.test(win)) return hitAt(h, m.index, "shape: an 8/12-hex id next to an approval/decision/disagreement/cluster word — a real record id; use an obviously fake one (abc123def456)");
    }
    return null;
  }, { excl: TEST_PATH });

  add("incident_id", "infra_ids", "hard", "a dated suggestion / system-issue id (si-YYYYMMDD-…, sic-YYYYMMDD-…) in a non-test file", (line) => {
    const m = INCIDENT_ID.exec(line);
    return m ? hitAt(m[0], m.index, "shape: a dated si-/sic- id names one real incident — keep it in system/changelog.md; the kernel says what the rule is") : null;
  }, { excl: TEST_PATH });

  add("commit_sha", "infra_ids", "hard", "a 7–40 hex commit SHA in a doc or a code comment", (line, ctx) => {
    const text = commentText(line, ctx ? ctx.kind : "doc");
    if (!text || !/[0-9a-f]{7}/.test(text)) return null;
    const uuids = [...text.matchAll(UUID_AROUND)].map((u) => [u.index, u.index + u[0].length]);
    for (const m of text.matchAll(SHA)) {
      const h = m[0];
      if (!hasDigitAndLetter(h) || isPlaceholderHex(h, ph.hex)) continue;
      if (uuids.some(([a, b]) => m.index >= a && m.index < b)) continue;
      if ((h.length === 8 || h.length === 12) && ID_CONTEXT.test(text.slice(Math.max(0, m.index - 48), m.index + h.length + 48))) continue; // a record id: hex_id_near_context
      return hitAt(h, line.length - text.length + m.index, "shape: a commit SHA in prose points at one real commit — say what changed; the SHA belongs in the changelog");
    }
    return null;
  }, { excl: LOCK_FILE });

  const phLabels = new Set(ph.subdomain_labels.map((l) => l.toLowerCase()));
  const phDomains = ph.email_domains.map((d) => d.toLowerCase()), consumer = new Set(ph.consumer_email_domains.map((d) => d.toLowerCase()));
  const phTlds = new Set(ph.email_tlds.map((t) => t.toLowerCase()));
  add("email_address", "people", "hard", "a real-looking mailbox: any address at a consumer mail domain, or a personal (non-role) one at any domain that is not a placeholder (example.com/.org/.net, localhost, *.example, *.test …)", (line) => {
    if (!line.includes("@")) return null;
    for (const m of line.matchAll(EMAIL)) {
      const domain = m[1].toLowerCase(), local = m[0].slice(0, m[0].length - m[1].length - 1);
      const labels = domain.split(".");
      if (phTlds.has(labels[labels.length - 1])) continue;
      if (phDomains.some((d) => domain === d || domain.endsWith("." + d))) continue;
      if (labels.slice(0, -1).some((l) => PLACEHOLDER_LABEL.test(l) || phLabels.has(l))) continue;
      if (PLACEHOLDER_MAILBOX.test(local)) continue;
      const isConsumer = [...consumer].some((d) => domain === d || domain.endsWith("." + d));
      // <id@mail.gmail.com> is a Message-ID, not a mailbox: only a real-length one is a real id.
      if (isConsumer && /^mail\./.test(domain) && local.length < 16) continue;
      if (!isConsumer && labels[labels.length - 2].length <= 2) continue; // a@b.c, x@y.com
      if (!isConsumer && ROLE_MAILBOX.test(local)) continue; // noreply@service.com: a sender rule, not a person
      return hitAt(m[0], m.index, `shape: a real-looking mailbox${isConsumer ? " at a consumer mail domain" : ""} — use someone@example.com`);
    }
    return null;
  }, { excl: LOCK_FILE });

  add("tenant_subdomain", "infra_ids", "hard", "a brand or account name as a SaaS tenant subdomain (<team>.cloudflareaccess.com, <account>.workers.dev, …) that is not a placeholder", (line) => {
    if (!TENANT_HINT.test(line)) return null;
    for (const m of line.matchAll(TENANT)) {
      const label = m[1].toLowerCase();
      if (phLabels.has(label) || PLACEHOLDER_LABEL.test(label) || sequentialLetters(label) || (/^[0-9a-f]+$/.test(label) && lowEntropyHex(label))) continue;
      if (/(?:^|-)jori(?:-|$)/.test(label)) continue; // the published project's own name, not this installation's
      return hitAt(m[0], m.index, `shape: "${m[1]}" names this installation's tenant/account on ${m[2]} — use <team>.${m[2]}`);
    }
    return null;
  });

  // The home zone: the instance's, plus any the pattern list names in
  // `home_zones` (the zone the kernel was first written in, when the
  // installation has since moved).
  const zones = [];
  for (const z of [instanceTz, ...((raw && Array.isArray(raw.home_zones)) ? raw.home_zones : [])]) {
    if (typeof z === "string" && z && !zones.includes(z) && !/^(UTC|Etc\/|GMT)/.test(z)) zones.push(z);
  }
  const abbr = new Set(), names = new Set();
  for (const z of zones) { const n = zoneNames(z); n.abbr.forEach((a) => abbr.add(a)); n.names.forEach((x) => names.add(x)); }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tzRx = new RegExp([
    ...zones.map((z) => esc(z)),
    ...[...names].map((n) => `\\b${esc(n)}\\b`),
    ...(abbr.size ? [`(?<![A-Za-z0-9])(?:${[...abbr].map(esc).join("|")})(?![A-Za-z0-9])`] : []),
  ].join("|"));
  const tzExec = (line) => {
    const m = tzRx.exec(line);
    if (!m || MARKET_HOURS.test(line)) return null;
    if ([...line.matchAll(ZONE_ABBRS)].some((z) => !abbr.has(z[0])) || [...line.matchAll(ZONE_IDS)].some((z) => !zones.includes(z[0]))) return null;
    return hitAt(m[0], m.index, `shape: the home time zone (${zones.join(", ")}: ${[...abbr].join("/")}) hard-coded — read instance().tz, say "local"; a line about US market hours may name it (write "market hours" on that line)`);
  };
  const tzDesc = `the home time zone written into kernel text: ${zones.join(", ")} or ${[...abbr].concat([...names]).join(", ")} (exempt: a line about market hours / NYSE / Nasdaq / US Eastern, or one listing other zones too)`;
  if (zones.length) { // no home zone known (a fresh install): nothing to look for
    add("home_timezone", "defaults", "hard", tzDesc + " — non-test files", tzExec, { excl: TEST_PATH });
    add("home_timezone_test", "defaults", "report", tzDesc + " — tests (report only)", tzExec, { only: TEST_PATH });
  }

  add("coordinates", "places", "hard", "a latitude/longitude pair with 4+ decimals, or 3+ when keyed lat:/lon: (not 0.0000 / 12.3456-style placeholders)", (line) => {
    if (!/\d\.\d{3}/.test(line)) return null;
    for (const m of line.matchAll(COORD_PAIR)) {
      const [la, lo] = [m[1], m[2]];
      if (Math.abs(+la) > 90 || Math.abs(+lo) > 180 || isPlaceholderCoord(la) || isPlaceholderCoord(lo)) continue;
      return hitAt(m[0], m.index, "shape: real coordinates pin a real place — use an obviously fake pair (12.3456, -65.4321) or none");
    }
    const a = COORD_LAT.exec(line), b = COORD_LON.exec(line);
    if (a && b && !isPlaceholderCoord(a[1]) && !isPlaceholderCoord(b[1])) return hitAt(a[0], a.index, "shape: real coordinates pin a real place — use an obviously fake pair or none");
    return null;
  });

  const phStreets = new Set(ph.streets.map((s) => s.toLowerCase()));
  add("street_address", "places", "hard", "a street address (number + capitalised street + St/Ave/Rd/Blvd/Street/Avenue/Alley/…) whose street is not a placeholder (Main, Oak, Elm, Example …)", (line) => {
    if (!/\d/.test(line)) return null;
    for (const m of line.matchAll(STREET)) {
      const first = m[2].trim().split(/\s+/)[0].toLowerCase();
      if (phStreets.has(first)) continue;
      return hitAt(m[0], m.index, "shape: a street address names a real place — use 12 Main St");
    }
    return null;
  });
  return out;
}

// ── derived patterns ──

// Words that are never derived tokens on their own: dates and public products
// and services the kernel names generically. (Common English is COMMON_WORDS at
// the end of this file; the kernel's own identifiers are read from the repo.)
const GENERIC_WORDS = new Set((
  "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec " +
  "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun " +
  "jori jori claude anthropic opus sonnet haiku fable gemma ollama openai gpt gemini llama mistral " +
  "google gmail chrome chromium android apple iphone ipad macos ios icloud safari xcode testflight siri facetime imessage " +
  "amazon aws cloudflare supabase github gitlab git slack whatsapp telegram signal twilio stripe vercel netlify firebase heroku " +
  "docker node nodejs npm npx python sqlite postgres postgresql linux ubuntu debian homebrew brew launchd cron crontab systemd " +
  "notion zoom microsoft outlook windows youtube reddit twitter facebook instagram linkedin wikipedia spotify netflix uber lyft " +
  "json yaml toml api apis url urls uri http https sql utc gmt ttl html css pdf csv tsv uuid sha jwt oauth cli mcp llm llms iso " +
  "cdp dom ssh tls ssl dns smtp imap apns gcp rtdb fyi tbd eta asap aka etc faq tldr ack nack todo wip pr prs ci cd sdk ui ux " +
  "markdown javascript typescript bash zsh shell regex cdn vpn wifi bluetooth gps sms mms otp tts stt ocr rss usd eur lint saas playbook playbooks launchagent launchagents launchdaemon pptx docx xlsx timezone timezones creds followup followups"
).split(/\s+/).filter(Boolean));

// Leading words stripped from a capitalised phrase (sentence starts, determiners).
const FUNCTION_WORDS = new Set("the a an this that these those his her their our your my its each every when if in on at for from to by with and or but as is was do does did not no yes so then also all any some after before since until while where what who which how why example e g i we you he she it they".split(" "));
const CONNECTORS = new Set("de la le du des del da di van von der of y".split(" "));
const WIKI_ID = /(?<![\w-])(?:user|feedback|reference|project|restaurant|travel|trip|place|person|people|venue|episode|day|show|movie|hub|topic|event|org|company|contact)_[a-z0-9]+(?:_[a-z0-9]+)*(?![\w-])/g;
const DOMAIN = /(?<![\p{L}\p{N}@._-])(?:[a-z0-9][a-z0-9-]*\.)+(?:com|org|net|io|co|ai|app|dev|me|us|uk|il|fr|de|ca|info|biz|xyz|tv|ly|so|sh|gg|club|events)(?![\p{L}\p{N}-])/giu;

let _common = null;
const commonWords = () => (_common ||= new Set(COMMON_WORDS.split(/\s+/).filter(Boolean)));
const SUFFIXES = [["ies", "y"], ["ied", "y"], ["ier", "y"], ["ily", "y"], ["izations", "ize"], ["ization", "ize"], ["ations", "e"], ["ation", "e"], ["ations", ""], ["ation", ""], ["izes", ""], ["ized", ""], ["izing", ""], ["ize", ""], ["ize", "e"], ["ises", ""], ["ised", ""], ["ise", ""], ["ments", ""], ["ment", ""], ["ness", ""], ["ions", ""], ["ion", ""], ["ions", "e"], ["ion", "e"], ["ings", ""], ["ing", ""], ["ing", "e"], ["ers", ""], ["ers", "e"], ["er", ""], ["er", "e"], ["ors", ""], ["or", ""], ["or", "e"], ["ed", ""], ["ed", "e"], ["es", ""], ["s", ""], ["ly", ""], ["able", ""], ["able", "e"], ["ity", ""], ["ive", ""], ["ive", "e"], ["al", ""], ["ic", ""], ["y", ""]];
const PREFIXES = ["re", "un", "pre", "sub", "co", "non", "de", "dis", "mis", "over", "under", "out", "up", "multi", "inter", "auto", "super"];
/**
 * A common English word: in COMMON_WORDS, an inflection of one (fetchers,
 * normalize, probes), a prefixed one (rebalance, unstar) or two joined
 * (findme, watchlist, workset).
 */
function isCommonWord(w, { compounds = true } = {}) {
  if (isCommonBase(w)) return true;
  if (w.length < 5) return false;
  for (const p of PREFIXES) if (w.startsWith(p) && w.length - p.length >= 4 && isCommonBase(w.slice(p.length))) return true;
  if (!compounds) return false; // a brand is often two words run together (ticketpeak)
  for (let i = 2; i <= w.length - 2; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    const ok = (x) => (x.length >= 3 ? isCommonBase(x) : /^(?:me|my|up|in|on|to|at|by|go|do|no|of|it|us|am|is|an|or)$/.test(x));
    if (ok(a) && ok(b)) return true;
  }
  return false;
}
function isCommonBase(w) {
  const common = commonWords();
  if (common.has(w) || GENERIC_WORDS.has(w)) return true;
  for (const [suf, rep] of SUFFIXES) {
    if (w.length - suf.length < 3 || !w.endsWith(suf)) continue;
    const b = w.slice(0, -suf.length);
    if (common.has(b + rep)) return true;
    if (!rep && b.length > 3 && b[b.length - 1] === b[b.length - 2] && common.has(b.slice(0, -1))) return true; // stopped → stop
  }
  return false;
}

// Words that make a personal name reveal a life area (money, home, travel,
// health, family, tastes) even though they are common English — a name with
// one is a token, a name of only common words is not. The personal module
// families in the manifest's personal_globs (bin/cruise-*,
// lib/finance-*, lib/cruise/** …) add their own words;
// personal-patterns.json `derived_life_words` adds more.
const LIFE_WORDS = ("finance financial portfolio rebalance worth brokerage crypto stock stocks ipo invoice invoices tax taxes deposit deposits income salary bank banking loan mortgage " +
  "property properties rental rent lease leases tenant tenants landlord household spa pool thermostat " +
  "trip trips travel flight flights cruise cruises itinerary airline airlines hotel hotels vacation passport airport " +
  "health medical doctor clinic sleep exercise workout fitness weight diet meal meals dining restaurant restaurants " +
  "family birthday birthdays partner kids children dog dogs pet pets wedding anniversary gift gifts occasion occasions " +
  "comedy comedian concert concerts festival festivals jazz blues singalong storytelling lecture lectures movie movies theater theatre broadway lottery winery sports parody").split(" ");

function splitToken(text) {
  const parts = [], seps = [];
  let last = null;
  for (const m of String(text).matchAll(/[\p{L}\p{N}]+/gu)) {
    if (last !== null) seps.push(text.slice(last, m.index));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  return { parts, seps };
}
// A separator class: "i" an identifier joint (- _ or a camelCase hump), "w" also
// whitespace (a phrase), anything else must match literally (. @ /).
const sepClass = (s, phrase) => (/^[-_]+$/.test(s) ? (phrase ? "w" : "i") : /^[-_\s]+$/.test(s) ? "w" : s);
function normToken(text) {
  const { parts, seps } = splitToken(text);
  return parts.map((p, i) => (i ? (/^[-_\s]+$/.test(seps[i - 1]) ? "-" : seps[i - 1]) : "") + p.toLowerCase()).join("");
}
const normRun = (s) => s.toLowerCase().replace(/^[-_]+|[-_]+$/g, "").replace(/_+/g, "-");
const isCamel = (s) => /\p{Ll}\p{Lu}|\p{Lu}\p{Lu}\p{Ll}/u.test(s);
const camelSplit = (s) => s.split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u);

// Words of one line, computed once per line for all derived detectors.
let _lwLine = null, _lwRuns = null, _lwCamel = null;
function lineWords(line) {
  if (line === _lwLine) return [_lwRuns, _lwCamel];
  const runs = [];
  let camel = null;
  for (const m of line.matchAll(/^[\x00-\x7f]*$/.test(line) ? /[A-Za-z0-9]+/g : /[\p{L}\p{N}]+/gu)) {
    runs.push({ t: m[0], l: m[0].toLowerCase(), s: m.index, e: m.index + m[0].length });
    if (isCamel(m[0])) camel = true;
  }
  if (camel) {
    camel = [];
    for (const w of runs) {
      if (!isCamel(w.t)) { camel.push(w); continue; }
      let off = w.s;
      for (const p of camelSplit(w.t)) { camel.push({ t: p, l: p.toLowerCase(), s: off, e: off + p.length }); off += p.length; }
    }
  }
  _lwLine = line; _lwRuns = runs; _lwCamel = camel;
  return [runs, camel];
}

const IDENT_CHAR = /[\p{L}\p{N}_-]/u;
function sepOk(cls, gap) {
  if (cls === "i") return gap === "" || /^[-_]+$/.test(gap);
  if (cls === "w") return gap === "" || /^[-_]+$|^\s+$/.test(gap);
  return gap === cls;
}
/**
 * The first match of each token category in a line ({category → {s, e, t}}):
 * one pass over the line's words serves every derived detector.
 */
function matchTokens(words, index, line, kernelIds, found = new Map()) {
  for (let i = 0; i < words.length; i++) {
    const cands = index.get(words[i].l);
    if (!cands) continue;
    for (const t of cands) {
      if (found.has(t.category)) continue;
      const n = t.parts.length;
      if (i + n > words.length) continue;
      let ok = true;
      for (let j = 0; j < n && ok; j++) {
        const w = words[i + j];
        if (t.cs ? w.t !== t.parts[j] : w.l !== t.lparts[j]) ok = false;
        else if (j > 0) ok = sepOk(t.seps[j - 1], line.slice(words[i + j - 1].e, w.s));
      }
      if (!ok) continue;
      const s = words[i].s, e = words[i + n - 1].e;
      let a = s, b = e;
      while (a > 0 && IDENT_CHAR.test(line[a - 1])) a--;
      while (b < line.length && IDENT_CHAR.test(line[b])) b++;
      if ((a !== s || b !== e) && kernelIds.has(normRun(line.slice(a, b)))) continue; // part of a kernel name
      if (/(?:America|Europe|Asia|Africa|Australia|Pacific|Atlantic|Indian)\/$/.test(line.slice(Math.max(0, a - 12), a))) continue; // in a zone id: home_timezone's job. kernel-guard-ok: the IANA zone areas
      found.set(t.category, { s, e, t });
    }
  }
  return found;
}

const DERIVED_CATEGORIES = [
  ["instance", "derived_instance", "an identity value from agent/local/instance.json"],
  ["task", "derived_task", "a personal scheduled task name (agent/local/tasks.json)"],
  ["job", "derived_job", "a personal job name (local job-routing.json / chrome-jobs.json, personal playbooks)"],
  ["service", "derived_service", "a personal service name (agent/local/services.json)"],
  ["bin", "derived_bin", "a personal bin / lib / script basename (personal_globs)"],
  ["site", "derived_site", "a personal browsing-skill site name"],
  ["wiki", "derived_wiki_id", "a wiki page id named in local config"],
  ["config", "derived_config", "a proper noun, email, domain, address or id from agent/local/config/*.json"],
];

function readJsonQuiet(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * How derivation reads the repo: the working tree, or (staged) the index — the
 * registries and config as the commit will land them. A path the index does
 * not hold does not exist for a staged read.
 *   json(rel) → parsed JSON or null; exists(rel); list(relDir) → file names in
 *   that directory (not below it).
 */
function repoReader(root, { staged = false } = {}) {
  if (!staged) {
    return {
      staged: false,
      json: (rel) => readJsonQuiet(path.join(root, rel)),
      exists: (rel) => fs.existsSync(path.join(root, rel)),
      list: (relDir) => { try { return fs.readdirSync(path.join(root, relDir)); } catch { return []; } },
    };
  }
  let index = null;
  const paths = () => {
    if (index) return index;
    try {
      index = new Set(require("node:child_process").execFileSync("git", ["ls-files", "--cached"], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n").filter(Boolean));
    } catch { index = new Set(); }
    return index;
  };
  return {
    staged: true,
    json: (rel) => {
      if (!paths().has(rel)) return null;
      try { return JSON.parse(require("node:child_process").execFileSync("git", ["show", `:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString()); } catch { return null; }
    },
    exists: (rel) => { const pre = rel.replace(/\/+$/, "") + "/"; for (const p of paths()) if (p === rel || p.startsWith(pre)) return true; return false; },
    list: (relDir) => { const pre = relDir.replace(/\/+$/, "") + "/"; const out = []; for (const p of paths()) if (p.startsWith(pre) && !p.slice(pre.length).includes("/")) out.push(p.slice(pre.length)); return out; },
  };
}

/** Tracked files under `dirs` (git ls-files; a walk of the disk outside a git repo). */
function trackedUnder(root, dirs) {
  try {
    const out = require("node:child_process").execFileSync("git", ["ls-files", "--", ...dirs], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n").filter(Boolean);
    // A switched install keeps its personal registries (site skills, jobs,
    // bins) in the overlay, not in the kernel repo: they count too.
    let ov = null;
    try { ov = require("./overlay.cjs"); } catch { /* no overlay support */ }
    if (ov && ov.hasOverlay(root)) {
      const under = dirs.map((d) => d.replace(/\/$/, "") + "/");
      for (const f of ov.overlayFiles(root)) if (under.some((d) => f.startsWith(d)) && !out.includes(f)) out.push(f);
    }
    return out;
  } catch {
    const out = [];
    const walkDir = (rel) => {
      let ents;
      try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walkDir(r); else if (e.isFile()) out.push(r);
      }
    };
    for (const d of dirs) walkDir(d);
    return out;
  }
}

/** The kernel's own names: manifest file and directory names, kernel registry names. */
function kernelIdentifiers(root, manifest, reader = repoReader(root)) {
  const ids = new Set(), words = new Set(["jori", "jori"]);
  const addId = (name) => {
    const n = normToken(name);
    if (!n) return;
    ids.add(n);
    for (const p of n.split(/[^\p{L}\p{N}]+/u)) if (p) words.add(p);
  };
  for (const f of manifestFiles(manifest).concat(ownedFiles(manifest))) {
    for (const seg of f.split("/")) {
      addId(seg.replace(/\.[A-Za-z0-9]+$/, ""));
      addId(seg.replace(/^\.+/, "").split(".")[0]);
    }
  }
  const j = (rel) => reader.json(rel) || {};
  for (const t of j("system/tasks.json").tasks || []) if (t && t.name) addId(t.name);
  for (const k of Object.keys(j("agent/config/job-routing.json").jobs || {})) addId(k);
  for (const s of j("system/services.json").services || []) if (s && s.name) addId(s.name);
  const cj = j("agent/config/chrome-jobs.json");
  for (const n of [].concat(cj.jobs || [], cj.order || [])) if (typeof n === "string") addId(n);
  return { ids, words };
}

/**
 * The derived token table of a repo: norm → { display, parts, seps, cs,
 * category, sources }. Also returns the derived_allow entries that matched a
 * token (so --explain can show what is allowed and why).
 */
function derivedTokens(root, manifest, raw, reader = repoReader(root)) {
  const LOCAL_REL = "agent/local";
  const tokens = new Map(), allowed = new Map();
  if (!reader.exists(LOCAL_REL)) return { tokens, allowed, kernel: { ids: new Set(), words: new Set() }, tz: null };
  const kernel = kernelIdentifiers(root, manifest || {}, reader);
  // Compounds (findme = find + me) count as common only in the names of this
  // installation's own tools; a site, config value or prose word run together
  // is usually a brand (ticketpeak, menuscore).
  const stop = (w, compounds = false) => /^\d+$/.test(w) || GENERIC_WORDS.has(w) || kernel.words.has(w) || FUNCTION_WORDS.has(w) || isCommonWord(w, { compounds });
  const life = new Set(LIFE_WORDS.concat(((raw && raw.derived_life_words) || []).map((w) => String(w).toLowerCase())));
  for (const g of (manifest && manifest.personal_globs) || []) {
    // A personal module family: bin/cruise-*, lib/place_*, lib/cruise/**.
    const fam = /^(?:bin|lib|tests|agent\/ops-agent\/jobs|agent\/scripts(?:\/[\w-]+)?)\/([a-z0-9]+)(?:[-_.]\*|\/\*\*)$/.exec(g);
    if (fam) life.add(fam[1]);
  }
  // A part that makes a name personal: a word no common vocabulary explains
  // (mkt, watchlist, a brand), or a life-area word.
  const revealing = (p, compounds) => p.length >= 3 && !/^\d/.test(p) && !allowWords.has(p) && (life.has(p) || !stop(p, compounds));
  // derived_allow: {token, reason} drops one token; {word, reason} says a word
  // never makes a name personal on its own account.
  const allow = new Map(), allowWords = new Map();
  for (const e of (raw && raw.derived_allow) || []) {
    const tok = typeof e === "string" ? e : e && e.token;
    if (tok) allow.set(normToken(tok), (e && e.reason) || "");
    if (e && e.word) allowWords.set(String(e.word).toLowerCase(), e.reason || "");
  }
  for (const w of allowWords.keys()) life.delete(w);

  // kind: "name" (a registry / file name) and "value" (a structured config
  // value) are kept when a part is revealing (one word: when no vocabulary
  // explains it); "phrase" (a capitalised phrase) unless it is all generic;
  // "word" (a capitalised word) unless a stop word; "exact" always.
  const add = (category, source, text, kind, opts = {}) => {
    const { parts, seps } = splitToken(text);
    if (!parts.length) return;
    const lparts = parts.map((p) => p.toLowerCase());
    if (lparts.every((p) => /^\d+$/.test(p))) return;
    const joined = lparts.join("");
    if (kind !== "exact" && joined.length < 3) return;
    // One word is a token only when no vocabulary explains it (watchlist, a
    // brand); a life-area word makes a compound personal (net-worth, cruise-watch)
    // but alone (health, travel) it is just a word.
    const compounds = kind === "name" && category !== "site";
    if ((kind === "name" || kind === "value") && (parts.length === 1 ? stop(lparts[0], compounds) : !lparts.some((p) => revealing(p, compounds)))) return;
    if (kind === "name" && joined.length < 4) return;
    if (kind === "word" && (stop(lparts[0]) || joined.length < 3)) return;
    if (kind === "phrase" && lparts.every((p) => GENERIC_WORDS.has(p) || FUNCTION_WORDS.has(p) || CONNECTORS.has(p))) return;
    const norm = normToken(text);
    if (kernel.ids.has(norm)) return;
    if (allow.has(norm)) {
      const a = allowed.get(norm) || { display: text, reason: allow.get(norm), sources: new Set() };
      a.sources.add(source);
      allowed.set(norm, a);
      return;
    }
    let t = tokens.get(norm);
    if (!t) {
      t = { display: text, parts, lparts, seps: seps.map((s) => sepClass(s, kind === "phrase" || kind === "word")), cs: !!opts.cs, category, sources: new Set() };
      tokens.set(norm, t);
    } else if (!opts.cs) t.cs = false;
    t.sources.add(source);
  };

  const local = (f) => reader.json(`${LOCAL_REL}/${f}`);
  const rel = (f) => `agent/local/${f}`;

  // instance.json: every identity value (the zone is the home_timezone shape;
  // host_label / host_title are how alerts word the machine — "the host" — not
  // an identity).
  const inst = local("instance.json") || {};
  for (const [k, v] of Object.entries(inst)) {
    if (k.startsWith("_") || k === "tz" || k === "host_label" || k === "host_title" || typeof v !== "string" || !v.trim()) continue;
    add("instance", `${rel("instance.json")} ${k}`, v, "exact");
    const at = v.indexOf("@");
    if (at > 0 && !placeholders(raw).consumer_email_domains.includes(v.slice(at + 1).toLowerCase())) add("instance", `${rel("instance.json")} ${k} (domain)`, v.slice(at + 1), "exact");
  }

  // Registries: names this installation added on top of the kernel's.
  for (const t of (local("tasks.json") || {}).tasks || []) if (t && typeof t.name === "string") add("task", rel("tasks.json"), t.name, "name");
  for (const k of Object.keys((local("job-routing.json") || {}).jobs || {})) add("job", rel("job-routing.json"), k, "name");
  const cj = local("chrome-jobs.json") || {};
  for (const n of [].concat(cj.jobs || [], cj.order || [])) if (typeof n === "string") add("job", rel("chrome-jobs.json"), n, "name");
  for (const s of (local("services.json") || {}).services || []) if (s && typeof s.name === "string") add("service", rel("services.json"), s.name, "name");

  // Personal files: playbooks, bins/libs/scripts, browsing-skill sites.
  const c = classifier(manifest || {});
  const personalFile = (f) => !c.kernel(f) && !c.owned(f) && c.personal(f);
  const files = trackedUnder(root, ["agent/ops-agent/jobs", "bin", "lib", "agent/scripts", "browsing-skills/skills"]);
  const sites = new Set();
  for (const f of files) {
    if (!personalFile(f)) continue;
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (f.startsWith("agent/ops-agent/jobs/")) {
      if (/\.md$/.test(base) && !f.slice("agent/ops-agent/jobs/".length).includes("/")) add("job", `${f} (personal playbook)`, base.replace(/\.md$/, ""), "name");
    } else if (f.startsWith("browsing-skills/skills/")) {
      sites.add(f.slice("browsing-skills/skills/".length).split("/")[0]);
    } else if (!/^(?:\.|README|index\.)|\.test\.|\.(?:md|json|txt|plist|lock|ya?ml|csv|log|html?)$/i.test(base)) {
      // A one-word file name (imsg, findme, normalize) is a plain word or a
      // tool's name; this installation's brands reach the table through its
      // config. Compound names (net-worth, cruise-link) are what reveal.
      const stem = base.replace(/\.(?:mjs|cjs|js|ts|sh|py|rb|swift|applescript)$/i, "");
      if (splitToken(stem).parts.length > 1) add("bin", f, stem, "name");
    }
  }
  for (const dir of sites) {
    const name = dir.replace(/^_+/, "");
    const src = `browsing-skills/skills/${dir}/ (personal site skill)`;
    add("site", src, name, "name");
    const labels = name.split(".");
    if (labels.length >= 2) add("site", src, labels[labels.length - 2], "name");
  }

  // Local config: values that look like proper nouns, emails, domains, hosts,
  // addresses, ids, wiki page ids.
  const ph = placeholders(raw);
  const phDomain = (d) => ph.email_domains.includes(d) || ph.email_tlds.includes(d.split(".").pop()) || ph.consumer_email_domains.includes(d);
  const fromString = (source, s) => {
    if (/^op:\/\//.test(s)) return; // a password-manager reference: the infra_ids pattern
    // An IANA zone id (a market's or a property's zone) is the home_timezone
    // shape's business, as instance.json tz is: its area ("America") and city
    // words are not names this installation registered.
    if (IANA_ZONE_VALUE.test(s.trim())) return;
    let rest = s;
    for (const m of s.matchAll(EMAIL)) {
      add("config", source, m[0], "exact");
      const d = m[1].toLowerCase();
      if (!phDomain(d)) add("config", `${source} (domain)`, d, "value");
      rest = rest.replace(m[0], " ");
    }
    for (const m of rest.matchAll(WIKI_ID)) {
      if (/_[a-z0-9]$/.test(m[0])) continue; // restaurant_x: a placeholder
      add("wiki", source, m[0], "exact");
    }
    for (const m of rest.matchAll(DOMAIN)) {
      const d = m[0].toLowerCase(), labels = d.split(".");
      if (phDomain(d) || stop(labels[labels.length - 2])) continue;
      add("config", `${source} (domain)`, d, "value");
    }
    for (const m of rest.matchAll(STREET)) {
      if (!ph.streets.map((x) => x.toLowerCase()).includes(m[2].trim().split(/\s+/)[0].toLowerCase())) add("config", `${source} (address)`, m[0].replace(/\.$/, ""), "phrase");
    }
    if (/^\d{4}-\d\d-\d\d(?:[T ][\d:.]+(?:Z|[+-]\d\d:?\d\d)?)?$/.test(rest.trim())) return; // a timestamp
    if (!/\s/.test(rest.trim())) {
      // A structured value (an identifier, path, name:target pair).
      for (let seg of rest.split(/[/:,|]+/)) {
        seg = seg.replace(/\.(?:md|json|ya?ml|js|mjs|cjs|sh|py|txt|plist|log|html?)$/i, "");
        if (!seg || /[*?^$\\()[\]{}+|<>"'`=]/.test(seg)) continue;
        add("config", source, seg, "value");
        if (isCamel(seg) && splitToken(seg).parts.length === 1 && camelSplit(seg).every((x) => x.length >= 3)) add("config", source, camelSplit(seg).join(" "), "phrase");
      }
      return;
    }
    // Prose: capitalised phrases and words, short all-caps names, mixed ids.
    const words = [...rest.matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map((m) => ({ t: m[0], s: m.index, e: m.index + m[0].length }));
    const isTitle = (t) => /^\p{Lu}[\p{Ll}\p{M}]+(?:\p{Lu}[\p{Ll}\p{M}]+)*$/u.test(t);
    let phrase = [];
    const flush = () => {
      while (phrase.length && (FUNCTION_WORDS.has(phrase[0].t.toLowerCase()) || CONNECTORS.has(phrase[0].t.toLowerCase()))) phrase.shift();
      while (phrase.length && CONNECTORS.has(phrase[phrase.length - 1].t.toLowerCase())) phrase.pop();
      if (phrase.length >= 2) add("config", source, rest.slice(phrase[0].s, phrase[phrase.length - 1].e), "phrase");
      for (const w of phrase) if (isTitle(w.t)) add("config", source, w.t, "word");
      phrase = [];
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i], gap = i ? rest.slice(words[i - 1].e, w.s) : "";
      const joins = phrase.length && /^[ -]$/.test(gap);
      if (isTitle(w.t) || (joins && CONNECTORS.has(w.t) && words[i + 1] && isTitle(words[i + 1].t) && /^[ -]$/.test(rest.slice(w.e, words[i + 1].s)))) {
        if (phrase.length && !joins) flush();
        phrase.push(w);
        continue;
      }
      flush();
      if (/^\p{Lu}{3,6}$/u.test(w.t)) add("config", source, w.t, "word", { cs: true });
      else if (/^(?=(?:.*\d){2})(?=.*[A-Za-z])[A-Za-z0-9]{6,}$/.test(w.t)) add("config", `${source} (id)`, w.t, "value");
    }
    flush();
  };
  const walkValues = (source, v, keyPath) => {
    if (typeof v === "string") fromString(`${source} ${keyPath}`.trim(), v);
    else if (Array.isArray(v)) v.forEach((x, i) => walkValues(source, x, `${keyPath}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!k.startsWith("_")) walkValues(source, x, keyPath ? `${keyPath}.${k}` : k);
  };
  let cfgFiles = [];
  cfgFiles = reader.list(`${LOCAL_REL}/config`).filter((f) => f.endsWith(".json")).sort();
  for (const f of cfgFiles) {
    const v = reader.json(`${LOCAL_REL}/config/${f}`);
    if (v) walkValues(rel(`config/${f}`), v, "");
  }
  for (const [w, reason] of allowWords) allowed.set(`word:${w}`, { display: `${w} (word)`, reason, sources: new Set(["personal-patterns.json derived_allow"]) });
  return { tokens, allowed, kernel, life, tz: typeof inst.tz === "string" ? inst.tz : null };
}

function derivedDetectors(table) {
  const index = new Map(), counts = new Map();
  for (const t of table.tokens.values()) {
    (index.get(t.lparts[0]) || index.set(t.lparts[0], []).get(t.lparts[0])).push(t);
    counts.set(t.category, (counts.get(t.category) || 0) + 1);
  }
  for (const list of index.values()) list.sort((a, b) => b.parts.length - a.parts.length); // longest first
  let memoLine = null, memo = null;
  const NONE = new Map();
  const ascii = /[A-Za-z0-9]+/g, uni = /[\p{L}\p{N}]+/gu;
  const matches = (line) => {
    if (line === memoLine) return memo;
    memoLine = line;
    memo = NONE;
    // Most lines name no token: look the words (and camelCase humps) up before
    // building anything.
    const isAscii = /^[\x00-\x7f]*$/.test(line), rx = isAscii ? ascii : uni, hump = isAscii ? /[a-z][A-Z]|[A-Z][A-Z][a-z]/ : /\p{Ll}\p{Lu}|\p{Lu}\p{Lu}\p{Ll}/u;
    let any = false;
    rx.lastIndex = 0;
    for (let m; !any && (m = rx.exec(line));) {
      const w = m[0];
      if (index.has(w.toLowerCase())) any = true;
      else if (hump.test(w)) for (const p of camelSplit(w)) if (index.has(p.toLowerCase())) { any = true; break; }
    }
    if (!any) return memo;
    const [runs, camel] = lineWords(line);
    memo = matchTokens(runs, index, line, table.kernel.ids);
    if (camel) matchTokens(camel, index, line, table.kernel.ids, memo);
    return memo;
  };
  const out = [];
  for (const [category, name, desc] of DERIVED_CATEGORIES) {
    if (!counts.get(category)) continue;
    const exec = (line, ctx) => {
      const m = matches(line).get(category);
      if (!m) return null;
      // A personal file named by path in kernel code is the closure rule's to
      // judge (kernel-guard --closure: refused unless guarded), not a leak.
      if (category === "bin" && ctx && ctx.kind === "code" && (line[m.s - 1] === "/" || /^\.(?:mjs|cjs|js|ts|sh|py)\b/.test(line.slice(m.e)))) return null;
      return hitAt(line.slice(m.s, m.e), m.s, `${name}: "${m.t.display}" from ${[...m.t.sources].slice(0, 3).join("; ")}${m.t.sources.size > 3 ? ` (+${m.t.sources.size - 3} more)` : ""}`);
    };
    out.push({ name, group: "derived", severity: "hard", rx: detector(exec), only: null, excl: LOCK_FILE, describe: `${desc} — ${counts.get(category)} token(s)`, kind: "derived" });
  }
  return out;
}

const _derivedCache = new Map();
/**
 * The derived token table of `root`, built once per process (per mode).
 * `{ staged: true }` derives from the index copies of the registries and
 * config — what the commit will land — instead of the working tree.
 */
function derivedTable(root, manifest, raw, { staged = false } = {}) {
  const abs = path.resolve(root);
  const key = `${abs}\0${staged ? "staged" : "tree"}`;
  if (!_derivedCache.has(key)) _derivedCache.set(key, derivedTokens(abs, manifest, raw, repoReader(abs, { staged })));
  return _derivedCache.get(key);
}

/**
 * Every pattern kernel-guard runs for a repo: the static list, the shape
 * detectors and the patterns derived from the repo's personal registries and
 * config. `raw` is the parsed personal-patterns.json; `opts.staged` derives
 * from the index (kernel-guard --staged, the commit gate).
 */
function allPatterns(root, raw, manifest, where = "patterns", opts = {}) {
  const pats = compilePatterns(raw, where);
  if (raw && raw.detectors === false) return pats;
  const table = root ? derivedTable(root, manifest, raw, opts) : { tokens: new Map(), allowed: new Map(), kernel: { ids: new Set() }, tz: null };
  return pats.concat(shapeDetectors(raw, table.tz), derivedDetectors(table));
}

module.exports = {
  ALLOW_MARKER,
  allPatterns,
  commentText,
  derivedTable,
  repoReader,
  fileKind,
  isPlaceholderHex,
  normToken,
  shapeDetectors,
  CLASSIFY_HELP,
  DESTINATIONS,
  addedHardHits,
  changeRefusals,
  classifier,
  compilePatterns,
  dirOf,
  globToRegExp,
  lineKey,
  loadRepo,
  patternsFile,
  NO_PATTERNS,
  synthManifest,
  kernelOnlyManifest,
  manifestFiles,
  ownedFiles,
  scanContent,
  unclassified,
  unusedGlobs,
};

// Common English words (~9,900): never a derived token on their own. The
// 10,000 most frequent English words (google-10000-english, no swears) minus
// every word a hunspell en_US dictionary only knows capitalised (names, places,
// brands: exactly what derived tokens are for) and a few spam terms; then the
// other en_US dictionary words the kernel itself writes in lowercase (attendee,
// provenance, spool …). Lowercase, space-separated.
const COMMON_WORDS = `
the and for that this with you not are from your all have new more was will home can about page has search
free but our one other information time they site may what which their news out use any there see only his
when contact here business who web also now help get view online first been would how were services some these
click its like service than find price date back top people had list name just over state year day into email
two health world next used work last most products music buy data make them should product system post her
city add policy number such please available copyright support message after best software then good video
well where info rights public books high school through each links she review years order very privacy book
items company read group need many user said does set under general research university mail full map reviews
program life know games way days management part could great united hotel real item international center ebay
must store travel comments made development report off member details line terms before hotels did send right
type because local those using results office education national car design take posted internet address
community within area want phone shipping reserved subject between forum family long based code show even
black check special prices website index being women much sign file link open today technology south case
project same pages version section own found sports house related security both county photo game members
power while care network down computer systems three total place end following download him without per access
think north resources current posts big media law control water history pictures size art personal since
including guide shop directory board location change white text small rating rate government children during
return students shopping account times sites level digital profile previous form events love old john main
call hours image department title description non insurance another why shall property class still money
quality every listing content country private little visit save tools low reply customer compare movies
include college value article man card provide food source author different press learn sale around print
course job process teen room stock training too credit point join science men categories advanced west sales
look left team estate box conditions select photos thread week category note live large gallery table register
however market library really action start series model features air industry plan human provided yes required
second hot accessories cost movie forums march better say questions yahoo going medical test friend come
server study application cart staff articles feedback again play looking issues never users complete street
topic comment financial things working against standard tax person below mobile less got blog party payment
equipment login student let programs offers legal above recent park stores side act problem red give memory
performance social august quote language story sell options experience rates create key body young important
field few east paper single age activities club example girls additional password latest something road gift
question changes night hard pay four status browse issue range building seller court always result audio light
write war offer blue groups easy given files event release analysis request fax china making picture needs
possible might professional yet month major star areas future space committee hand sun cards problems meeting
rss become interest child keep enter share similar garden schools million added reference companies listed
baby learning energy run delivery net popular term film stories put computers journal reports try welcome
central images president notice original head radio until cell color self council away includes track
discussion archive once others entertainment agreement format least society months log safety friends sure
trade edition cars messages marketing tell further updated association able having provides fun already green
studies close common drive specific several gold living collection called short arts lot ask display limited
powered solutions means director daily beach past natural whether due electronics five upon period planning
database says official weather mar land average done technical window pro region island record direct
conference environment records district calendar costs style front statement update parts ever downloads early
sound resource present applications either ago document word works material bill written talk federal hosting
rules final tickets thing centre requirements via cheap kids finance true minutes else mark third rock gifts
reading topics bad individual tips plus auto cover usually edit together videos percent fast function fact
unit getting global tech meet far economic player projects lyrics often subscribe submit amount watch included
feel though bank risk thanks everything deals various words production commercial weight town heart
advertising received choose treatment newsletter archives points knowledge magazine error camera jun girl
currently construction toys registered clear golf receive domain methods chapter makes protection policies
loan wide beauty manager position taken sort listings models known half cases step engineering simple quick
none wireless license lake whole annual published later basic shows corporate google church method purchase
customers active response practice hardware figure materials fire holiday chat enough designed along among
death writing speed countries loss face brand discount higher effects created remember standards oil bit
yellow political increase advertise kingdom base near environmental thought stuff french storage japan doing
loans shoes entry stay nature orders availability summary turn mean growth notes agency king activity copy
although drug pics western income force cash employment overall bay river commission package contents seen
players engine port album regional stop supplies started administration bar institute views plans double dog
build screen exchange types soon sponsored lines electronic continue across benefits needed season apply
someone held anything printer condition effective believe organization effect asked mind selection lost tour
menu volume cross anyone mortgage hope silver corporation wish inside solution mature role rather addition
came supply nothing certain usr executive running lower necessary union jewelry according clothing com
particular fine names homepage hour gas skills six bush islands advice career military rental decision leave
teens pre huge sat woman facilities zip bid kind middle move cable opportunities taking values division coming
object appropriate machine logo length actually nice score statistics client returns capital follow sample
investment sent shown culture band flash lead choice went starting registration courses consumer airport
foreign artist outside furniture levels channel letter mode phones ideas structure fund summer allow degree
contract button releases wed homes super male matter custom almost took located multiple distribution editor
inn industrial cause potential song cnet ltd focus late fall featured idea rooms female responsible inc
communications win associated primary cancer reason tool browser spring foundation answer voice friendly
schedule documents communication purpose feature bed comes police everyone independent approach cameras brown
physical operating hill maps medicine deal hold ratings forms glass happy smith wanted developed thank safe
unique survey prior telephone sport ready feed animal sources population regular secure navigation operations
therefore simply evidence station christian round favorite understand option master valley recently probably
rentals sea built publications blood cut worldwide improve connection publisher hall larger anti networks
earth parents impact transfer introduction kitchen strong tel wedding properties hospital ground overview ship
accommodation owners disease excellent paid perfect hair opportunity kit classic basis command cities express
award distance tree peter assessment ensure thus wall involved extra especially interface partners budget
rated guides success maximum operation existing quite selected boy amazon patients restaurants beautiful
warning wine locations horse vote forward stars significant lists technologies owner retail animals useful
directly manufacturer ways son providing rule mac housing takes iii bring catalog searches max trying mother
authority considered told traffic programme joined input strategy feet agent valid bin modern senior teaching
door grand testing trial charge units instead cool normal wrote enterprise ships entire educational leading
metal positive fitness opinion football abstract uses output funds greater likely develop employees artists
alternative processing responsibility resolution java guest seems publication pass relations trust van
contains session multi photography republic fees components vacation century academic assistance completed
skin graphics prev ads expected ring grade pacific mountain organizations pop filter mailing vehicle longer
consider int northern behind panel floor buying match proposed default require boys outdoor deep morning
otherwise allows rest protein plant reported hit transportation pool mini politics partner disclaimer authors
boards faculty parties fish membership mission eye string sense modified pack released stage internal goods
recommended born unless detailed race approved background target except character maintenance ability maybe
functions moving brands places pretty trademarks southern yourself etc winter battery youth pressure submitted
debt keywords medium television interested core break purposes throughout sets dance wood msn itself defined
papers playing awards fee studio reader virtual device established answers rent las remote dark programming
external apple regarding instructions min offered theory enjoy remove aid surface minimum visual host variety
teachers martin manual block subjects agents increased repair fair civil steel understanding songs fixed wrong
beginning hands associates finally updates desktop classes gets sector capacity requires jersey fat fully
father electric saw instruments quotes officer driver businesses dead respect unknown specified restaurant
mike trip worth procedures poor teacher eyes relationship workers farm peace traditional campus tom showing
creative coast benefit progress funding devices lord grant sub agree fiction hear sometimes watches careers
beyond goes families museum themselves fan transport interesting blogs wife evaluation accepted former
implementation ten hits zone complex cat galleries references die presented jack flat flow agencies literature
respective parent setting scale stand economy highest helpful monthly critical frame musical definition
secretary networking path employee chief gives bottom magazines packages detail laws changed pet heard begin
individuals royal clean switch largest guy titles relevant guidelines justice connect bible dev cup basket
applied weekly vol installation described demand suite square attention advance skip diet army auction gear
lee difference allowed correct nation selling lots piece sheet firm seven older regulations elements species
jump cells module resort facility random pricing dvds certificate minister motion looks fashion directions
visitors documentation monitor trading forest calls whose coverage couple giving chance vision ball ending
clients actions listen discuss accept automotive goal successful sold wind communities clinical situation
sciences markets lowest highly publishing appear emergency developing lives currency leather determine
temperature palm announcements patient actual historical stone bob commerce ringtones perhaps persons
difficult scientific satellite fit tests village accounts amateur met pain xbox particularly factors coffee
settings buyer cultural easily oral ford poster edge functional root closed holidays ice pink balance
monitoring graduate replies shot architecture initial label thinking llc sec recommend canon league waste
minute bus provider optional dictionary cold accounting manufacturing sections chair fishing effort phase bag
fantasy letters motor professor context install shirt apparel generally continued foot mass crime count breast
techniques quickly dollars websites religion claim driving permission surgery patch heat wild measures
generation miss chemical doctor task reduce brought himself nor component enable exercise bug mid guarantee
leader diamond processes soft servers alone meetings seconds keyword interests flight congress fuel username
walk produced paperback classifieds wait supported pocket saint rose freedom argument competition creating
drugs joint premium providers fresh characters attorney upgrade factor growing thousands stream apartments
pick hearing eastern auctions therapy entries dates generated signed upper administrative serious prime limit
began steps errors shops efforts informed thoughts creek worked quantity urban practices sorted reporting
essential myself tours platform load affiliate labor immediately admin nursing defense machines designated
tags heavy covered recovery guys integrated configuration merchant comprehensive expert universal protect drop
solid cds presentation languages became orange compliance vehicles prevent theme rich campaign marine
improvement guitar finding examples ipod saying spirit claims challenge acceptance strategies seem affairs
touch intended towards goals hire election suggest branch charges serve affiliates reasons magic mount smart
talking gave ones multimedia avoid certified manage corner rank computing element birth virus abuse
interactive requests separate quarter procedure leadership tables define racing religious facts breakfast
column plants faith chain developer identify avenue missing died approximately domestic sitemap
recommendations moved reach comparison mental viewed moment extended sequence inch attack sorry centers
opening damage lab reserve recipes gamma plastic produce snow placed truth counter failure follows weekend
dollar camp automatically des films bridge native fill movement printing baseball owned approval draft chart
played contacts readers clubs equal adventure matching offering shirts profit leaders posters institutions
assistant variable ave advertisement expect parking headlines yesterday compared determined wholesale workshop
gone codes kinds extension statements golden completely teams fort lighting senate forces funny brother gene
turned portable tried electrical applicable disc returned pattern boat named theatre laser earlier
manufacturers sponsor classical icon warranty dedicated direction harry basketball objects ends delete evening
assembly nuclear taxes mouse signal criminal issued brain sexual powerful dream obtained false cast flower
felt personnel passed supplied identified falls pic soul opinions promote stated stats professionals appears
carry flag decided covers advantage hello designs maintain tourism priority newsletters adults clips savings
graphic atom payments estimated binding brief ended winning eight anonymous iron straight script served wants
miscellaneous prepared void dining alert integration tag interview mix framework disk installed queen credits
clearly fix handle sweet desk criteria pubmed vice associate truck behavior enlarge ray frequently revenue
measure changing votes duty looked discussions bear gain festival laboratory ocean flights experts signs lack
depth whatever logged laptop vintage train exactly dry explore spa concept nearly eligible checkout reality
forgot handling origin knew gaming feeds billion destination faster intelligence bought con nations route
followed specifications broken tripadvisor frank zoom blow battle residential anime speak decisions industries
protocol query clip partnership editorial expression equity provisions speech wire principles suggestions
rural shared sounds replacement tape strategic judge spam economics acid bytes cent forced compatible fight
apartment height null zero speaker filed obtain consulting recreation offices designer remain managed failed
marriage roll participants secret bath leads negative favorites theater springs var perform healthy
translation estimates font assets injury ministry drivers lawyer figures married protected proposal sharing
portal waiting birthday beta fail gratis banking officials toward won slightly assist conduct contained
lingerie legislation calling parameters jazz serving bags profiles comics matters houses doc postal
relationships wear controls breaking combined ultimate representative frequency introduced minor finish
departments residents noted displayed mom reduced physics rare spent performed extreme samples bars reviewed
row forecast removed helps singles administrator cycle amounts contain accuracy dual rise usd sleep bird
pharmacy creation static scene hunter addresses lady crystal famous writer chairman violence fans speakers
drink academy dynamic gender eat permanent agriculture dell cleaning constitutes portfolio practical delivered
collectibles infrastructure exclusive seat concerns vendor originally intel utilities philosophy regulation
officers reduction aim bids referred supports nutrition recording regions junior toll cape rings meaning tip
secondary wonderful mine ladies ticket announced guess agreed prevention whom ski soccer math import posting
presence instant mentioned automatic healthcare viewing maintained increasing majority connected dogs
directors aspects ahead moon participation scheme utility preview fly manner matrix containing combination
devel amendment despite strength guaranteed turkey libraries proper distributed degrees enterprises delta fear
seeking inches phoenix convention shares principal daughter standing comfort colors wars ordering kept alpha
appeal cruise bonus certification previously hey bookmark buildings specials beat household batteries adobe
smoking becomes drives arms tea improved trees avg achieve positions dress subscription dealer contemporary
sky nearby carried happen exposure hide permalink signature gambling refer miller provision outdoors clothes
caused luxury babes frames certainly indeed newspaper toy circuit layer printed slow removal easier src
liability trademark hip printers faqs nine adding mostly spot trackback prints spend factory interior revised
grow americans optical promotion relative amazing clock dot identity suites conversion feeling hidden
reasonable serial relief revision broadband influence ratio pda importance rain onto dsl planet webmaster
copies recipe zum permit seeing proof diff tennis bass prescription bedroom empty instance hole pets ride
licensed specifically bureau represent conservation pair ideal specs recorded don pieces finished dinner
lawyers stress cream runs trends yeah discover patterns boxes hills fourth advisor marketplace evil aware
shape evolution certificates objectives stations suggested remains acc greatest firms concerned euro operator
structures generic encyclopedia usage cap ink charts continuing mixed census interracial peak competitive
exist wheel transit suppliers salt compact poetry lights tracking angel bell keeping preparation attempt
receiving matches accordance width noise engines forget array discussed accurate climate reservations pin
alcohol instruction managing annotation sister raw differences walking explain smaller newest establish gnu
happened expressed extent sharp lane paragraph kill mathematics compensation export managers aircraft modules
conflict conducted versions employer occur percentage knows describe concern backup requested citizens
heritage personals immediate holding trouble spread coach agricultural expand supporting audience assigned
collections ages participate plug specialist cook affect virgin experienced investigation raised hat
institution directed dealers searching sporting helping affected lib bike totally plate expenses indicate
blonde proceedings transmission characteristics der lose organic seek experiences albums cheats extremely
verzeichnis contracts guests hosted diseases concerning developers equivalent chemistry tony neighborhood kits
variables agenda anyway continues tracks advisory cam curriculum logic template prince circle soil grants
anywhere psychology responses wet circumstances investor identification ram leaving wildlife appliances
elementary cooking speaking sponsors fox unlimited respond sizes plain exit entered arm keys launch wave
checking costa printable holy guidance mesh trail enforcement symbol crafts highway buddy hardcover observed
dean setup poll booking glossary fiscal celebrity styles filled bond channels ericsson appendix notify blues
chocolate pub portion scope supplier cables cotton controlled requirement authorities biology dental killed
border ancient debate representatives starts pregnancy causes biography leisure attractions learned
transactions notebook explorer historic attached opened husband disabled authorized crazy upcoming concert
retirement scores financing efficiency comedy adopted efficient weblog linear commitment specialty bears jean
hop carrier edited constant visa mouth meter linked interviews concepts gun reflect pure deliver wonder
lessons fruit begins qualified reform lens alerts treated discovery draw classified relating assume confidence
alliance confirm warm neither offline leaves engineer lifestyle consistent replace clearance connections
inventory converter organisation babe checks reached becoming safari objective indicated sugar crew legs stick
securities relation enabled genre slide volunteer tested rear democratic enhance exact bound parameter adapter
processor node formal dimensions contribute lock hockey storm micro colleges laptops mile showed challenges
editors mens threads bowl supreme brothers recognition presents ref tank submission dolls estimate encourage
navy kid regulatory inspection consumers cancel limits territory transaction weapons paint delay pilot outlet
contributions continuous resulting initiative novel pan execution disability increases ultra winner contractor
episode examination potter dish plays bulletin indicates modify oxford truly epinions painting committed
extensive affordable universe candidate databases patent slot psp outstanding eating perspective planned
watching lodge messenger mirror tournament consideration discounts sterling sessions kernel stocks buyers
journals gray catalogue charged broad und chosen demo hate terminal publishers nights behalf liquid rice loop
salary reservation foods gourmet guard properly saving remaining empire resume twenty newly raise prepare
avatar depending illegal expansion vary hundreds helped premier tomorrow purchased milk decide consent drama
visiting performing downtown keyboard contest collected bands boot suitable absolutely millions lunch audit
push chamber guinea findings muscle featuring implement clicking scheduled polls typical tower yours sum misc
calculator significantly chicken temporary attend shower sending tonight dear sufficient holdem shell province
catholic oak vat awareness governor beer seemed contribution measurement swimming spyware formula constitution
packaging solar catch reliable consultation northwest sir doubt earn finder unable periods classroom tasks
democracy attacks wallpaper merchandise const resistance doors symptoms resorts biggest memorial visitor twin
forth insert gateway dont alumni drawing candidates ordered biological fighting transition happens preferences
spy romance instrument split themes heaven bits pregnant twice classification focused physician bargain
cellular asking blocks normally spiritual hunting diabetes suit shift chip res sit bodies photographs cutting
wow writers flexible loved mapping numerous relatively birds satisfaction represents char indexed superior
preferred saved paying cartoon shots intellectual granted choices carbon spending comfortable magnetic
interaction listening effectively registry crisis outlook massive employed bright treat header poverty formed
piano echo grid sheets experimental revolution consolidation displays plasma allowing earnings mystery
landscape dependent mechanical journey bidding consultants risks banner applicant charter fig cooperation
counties acquisition ports implemented directories recognized dreams blogger notification licensing stands
teach occurred textbooks rapid pull hairy diversity reverse deposit seminar investments wheels specify
accessibility dutch sensitive templates formats tab depends boots holds router concrete editing folder womens
completion upload pulse universities technique contractors voting courts notices subscriptions calculate
broadcast converted metro anniversary improvements strip specification pearl accident nick accessible
accessory resident plot qty possibly airline typically representation regard pump exists arrangements smooth
conferences uniprotkb strike consumption flashing narrow afternoon threat surveys sitting putting consultant
controller ownership committees legislative researchers trailer castle gardens missed unsubscribe antique
labels willing bio molecular acting heads stored exam logos residence attorneys antiques density hundred
operators strange sustainable statistical beds mention innovation pcs employers parallel amended operate bills
bold bathroom stable opera definitions von doctors lesson cinema asset scan elections drinking reaction blank
enhanced entitled severe generate stainless newspapers hospitals deluxe humor aged monitors exception lived
duration bulk successfully pursuant sci fabric visits primarily tight domains capabilities pmid contrast
recommendation flying recruitment sin cute organized para adoption improving expensive meant capture pounds
buffalo organisations plane explained seed programmes desire expertise mechanism camping jewellery meets
welfare peer caught eventually marked driven measured medline bottle agreements considering innovative massage
rubber conclusion closing thousand meat legend grace python monster bang villa bone columns disorders bugs
collaboration detection ftp cookies inner formation tutorial med engineers entity cruises gate holder
proposals moderator tutorials settlement roman duties valuable tone collectables ethics forever dragon busy
captain fantastic imagine brings heating leg neck wing governments purchasing scripts stereo appointed taste
dealing commit tiny operational rail airlines liberal livecam jay trips gap sides tube turns corresponding
descriptions cache belt jacket determination animation oracle lease productions aviation hobbies proud excess
disaster console commands telecommunications instructor giant achieved injuries shipped seats approaches biz
alarm voltage usual loading stamps appeared angle rob vinyl highlights mining designers ongoing worst imaging
betting scientists liberty blackjack era convert possibility analyst commissioner dangerous garage exciting
reliability thongs unfortunately respectively volunteers attachment ringtone derived pleasure honor asp
oriented eagle desktops pants nurse prayer appointment workshops hurricane quiet luck postage producer
represented mortgages dial responsibilities cheese comic carefully jet productivity investors crown par
underground diagnosis maker crack principle picks vacations gang semester calculated applies casinos
appearance smoke filters incorporated craft cake notebooks apart fellow blind lounge mad algorithm semi coins
gross strongly cafe valentine ken proteins horror exp familiar capable till involving pen investing admission
shoe elected carrying victory sand terrorism joy editions mainly ethnic ran parliament actor finds seal
situations fifth allocated citizen vertical corrections structural municipal describes prize occurs absolute
disabilities consists anytime substance prohibited addressed lies pipe soldiers guardian lecture simulation
layout initiatives ill concentration classics lbs lay interpretation horses lol dirty deck donate taught
bankruptcy worker optimization alive temple substances prove discovered wings breaks genetic restrictions
participating waters promise thin exhibition prefer ridge cabinet modem mph bringing sick dose evaluate
tropical collect bet composition streets nationwide vector definitely shaved turning buffer purple existence
commentary limousines developments def immigration destinations lets mutual pipeline necessarily syntax
attribute prison skill chairs everyday apparently surrounding mountains moves popularity inquiry checked
exhibit throw trend sierra visible cats desert postposted oldest coordinator obviously mercury handbook
navigate worse summit victims spaces fundamental burning escape coupons somewhat receiver substantial
progressive boats glance championship arcade impossible tells obvious fiber depression graph covering platinum
judgment bedrooms talks filing foster modeling passing awarded testimonials trials tissue memorabilia bonds
cartridge explanation folk org commons subsection fraud electricity permitted spectrum arrival okay pottery
emphasis roger aspect workplace awesome confirmed counts priced wallpapers hist crash lift desired inter
closer assumes heights shadow riding infection expense grove eligibility venture clinic healing princess mall
entering packet spray studios involvement dad buttons placement observations vbulletin funded winners extend
roads subsequent pat rolling fell motorcycle yard disclosure establishment memories nelson arrived creates
faces tourist mayor murder adequate senator yield presentations grades cartoons pour digest reg lodging tion
dust hence wiki entirely replaced radar rescue undergraduate losses combat reducing stopped occupation lakes
donations associations citysearch closely radiation diary seriously kings shooting adds nsw ear flags pci
baker launched elsewhere pollution conservative guestbook shock effectiveness abroad ebony tie ward drawn
visited roof walker demonstrate atmosphere suggests kiss beast operated experiment targets overseas purchases
dodge counsel federation pizza invited yards assignment chemicals mod farmers queries rush absence nearest
cluster vendors whereas yoga serves woods surprise lamp partial shoppers everybody couples ranking jokes twiki
sublime counseling palace acceptable satisfied glad wins measurements verify globe trusted copper rack
medication warehouse shareware rep dicke receipt supposed ordinary nobody ghost violation configure stability
applying southwest boss pride institutional expectations knowing reporter metabolism champion cloudy
personally plenty solo sentence throat ignore maria uniform excellence wealth tall somewhere vacuum dancing
attributes recognize brass writes plaza pdas outcomes survival quest publish sri screening toe thumbnail trans
whenever nova lifetime pioneer booty forgotten acrobat plates acres venue athletic thermal essays vital
telling fairly coastal config charity intelligent excel modes obligation wake stupid harbor traveler urw
segment realize regardless enemy puzzle rising aluminum wishlist opens insight sms restricted secrets lucky
latter merchants thick trailers repeat syndrome attendance penalty drum glasses enables nec builder vista
chips terry flood foto ease arguments arena adventures pupils announcement tabs outcome appreciate expanded
casual grown polish lovely extras centres clause smile lands troops indoor armed broker charger regularly
believed pine cooling tend gulf rick trucks mechanisms divorce shopper partly customize tradition candy pills
tiger folks sensor exposed telecom hunt angels deputy indicators sealed emissions physicians loaded complaint
scenes experiments boost spanking scholarship governance mill founded supplements chronic icons moral den
catering aud finger keeps pound locate camcorder trained burn implementing roses labs ourselves bread tobacco
wooden motors tough incident gonna dynamics lie crm conversation decrease chest pension billy revenues
emerging worship capability herself producing churches precision damages reserves contributed solve shorts
reproduction minority diverse amp ingredients johnny sole franchise recorder complaints facing promotions
tones passion rehabilitation maintaining sight laid clay defence patches weak refund usc towns environments
trembl divided blvd reception wise emails odds correctly insider seminars consequences makers hearts geography
appearing integrity worry discrimination eve carter legacy pleased danger vitamin widely processed phrase
genuine raising implications functionality paradise hybrid reads roles intermediate emotional sons leaf pad
glory platforms bigger billing diesel versus combine overnight geographic exceed rod fault hrs preliminary
districts introduce silk promotional babies compiled romantic revealed specialists generator examine jimmy
graham suspension sad correction wolf slowly authentication communicate rugby supplement showtimes cal
portions infant promoting sectors fluid grounds fits kick regards meal hurt machinery bandwidth unlike
equation baskets probability pot dimension wright img proven schedules admissions cached warren slip studied
reviewer involves quarterly rpm profits devil grass comply florist illustrated cherry continental alternate
deutsch achievement limitations webcam cuts funeral nutten earrings enjoyed automated chapters pee charlie
passenger convenient tvs sized manga noticed socket silent literary egg signals caps orientation pill theft
childhood swing symbols lat meta humans analog facial choosing talent dated flexibility seeker wisdom shoot
boundary mint offset payday elite spin holders believes poems deadline jurisdiction robot displaying witness
equipped stages encouraged sur winds powder acquired assess wash cartridges stones entrance gnome roots
declaration losing attempts gadgets noble automation impacts rev gospel advantages shore loves induced knight
preparing loose aims recipient linking extensions appeals earned illness athletics southeast alternatives
pending determining corp personalized conditioning teenage soap triple cooper jam secured unusual answered
partnerships destruction slots increasingly migration disorder routine toolbar basically rocks conventional
titans applicants wearing axis sought genes mounted habitat firewall median guns scanner herein occupational
animated judicial adjustment hero integer treatments bachelor attitude camcorders engaged falling basics
carpet struct lenses binary genetics attended difficulty punk collective coalition dropped enrollment duke
pace besides wage producers collector arc hosts interfaces advertisers moments atlas strings dawn representing
observation feels torture deleted coat mrs rica restoration convenience returning opposition container
defendant confirmation app embedded inkjet supervisor wizard corps actors liver peripherals liable brochure
bestsellers petition recall antenna picked assumed departure belief killing bikini shoulder decor lookup texts
brokers ion diameter doll podcast seasons interactions refine bidder singer herald literacy fails aging
intervention fed plugin attraction diving invite modification latinas suppose customized involve moderate
terror younger thirty mice opposite understood rapidly dealtime ban temp intro zus assurance clerk happening
vast outline amendments receives jeans metropolitan compilation verification fonts ent odd wrap refers mood
favor veterans quiz sigma attractive xhtml occasion recordings victim demands sleeping careful ext beam
gardening obligations arrive orchestra sunset tracked moreover minimal polyphonic lottery tops framed aside
outsourcing licence adjustable allocation essay discipline demonstrated dialogue identifying alphabetical
camps declared dispatched handheld trace disposal shut florists packs installing switches voluntary thou
consult greatly blogging mask cycling midnight commonly photographer inform coal cry messaging quantum intent
zoo largely pleasant announce constructed additions requiring spoke aka arrow engagement sampling rough weird
tee refinance lion inspired holes weddings blade suddenly oxygen cookie meals canyon goto meters merely
calendars arrangement conclusions passes bibliography pointer compatibility stretch furthermore permits
cooperative sleeve cleaner cricket beef feeding stroke township rankings measuring cad hats robin strap
headquarters crowd tcp transfers surf transformation remained attachments entities customs administrators
personality rainbow hook roulette decline gloves medicare cord skiing cloud facilitate subscriber valve val
explains proceed flickr feelings knife priorities shelf bookstore timing liked parenting adopt denied fotos
incredible freeware donation outer crop deaths commonwealth pharmaceutical tales workforce nodes thumbs seeds
cited lite hub targeted organizational realized twelve founder decade gamecube dispute tired titten adverse
everywhere excerpt steam discharge drinks ace voices acute climbing stood sing tons perfume carol honest
hazardous restore stack methodology somebody sue housewares reputation resistant democrats recycling hang gbp
curve creator amber qualifications museums coding slideshow tracker variation passage transferred trunk hiking
jelsoft headset photograph waves camel distributor lamps underlying hood wrestling suicide archived photoshop
chi gathering projection juice chase mathematical logical sauce fame extract specialized diagnostic panama
payable corporations courtesy criticism automobile confidential statutory accommodations northeast downloaded
seo retired remarks detected decades paintings walked arising bracelet eggs juvenile injection populations
protective afraid acoustic railway cassette initially indicator pointed jpg causing mistake locked eliminate
fusion mineral sunglasses ruby steering beads fortune preference canvas threshold parish claimed screens
cemetery planner flows stadium exploration mins fewer sequences coupon nurses ssl stem proxy astronomy opt
drew contests flu translate announces mlb costume tagged voted killer bikes adjusted rap tune bishop pulled
corn shaped compression seasonal establishing farmer counters puts constitutional grew perfectly tin slave
instantly cultures coaching examined trek encoding litigation submissions oem heroes painted lycos zdnet
broadcasting horizontal artwork cosmetic resulted portrait terrorist informational ethical carriers ecommerce
mobility floral builders ties struggle schemes suffering neutral fisher rat prospective bedding ultimately
joining heading equally artificial bearing spectacular coordination connector brad combo seniors worlds guilty
affiliated activation naturally haven tablet jury tail subscribers charm lawn violent underwear basin soup
potentially ranch constraints crossing inclusive dimensional cottage drunk considerable crimes resolved byte
toner nose latex branches anymore oclc holdings alien locator selecting processors pantyhose plc broke
difficulties complexity constantly browsing resolve presidential documentary cod territories thesis thru jews
nylon discs rocky bargains frequent trim ceiling pixels ensuring legislature hospitality anybody procurement
diamonds fleet untitled bunch totals singing theoretical afford exercises starring referral surveillance
optimal quit distinct protocols lung highlight substitute inclusion hopefully brilliant turner sucking cents
gel spoken omega evaluated stayed civic assignments manuals sees termination watched saver thereof grill
households redeem grain authentic regime wanna wishes bull architectural depend differ movements ranging
repairs breath amenities virtually mart candle hanging colored authorization tale verified formerly projector
situated comparative std seeks herbal loving strictly routing docs psychological surprised retailer vitamins
elegant gains renewal vid genealogy opposed deemed scoring expenditure sisters critics connectivity spots
algorithms hacker similarly margin coin solely fake salon collaborative excluding turbo headed voters cure
commander arch thinks thats suggestion soldier asin aimed bomb harm interval mirrors spotlight tricks reset
brush investigate thy expansys panels repeated assault connecting spare logistics deer tongue bowling tri
danish pal monkey proportion filename skirt invest honey analyzes drawings significance scenario lovers atomic
approx symposium gauge essentials junction protecting faced mat solving transmitted weekends screenshots
produces oven ted intensive chains sixth engage deviant noon switching quoted adapters correspondence farms
imports supervision cheat bronze expenditures sandy separation testimony suspect celebrities macro sender
mandatory boundaries crucial syndication gym celebration kde adjacent filtering tuition spouse exotic viewer
signup threats puzzles reaching damaged cams receptor laugh surgical destroy citation pitch autos premises
proved offensive imperial dozen deployment teeth cloth studying colleagues stamp lotus salmon separated proc
cargo tan directive mate starter upgrades likes butter pepper weapon luggage burden chef tapes zones races
isle stylish slim maple grocery offshore governing retailers depot comp alt pie blend occasionally attending
emission spec finest realty bow recruiting apparent instructional phpbb autumn traveling probe midi
permissions biotechnology toilet ranked jackets routes packed excited outreach mounting recover tied balanced
prescribed timely talked debug delayed chuck reproduced hon dale explicit calculation ebook consolidated
exclude peeing occasions equations newton oils exceptional anxiety bingo whilst spatial respondents unto
ceramic prompt precious minds annually considerations scanners pays fingers sunny ebooks delivers necklace
musicians composite unavailable cedar arranged theaters advocacy stud fold essentially designing threaded
qualify hopes assessments cms mason diagram pumps footwear peoples victor pos attach licenses utils removing
advised spider phys ranges pairs sensitivity trails preservation isolated interim assisted divine streaming
approve chose compound intensity technological syndicate abortion dialog venues blast wellness calcium
antivirus addressing pole discounted indians shield harvest membrane previews constitute locally concluded
pickup desperate mothers demonstration governmental manufactured candles graduation mega bend sailing
variations moms sacred addiction morocco chrome refused brake exterior greeting ecology glen nav delays
synthesis olive undefined unemployment cyber scored enhancement clone velocity lambda relay composed tears
performances oasis baseline cab angry societies silicon identical petroleum compete ist lover belong lips
retention exchanges pond rolls soundtrack wondering daddy ferry rabbit profession seating dam separately
physiology lil collecting das exports tire participant scholarships recreational chad electron loads
friendship heather passport motel unions treasury warrant sys solaris frozen occupied josh royalty scales
rally observer sunshine strain drag ceremony somehow arrested expanding provincial investigations icq ripe
rely medications gained dying laundry stuck placing stops homework adjust assessed advertiser enabling
encryption filling downloadable sophisticated imposed silence focuses soviet possession laboratories treaty
vocal trainer organ stronger volumes advances vegetables lemon toxic dns thumbnails darkness pty nuts nail
bizrate implied span sox stockings joke respondent packing statute rejected satisfy destroyed shelter chapel
gamespot manufacture layers guided vulnerability accountability celebrate accredited appliance compressed
mixture bench univ tub rider scheduling radius perspectives mortality logging christians borders therapeutic
pads butts inns bobby impressive sheep accordingly architect railroad lectures challenging wines nursery
harder cups ash microwave cheapest accidents travesti relocation contributors salad tender violations foam
temperatures paste clouds competitions discretion tft preserve jvc poem unsigned staying cosmetics theories
repository praise concentrations veteran streams landing signing executed negotiations realistic showcase
integral asks relax generating congressional synopsis hardly prairie composer bean sword absent photographic
sells hoping accessed spirits modifications coral pixel float bias imported paths bubble por acquire contrary
millennium tribune vessel acids focusing viruses cheaper admitted dairy admit mem fancy equality achieving tap
stickers fisheries exceptions reactions leasing beliefs macromedia companion squad analyze scroll relate
divisions swim wages additionally suffer forests fellowship nano invalid concerts martial males retain execute
tunnel genres patents copyrights chaos wheat obtaining beaver updating distribute readings decorative kijiji
confused compiler enlargement eagles bases vii accused bee campaigns unity loud conjunction bride rats defines
airports instances indigenous begun cfr brunette packets anchor socks validation parade corruption stat
trigger incentives cholesterol gathered notified differential beaches folders dramatic surfaces terrible
routers pendant dresses baptist scientist starsmerchant hiring clocks arthritis females nevertheless reflects
taxation fever pmc cuisine surely practitioners transcript theorem inflation thee pray stylus compounds pope
drums contracting structured reasonably jeep chicks bare hung cattle radical graduates rover recommends
controlling treasure reload distributors flame tanks assuming monetary elderly pit mono particles floating
extraordinary tile indicating spell hottest coordinate exclusively alleged limitation widescreen compile
struck illustration warnings construct apps inquiries bridal annex mag gsm inspiration tribal curious
affecting freight rebate meetup eclipse ddr downloading rec shuttle aggregate stunning cycles affects
forecasts detect actively ciao ampland knee prep complicated chem fastest butler shopzilla injured decorating
payroll cookbook expressions ton courier uploaded hints collapse americas connectors unlikely pros conflicts
techno beverage tribute wired immune travelers forestry barriers cant rarely gpl infected offerings genesis
barrier argue incorrect trains metals bicycle furnishings letting arise thereby particle perception minerals
advise humidity bottles boxing renaissance pathology bra ordinance photographers infections chess operates
configured survive festivals menus possibilities duck reveal canal amino phi contributing herbs clinics mls
cow analytical missions lying costumes strict dive circulation drill offense cet protest assumption hobby
tries transexuales invention nickname technician inline executives enquiries washing staffing cognitive
exploring trick enquiry closure raid ppc timber volt intense div playlist registrar showers supporters ruling
steady dirt statutes withdrawal drops predicted wider cancellation plugins enrolled sensors screw ministers
publicly hourly blame freebsd veterinary acer prostores reseller dist handed suffered intake informal
relevance incentive butterfly mechanics heavily swingers fifty headers mistakes numerical ons geek uncle
defining counting reflection sink accompanied assure invitation devoted sodium randy spirituality hormone
meanwhile proprietary timothy childrens brick grip naval thumbzilla medieval porcelain pichunter captured watt
thehun decent casting translated shortly columnists pins andreas warrior diploma cabin innocent scanning
consensus polo copying rpg delivering cordless horn fired journalism prot trivia frog grammar intention
disagree tires logs undertaken tgp hazard retro statewide semiconductor episodes boolean circular anger diy
mainland illustrations suits chances interact snap happiness arg substantially bizarre fruits identifier
ribbon calculations doe conducting startup ati kissing wal handy swap exempt crops reduces accomplished
calculators geometry impression abs flip guild correlation gorgeous capitol sim dishes nervous refuse extends
fragrance replica plumbing tribe neighbors trades superb buzz transparent nuke rid trinity handled legends
boom calm champions floors selections projectors inappropriate exhaust comparing shanghai speaks vocational
copied farming pharmacies fork troy roller introducing batch organize appreciated alter edges mixing handles
skilled fitted harmony distinguished asthma projected assumptions shareholders twins developmental rip zope
regulated triangle amend anticipated oriental reward completing gmbh buf hydrogen webshots sprint comparable
chick advocate confusion copyrighted tray inputs warranties genome documented thong medal paperbacks coaches
vessels walks sol keyboards sage knives vulnerable arrange artistic bat honors booth indie reflected unified
bones breed detector ignored polar fallen precise respiratory notifications msgid transexual mainstream
invoice evaluating lip subcommittee sap gather maternity backed colonial motels forming embassy cave
journalists rebecca slight proceeds indirect amongst wool foundations msgstr arrest volleyball adipex horizon
deeply toolbox ict marina liabilities prizes browsers decreased patio tolerance surfing creativity describing
optics pursue lightning overcome eyed quotations grab inspector attract beans bookmarks disable snake succeed
lending oops reminder searched behavioral riverside bathrooms plains sku insights abilities initiated karaoke
trap lonely fool nonprofit suspended hereby observe containers attitudes berry collar simultaneously racial
integrate sociology mobiles screenshot exhibitions kelkoo confident retrieved exhibits officially consortium
dies terrace bacteria pts replied seafood novels rrp recipients ought delicious traditions jail safely finite
kidney periodically fixes sends durable allied throws moisture roster referring symantec ooo transform timer
tablets tuning gotten educators futures vegetable verse highs humanities independently wanting custody scratch
launches ipaq alignment comm competitors nhs rocket aye bullet towers racks lace nasty visibility latitude
consciousness tumor ugly deposits mistress encounter trustees reprints hart resolutions ment accessing forty
tubes attempted col midlands priest analysts queue trance locale biol bundle hammer invasion witnesses runner
rows administered notion skins mailed spelling arctic exams rewards beneath strengthen defend medicaid treo
infrared seventh gods une welsh belly aggressive advertisements quarters stolen sublimedirectory soonest
disturbed determines sculpture poly ears fist naturals motivation lenders pharmacology fitting fixtures
bloggers mere agrees passengers quantities petersburg consistently cons surplus elder sonic obituaries cheers
dig taxi punishment appreciation subsequently zoning gravity providence thumb restriction incorporate
backgrounds treasurer guitars essence flooring lightweight mighty athletes humanity transcription
complications scholars dpi scripting gis remembered galaxy snapshot caring loc worn synthetic segments
testament expo dominant twist specifics itunes stomach partially buried newbie minimize ranks wilderness debut
generations tournaments deny anatomy sponsorship headphones fraction trio proceeding cube defects uncertainty
breakdown marker subsidiary strengths clarity rugs encouraging furnished settled folding emirates terrorists
airfare comparisons beneficial distributions vaccine fate viewpicture promised penny robust bookings
threatened republicans discusses porter gras jungle ver responded rim abstracts ivory alpine dis prediction
pharmaceuticals andale fabulous remix alias thesaurus individually battlefield literally newer ecological
spice oval implies soma ser cooler appraisal consisting maritime periodic submitting overhead prospect
shipment breeding citations geographical donor tension href trash shapes tier fwd earl manor envelope homeland
disclaimers championships excluded breeds rapids disco bailey aus endif finishing emotions wellington incoming
prospects lexmark cleaners hwy eternal cashiers cite aboriginal remarkable rotation preventing productive
boulevard pig metric compliant minus penalties imagination hotmail refurbished varied grande closest activated
actress mess conferencing assign politicians trackbacks lit accommodate tigers aurora una slides premiere
lender villages shade chorus rhythm digit argued dietary symphony sudden accepting precipitation lions findlaw
pools lyric isolation speeds sustained matched approximate rope rational programmer fighters dump greetings
inherited warming incomplete vocals chronicle fountain chubby grave legitimate biographies burner yrs foo
investigator gba plaintiff gentle prisoners deeper muslims hose nightlife footage howto worthy reveals
architects saints entrepreneur carries sig freelance duo excessive screensaver saves regarded valuation
unexpected cigarette fog characteristic lobby outlined consequently headline treating punch appointments str
gotta cowboy narrative enormous karma consist academics pubs quantitative screensavers subdivision tribes
defeat clicks distinction naughty hazards insured livestock mardi exemption tenant sustainability cabinets
tattoo shake algebra shadows holly formatting silly nutritional yea mercy freely sunrise wrapping mild fur
weblogs timeline tar belongs readily affiliation soc fence nudist infinite ensures relatives clan legally
shame satisfactory revolutionary bracelets sync civilian telephony mesa fatal remedy realtors breathing
briefly thickness adjustments graphical genius discussing aerospace fighter meaningful flesh retreat adapted
barely wherever estates rug democrat borough maintains failing shortcuts retained voyeurweb marble extending
specifies hull logitech surrey briefing belkin accreditation wav blackberry highland meditation modular
microphone combining instrumental giants organizing shed balloon moderators memo ham solved tide standings
partition invisible gratuit consoles funk magnet translations jaguar reel sheer commodity posing kilometers
bind thanksgiving rand urgent guarantees infants cylinder witch buck indication congratulations sie usgs puppy
acre graphs surround cigarettes revenge expires enemies lows controllers aqua consultancy finances accepts
enjoying conventions patrol smell pest italiano coordinates carnival roughly sticker promises responding reef
physically divide stakeholders hydrocodone gst consecutive satin bon deserve attempting mailto promo
representations worried tunes garbage competing combines mas phrases kai peninsula boring dom accurately
speeches reaches schema considers sofa catalogs ministries vacancies quizzes parliamentary obj prefix barrel
typing nerve dans planets deficit boulder pointing renew coupled viii metadata circuits floppy texture
handbags jar somerset incurred acknowledge thoroughly thunder tent caution identifies questionnaire
qualification locks modelling namely miniature dept hack dare euros interstate pirates aerial hawk consequence
rebel systematic perceived origins hired makeup textile lamb presenting cos troubleshooting indexes erp
centuries magnitude fragrances vocabulary licking earthquake vpn fundraising markers weights geological
assessing lasting wicked eds introduces kills roommate webcams pushed webmasters computational acdbentity
participated junk handhelds wax answering impressed slope reggae failures poet conspiracy surname theology
nails evident whats rides rehab epic organizer nut allergy sake twisted combinations preceding merit enzyme
cumulative zshops planes tackle disks condo amplifier arbitrary prominent retrieve sans worldcat titanium
fairy builds contacted shaft lean bye recorders occasional deutsche postings innovations kitty postcards dude
drain fires blessed reviewing favors potato panic explicitly sticks leone transsexual citizenship excuse
reforms basement onion strand sandwich lawsuit alto informative girlfriend bloomberg cheque hierarchy
influenced banners reject eau abandoned circles italic beats merry mil scuba gore complement cult dash passive
valued cage checklist requesting courage lauderdale scenarios gazette divx extraction batman elevation
hearings lap utilization beverages calibration eval efficiently ping textbook dried entertaining prerequisite
frontier settle stopping refugees knights hypothesis medicines flux derby sao peaceful altered regression
doctrine scenic trainers muze enhancements renewable intersection passwords sewing consistency collectors
conclude celebs gmc propose lighter rage adsl prix astrology advisors pavilion tactics trusts occurring
supplemental travelling talented pillow induction precisely shorter spreading provinces relying finals steal
parcel refined fifteen widespread incidence fears predict boutique acrylic rolled tuner incidents rays asn
toddler enhancing flavor alike homeless horrible hungry metallic acne blocked interference warriors listprice
libs undo atmospheric sagem knowledgestorm halo ppm parental referenced strikes lesser publicity marathon ant
proposition gays pressing gasoline apt dressed scout exec dealt inf eos warcraft charms catalyst trader bucks
allowance denial uri designation thrown prepaid raises gem duplicate electro criterion badge wrist
civilization analyzed heath tremendous ballot varying remedies validity trustee weighted performs plastics
realm corrected jenny helmet salaries postcard elephant encountered tsunami scholar nickel internationally
surrounded psi buses expedia geology pct creatures coating commented wallet cleared smilies vids accomplish
boating drainage shakira corners broader vegetarian rouge yeast qld pas clearing investigated ambassador
coated intend contacting vegetation doom findarticles specially routines hitting beings bite issn aquatic
reliance habits striking myth infectious podcasts gig sas continuity brook outputs phenomenon ensemble insulin
assured biblical weed conscious accent mysimon eleven wives ambient utilize mileage oecd prostate adaptor
auburn unlock pledge vampire relates nitrogen xerox dice merger softball referrals quad dock differently
firewire mods nextel framing musician blocking sorts integrating vsnet limiting dispatch revisions papua
restored hint armor riders chargers remark dozens varies msie reasoning rendered picking charitable guards
annotated ccd convinced openings buys replacing researcher watershed councils occupations acknowledged pockets
granny pork equilibrium viral inquire pipes characterized laden cottages merge privilege develops qualifying
chassis estimation barn pushing llp fleece pediatric boc fare asus pierce dressing techrepublic sperm bald
filme craps frost institutes mold dame sally yacht prefers drilling brochures herb tmp alot ate breach whale
traveller appropriations suspected tomatoes benchmark beginners instructors highlighted bedford stationery
idle mustang unauthorized clusters antibody competent momentum fin wiring pastor mud uni shark contributor
demonstrates phases grateful emerald gradually laughing grows cliff desirable tract ballet journalist bumper
afterwards webpage religions garlic hostels shine explosion banned briefs signatures diffs cove ozone
disciplines casa daughters conversations radios tariff opponent pasta simplified muscles serum wrapped swift
motherboard runtime inbox focal bibliographic distant incl champagne decimal deviation superintendent propecia
dip samba hostel housewives employ penguin magical influences inspections irrigation miracle manually reprint
hydraulic centered flex yearly penetration wound belle conviction hash omissions writings hamburg lazy mpg
retrieval qualities fathers carb charging cas marvel lined cio prototype importantly petite apparatus terrain
pens explaining yen strips gossip rangers nomination empirical rotary worm dependence discrete beginner boxed
lid sexuality polyester cubic deaf commitments suggesting sapphire kinase skirts mats remainder labeled
privileges televisions specializing marking commodities sheriff griffin declined spies blah mime neighbor
motorcycles elect highways thinkpad concentrate intimate reproductive deadly feof bunny molecules rounds
longest refrigerator tions intervals sentences dentists exclusion workstation holocaust keen flyer peas dosage
receivers urls disposition variance navigator investigators baking marijuana adaptive computed needle baths
enb cathedral brakes nirvana owns til invision sticky destiny generous madness climb blowing fascinating
landscapes heated computation hay cardiovascular sparc cardiac salvation predictions accompanying brutal
learners selective arbitration configuring token editorials zinc sacrifice seekers guru isa removable
convergence yields levy suited numeric anthropology skating kinda emperor grad malpractice bras belts blacks
educated rebates reporters proudly pix necessity rendering mic inserted pulling basename obesity curves
suburban touring vertex hepatitis nationally tomato waterproof expired travels flush waiver pale specialties
humanitarian invitations functioning delight survivor cingular economies bacterial counted undertake declare
continuously valves gaps impaired achievements donors tear jewel teddy convertible ata teaches ventures nil
bufing stranger tragedy nest dryer painful velvet tribunal ruled pensions prayers funky secretariat nowhere
cop paragraphs gale joins adolescent nominations dim lately cancelled scary mattress mpegs likewise banana
introductory cakes reservoir occurrence idol mixer remind sbjct demographic charming tooth disciplinary
annoying respected stays disclose affair drove washer upset restrict springer beside mines portraits rebound
mentor interpreted evaluations fought elimination metres hypothetical immigrants complimentary helicopter
pencil freeze performer abu titled commissions sphere powerseller moss ratios concord graduated endorsed
surprising walnut lance ladder italia unnecessary dramatically cork maximize senators workout bleeding
characterization colon likelihood lanes purse fundamentals contamination endangered compromise optimize
stating dome leu expiration namespace align peripheral bless engaging negotiation crest opponents triumph
nominated confidentiality electoral changelog welding deferred alternatively heel alloy condos plots polished
yang gently locking controversial draws fridge blanket bloom recovered justify upgrading blades loops surge
frontpage trauma advert possess demanding defensive sip flashers forbidden vanilla programmers monitored
installations deutschland picnic souls arrivals spank practitioner motivated dumb hollow vault securely
examining fioricet groove revelation pursuit delegation wires dictionaries mails backing greenhouse sleeps
transparency endless figured orbit currencies bacon survivors positioning heater colony cannon circus promoted
descending paxil spine trout enclosed feat temporarily ntsc cooked thriller transmit apnic fatty pressed
frequencies scanned reflections hunger mariah sic municipality detective surgeon cement experiencing fireplace
endorsement planners disputes textiles missile intranet closes seq psychiatry persistent conf assists
summaries glow auditor wma aquarium violin prophet cir bracket looksmart oxide oaks magnificent colleague
promptly modems adaptation harmful paintball sexually enclosure acm dividend paso glucose phantom norm
playback supervisors turtle ips distances absorption treasures dsc warned neural ware fossil hometown badly
transcripts wan disappointed continually communist collectible handmade entrepreneurs robots creations jade
scoop acquisitions foul keno gtk earning mailman sanyo nested biodiversity excitement movers verbal blink
presently seas workflow mysterious novelty tiles voyuer librarian subsidiaries switched garmin pose fuzzy
grams therapist mrna budgets toolkit promising relaxation goat render sen thereafter hardwood erotica temporal
sail forge commissioners dense dts brave forwarding awful nightmare airplane reductions impose organisms
telescope viewers asbestos cdna enters pod savage advancement harassment willow resumes bolt throwing existed
generators wagon barbie soa knock urge smtp generates potatoes thorough replication inexpensive receptors
peers optimum neon interventions quilt creature ours mounts internship lone refresh aluminium snowboard
beastality webcast evanescence subtle coordinated notre shipments stripes firmware cope shepherd cradle
chancellor mambo lime flour controversy legendary bool sympathy choir avoiding beautifully blond expects cho
jumping fabrics antibodies polymer hygiene wit poultry virtue burst examinations surgeons bouquet immunology
promotes mandate departmental spas ind corpus terminology gentleman fibre reproduce convicted shades jets
indices roommates adware qui intl threatening spokesman activists prisoner daisy encourages ultram cursor
assembled earliest donated stuffed restructuring insects terminals crude maiden simulations sufficiently
examines viking myrtle bored cleanup yarn knit conditional mug crossword bother conceptual knitting attacked
mating compute redhead arrives translator automobiles tractor continent unwrap fares longitude resist
challenged telecharger hoped pike safer insertion instrumentation ids constraint groundwater touched
strengthening cologne gzip wishing ranger smallest insulation marsh ctrl scared theta infringement bent
subjective monsters asylum lightbox stake cocktail outlets varieties arbor mediawiki configurations poison
abandon abbrev abbreviate abort abstraction absurd abut accidental accounted accrual accumulate accumulation
achievable acknowledgment acme acronym actionable activate adapt adder additive addressable adj adjacency
adjudicate adjudication adjudicator admissible adversarial adversary affirm affirmation affirmative
afterthought afterward aggregation aggregator agnostic agonizing agreeing alarming algorithmic aligned
allergic allocate allocations almanac alongside aloud alphanumeric alternation altogether ambiguity ambiguous
ambition ambitious amnesia amnesiac amortization amortize ample amplify analyses ancestor annotate anomalous
anomaly anon answerable antecedent anticipate apology append applier approvals approving approximation
arbitrarily arguably aria arithmetic arr articulate artifact asleep assemble assert assertion assertions assoc
asterisk asymmetric asymmetry asymptotic atomically attacker attendee attentive attestation attested
attributed attribution authenticate authenticated authenticity authoritative authorize autonomous autonomy
avail avoidance await awake awkward backbone backdate backdrop backlog backslash backstop backward bail bait
bake baked bakery bash bead bearer beating bedrock behave believing belonging benign biased bidirectional
bimodal biscuit bistro blacklist bleed blew blinding blindness blip bloat blob blocker blown blueprint blunt
blur blurb boarding bogus boiler boilerplate bookkeeping bootstrap bootstrapping bop borderline borrow bot
bottleneck bounce brace brainstorm brainstorming bravo breadcrumb breadth breakage breaker brew brightness
brittle brittleness broadcaster brokerage brute bucket bugging buggy buildup builtin bump bust bypass cadence
calibrate callable callback caller calorie canary canine canned cannot canonical capitalization capped caption
cardiologist carve cascade casing cask catastrophic causal cautious caveat cert certainty certify changeable
characterize chatter chattiness chatty checker chimney chore chronological chunk churn cilantro circularity
circumstance clamp clarification classifications classifier classify cleanly cleverness clipboard clipped
clobber closet clue clumsy clutter coalesce coarse codify coexist coherent cohort coincidental collide
collision comfortably comma committing commute compaction compactor comparability compassionate competency
competitor complain complementary completeness compose compositional compressible concatenate concatenation
concise conclusive concurrency confined confinement confuse confusing congestion consolidate consolidator
constrained constructor consume consumed containment contaminate contaminated contention contested contiguity
contiguous contingent continuation contradict contradiction contradictory convergent conversational corollary
corpora correctness correlate correlated correspondent corroborated corroboration corrupt cosine costly
counterpart coupling cousin credential credible creep critic criticality crowded crumb cue cum cur curate
curiosity curl curly cutoff cyan daemon damn dangle dashboard dataset daylight daytime dearest debit decay
decidable decisive declarative decoration decoy defeated defect defended defensible deferral deferring
definite definitive deflection deg degenerate degrade delegate deli deliberate demonstrably demote dentist
departed dependency deploy deprecation derivation derivative derive descendant descriptor deserved destructive
detach determinism deterministic deterministically diagnose diagnostics dict dictate dictation digging dilute
diluted dine diner directional directness disambiguate disclosed disconnected discrepancy discretionary
discriminate discriminating discriminator dispatcher disposable disposed disputed distillation distinctive
distinctiveness distinguish distinguishable disturb divergence dominance dominate dotted doubly downgrade
downsize downstream downtime drafter drafting drift drip dropping drown drowning dug dummy dupe duplication
durability durably dwell easing eaten echoes ecosystem editable eff egress eighth ellipsis elm embed embedding
emerge emit emitted emitter emitting emoji emptiness enc encapsulate encapsulation encode encoder endpoint
endurance enforce enforced enqueue enrich enrichment enroll enshrine enthusiasm entitlement entrant enumerable
enumerate enumeration ephemeral episodic epoch erode err errand escalate escalation escalations esp espresso
estimator ethanol evaluator evaporate evict eviction exactness exceeding excl exclamation excursion executor
exhaustion exhaustive exotica expectation expire expiry explanatory exploit explored exponential expose
extractor eyebrow fable fabricate facade facet factoid factual fade faithful fallback falsify fanned fanning
fest fetch fetcher fetching fidelity filer filler filtered finale finalization fingerprint fixer fixture
flagged flagging flagship flake flaky flap flapping flatter flavored flea flicker flipped flipping flock fluff
fluke footing footprint forbade forbid foreground forensic forgery forgetting forgiven formatted fortnight
foundational foxtrot fractional frag fragment freeing freq freshen freshness friction froze fulfill fuller
fuse gazetteer generalize generically gesture gibberish gist git glob gloss glue glued glyph goo gov govern
governed graceful gradient granular granularity graveyard greedy greet greeter grep grepped grepping grinder
grooming grounding grouping guaranteeing guarded guardrail guesswork guilt gut gutter habit habitual haiku
hairpin hale hallucinate hallucination hallway halve hamburger handful handler handout handover handshake
handwriting happily haptic hardened harmless harness harvested harvester hatch haystack headless headliner
headroom heal healed heap heartbeat hedge hell helper hermetic hesitant hesitate hesitation heuristic
heuristics hex hiccup hid hiding hierarchical hindsight histogram hitch hoc holistic holistically
homogenization honesty hopeless hostage hostile housekeeping hover hum hummus hunch hunk hush hydrate
hydration hyphen hypotheses hysteresis iceberg idempotent identifiable idiom ignorance illusion illustrate
illustrative imminent immutable imp imperative impersonate impersonation implementable implicit impress
improvise impure inaccuracy inbound incidental increment incremental indentation indexer inert inference
inferred inferring inflate infra ingest ingestion ingress inherent inherit inheritance inhibition initialize
initialized initiate inject insensitive inspect inst instructive insurer intact intentional interchangeable
intermittent interpolate interpret interpreter interrupt interruption intersect intrinsic intruder intuition
invariant invent inverse invert invitee invoke ios iphone irreducible irrelevant irreplaceable irreversible
irritating isolate issuer italics iterate iteration itinerary jammed jargon justification justified kaboom
kebab keeper kelvin kinship knob lag lagging lakeside landmark lapse latch latency latent lateral lattice
launcher layered layering lazily leak leaky leaning leash ledger leftover legible legit lettered lever
leverage lexical lexicon lied lightly liking lineage liner linger lingering lint lints listener literal
litigate loader locality lockout lockstep loft logger logout loosely lore loser lossless lowercase loyalty
magenta mailbox malformation malformed manifest mapped marginal markdown markup maxima meaningless meantime
measurable measurably mediocre megabyte megastar meh midday migrate milestone millisecond mindset
misclassified misdiagnose misfire mislabel misleading misled mismatch misread misreading misreport mistaken
mitochondrial mock modest modulo momentarily monolith monotonic moonshot multipart multiplicand multiplicative
multiplier mutate mutation mute nag nagging nah naive naked nameless narrate narration narrator navigable
needless neg negligible negotiable negotiator neigh netted newline noisy nominal nominate nonce nonexistent
nonsense nontrivial nonzero noodle nope normalization normalize notable notably notifier notional nuance nudge
numbered numerator obey objection obsolete occupy octal octet offender offload offsite omission omit omitted
oneself onward ooh opacity opaque operative opportunistically optimistically opus orchestrate orchestration
orderings orient orig orphan orthogonal outage outbound outbox outdated outermost outgrown outing outlast
outlier outlive outrank outright outscore outvote overage overdue overflow overlap overlapping overlay
overlong overly overpass overridden override overrode overrule overrun overshot oversight oversize overspend
overtaken overturn overwhelm overwhelming overwrite overwritten overwrote owe padding pager paired pairing
pane panes paperwork paraphrase parenthetical parity parody parse partway pastry paternalistic pathological
pause payload payoff payout pedantic pend perennial perishable permissive perpetual persist persistence
persuaded perturb phish phrasing picker piggyback pile piling pinned pinning piping pivot pizzeria placeholder
plaid plausible plausibly playbook plentiful plugged plumber pointless poisoning polite polling pollute
polluted popped populate populated popup positional positioned postcode postdate posture pow ppr preamble
precede precedence precedent precondition predate predecessor predicate predictable preempt pref preferring
premise prepend preventive pricey primer primitive principled prioritization prioritize privileged
probabilistic probable procedural prod programmatic progression promiscuity promiscuous prompted prone
propagate propagation proportional prose proton prototypical provably provenance provisional provoke proximity
prune pruner pseudo punctuation pusher qualifier qualitative quantization quarantine questioned quot quota rag
ragged ramp rarity rationale rcpt reachable react readability realization reap reasoner reassuring rebuild
recap recon reconcile reconciliation reconstructed recourse recoverable recur recurred recurrence recurring
recursion redact redaction redirection redo redundancy redundant referent refill refinement reflective
reflexive refractory refreshing refusal refute regenerate regex regexp rehearsal reinforcement reinstatement
rejection rel relational reliably relocate rem renovation reopen repairer repeatable repeating repetition
repetitive resend resetting residual residue resilience resp responsive responsiveness restate restrictive
resurrect retriever retrofitted retrospective reversibility reversible revert revertible revive revoke rewrite
ridiculous rig risky robotic rode rogue rollback rollover rooftop rot rotate roundup rubric rude runaway rung
rust salience salient salvage sampler sanctioned sandbox sane sanitize sanity satisfying saturate saturation
scaffolding scalar scam scar scheduler scorecard scrape scraper scripted scrub scrubbed scrutiny seam
searchable sectioned secular seeded selector semantic semantically semantics semaphore semicolon sensible
sentiment sentinel separator sequential serendipity serialization serialize serif serviceable servicing
seventy severity shallow shapeless shareable sharpen sharper shebang shellfish shortcut shorten shortfall
shorthand showtime shrank shred shrink shrug shrunk shutdown shutting sibling sidecar sideways sighting signer
silo similarity simplification simplify simulate simulator simultaneous singalong singleton sitter situational
sizing sketch skew skipped skipping slack slash slat slate slept slice slid slipped slipping sliver slog slug
slugging slurp smuggle snack snapped sneaky snip snipped snippet snipping snips snooze sock soften solicited
sonnet sounding sourdough spacing spammed spammer spanning spark sparse spawn specificity speculation
speculative speedup spike spill spinning splice splitting spoof spool spotting spreadsheet spun spurious
squash ssh staging stale staleness stall standalone standout starred starve stash stateless statically
stationary statistic stdio steadily stitching storefront storytelling straddle straggler stray streak stride
stripped stripper stub stubbed stylistic subj subset subsidy substantive substitution substrate subsystem
subtitle subtract subtraction suburb succession successive successor suffix suggestive summarize summed
summing sunk sup supersede supervised suppress suppression surpass surrogate suspicion suspicious swallow
swapped swapping swarm sweep swept swung sycophancy symmetric symptom synchronous synonym syntactic systemic
tabular tactical tagging takeout tally tamed tamper tapas tapped tapping tarball tautology taxonomy telemetry
tempting tense tenth tenure ternary terse testable texted textual thinnest thoughtful thrash threaten threw
throttle throughput throwaway thrower tick ticker ticking tidy tiebreak tiebreaker tiff tighten tilde timeout
timescale timestamp timezone toggle tolerant tolerate topical topped torn tot touching tracing transactional
transient transitive traversal traverse treadmill triage trimmed trimming triplet tripped tripping tripwire
trivial truncate truncation trusting trustworthy truthful truthfulness tuple tweak twelfth twitchy tying typo
ultramarine umbrella unanimous unbroken unclear uncommon unconditional underline underneath underscore
unfamiliar unguarded unhealthy unicorn unification uninformative uninteresting uninterrupted uniqueness
unlucky unofficial unpin unread unrelated unreported unsafe unseen unset unspecific unsure untrue upkeep
uppercase upstream uptown upward urgency usable useless utterance vaccination vague valence validate vanish
variant verb verbatim verbose verdict verifiable versa vesting vet veto vetoes vetted viable violate visibly
visualization vitals vocab vouch wander warmth warn warranted wasteful watchdog watcher watermark weaken weave
wedge weekday weigh weighs whatsoever whichever whiteboard whitelist whoever widen widths wildcard wipe
withdraw withdrawn withdrew withheld withhold withholding wobble woke wording wordy workable workaround
workday workload workspace worthless wrangler wrapper writ wrongness xxx yep yup zeroes zombie
`;
