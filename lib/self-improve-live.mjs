// self-improve-live — after an owner-approved card is written and committed,
// make its change RUN, and check that it does. Used by
// bin/self-improve-approval-poll; `applied` (the green check in the app) is
// only reported when this says ok.
//
// Why. Written and committed is not the same as working. On 2026-11-15 the
// owner approved the Shows seen card; it was written, committed, marked
// `applied` and announced as "now live" while the new plugin was still off (a
// plugin not listed in the plugin state follows its manifest's default) and its
// schedules had never reached the crontab: crontab-safe's 20 s default was
// shorter than a full install on the production host. Nothing ran until it was
// noticed by hand an hour later.
//
// What it does:
//   - a plugin the card adds or changes is turned on (the owner's Face ID on the
//     card is the yes; a plugin the owner turned off on purpose stays off, and
//     the notes say so), synced, then re-planned: any schedule or launchd agent
//     still missing means NOT live;
//   - the test files the card ships are run; a failure means NOT live, unless
//     every failing test was already failing without the card (the baseline
//     below): then it is a note, not the card's fault.
// Not live → the poller records the row as `apply_failed` with
// result.not_live (orange in the app, Retry offered) and says the code is in
// but not running, and why. A retry re-applies (same content, "nothing to
// commit") and runs this again.
//
// Baseline (2026-11-15). A failing test does not prove the card broke it. When
// tests fail, the same test files are run once more in a throwaway tree: HEAD of
// the kernel and the overlay (git archive), with each file the card wrote put
// back to its content just before the card's commit (found by its commit
// message). A test failing there too, by the same file and name, was broken
// already. Only failures new with the card count. No baseline (no commit
// found, archive failed, run timed out) → every failure counts, as before.
//
// Never throws.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const exec = promisify(execFile);

const TEST_FILE = /(^|\/)tests\/[^/]+\.test\.(mjs|cjs|js)$/; // lang-regex-ok: file paths
const PLUGIN_PATH = /^(?:agent\/local\/)?plugins\/([a-z0-9][a-z0-9-]*)\//; // lang-regex-ok: file paths

/** Plugin names a set of repo-relative paths touches. */
export function pluginsTouched(rels) {
  return [...new Set((rels || []).map((r) => (String(r).match(PLUGIN_PATH) || [])[1]).filter(Boolean))];
}

/** Test files among the paths (only those that exist under root). */
export function testsShipped(rels, root) {
  return (rels || []).filter((r) => TEST_FILE.test(String(r)) && fs.existsSync(path.join(root, r)));
}

// The environment the shipped tests run in. The poller runs from cron, whose
// PATH is /usr/bin:/bin: no node on it. A test that spawns one of our own
// `#!/usr/bin/env node` scripts (bin/decision-answer, through
// lib/choice-reply.mjs) then fails here and passes in every shell. On
// 2026-11-15 that failed the Shows seen card ("its tests fail.") on approval
// and again on every Retry, while the change itself was running fine. Put the
// node running this check first on PATH, as it is in any shell.
export function testEnv(base = process.env, execPath = process.execPath) {
  const nodeDir = path.dirname(execPath);
  const rest = String(base.PATH || "/usr/bin:/bin").split(":").filter((d) => d && d !== nodeDir);
  const env = { ...base, PATH: [nodeDir, ...rest].join(":") };
  // Set when this itself runs under `node --test`; a child that inherits it
  // reports to that parent instead of exiting non-zero on a failure.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Failing tests from TAP output: [{name, file, why}]. `file` is the test file
 * relative to `root` (from the YAML `location`), `why` the first line of its
 * error; either may be "".
 */
export function tapFailures(out, root = "") {
  const lines = String(out || "").split("\n"), failed = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*not ok \d+ - (.+)$/); // lang-regex-ok: TAP output
    if (!m) continue;
    let why = "", file = "";
    for (let j = i + 1; j < Math.min(lines.length, i + 60) && !/^\s*(not )?ok \d+ /.test(lines[j]); j++) { // lang-regex-ok: TAP output
      const loc = lines[j].match(/^\s*location: '?(.+?):\d+:\d+'?$/); // lang-regex-ok: TAP yaml
      if (loc && !file) {
        file = relTo(root, loc[1].replace(/^file:\/\//, ""));
        continue;
      }
      const e = !why && lines[j].match(/^\s*error: (.+)$/); // lang-regex-ok: TAP yaml
      if (!e) continue;
      why = e[1].replace(/^['"|>-]+\s*/, "").replace(/['"]$/, "").trim() || (lines[j + 1] || "").trim();
    }
    failed.push({ name: m[1].trim(), file, why: why.slice(0, 120) });
  }
  return failed;
}

// A path relative to root, also when one side is the /private/var real path of
// a /var temp dir (macOS). Outside root → as given.
function relTo(root, abs) {
  if (!root) return abs;
  let real = root;
  try { real = fs.realpathSync(root); } catch {}
  for (const r of [root, real]) { const rel = path.relative(r, abs); if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel; }
  return abs;
}

/** "name (first error line)" for a failure, as the notice and the card show it. */
export const failureLabel = (f) => (f.why ? `${f.name} (${f.why})` : f.name);
const failureKey = (f) => `${f.file || ""}::${f.name}`;

export async function defaultRunTests(files, root) {
  try {
    // tap, not the default reporter: Node's default off a terminal is spec,
    // which has no "not ok" lines, so the notice could not name what failed.
    await exec(process.execPath, ["--test", "--test-reporter=tap", ...files],
      { cwd: root, timeout: 600_000, maxBuffer: 16 << 20, env: testEnv() });
    return { ok: true };
  } catch (e) {
    return { ok: false, timedOut: !!e.killed, failures: tapFailures(`${e.stdout || ""}\n${e.stderr || ""}`, root) };
  }
}

// The repos whose HEAD makes up the tree: the kernel, and the private overlay
// mounted over it (bin/jori-overlay) when there is one.
function repoArgs(root) {
  return [[], ...(fs.existsSync(path.join(root, ".overlay.git")) ? [["--git-dir=.overlay.git", "--work-tree=."]] : [])];
}

/**
 * A throwaway copy of the tree without the card: HEAD of each repo, with every
 * file the card wrote put back to its content before the card's commit (removed
 * when the card created it). Returns the directory, or null when no commit with
 * `commitMsg` touched any of the files. The caller removes it.
 */
export async function buildBaseline(rels, root, commitMsg) {
  if (!commitMsg || !rels?.length) return null;
  const repos = repoArgs(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "si-baseline-"));
  try {
    for (const args of repos) {
      const tar = path.join(dir, ".head.tar");
      await exec("git", [...args, "archive", "--format=tar", "-o", tar, "HEAD"], { cwd: root, timeout: 120_000 });
      await exec("tar", ["-xf", tar, "-C", dir], { timeout: 120_000 });
      fs.rmSync(tar, { force: true });
    }
    let found = false;
    for (const rel of rels) {
      for (const args of repos) {
        let sha = "";
        try {
          sha = (await exec("git", [...args, "log", "-1", "--format=%H", "--fixed-strings", `--grep=${commitMsg}`, "--", rel], { cwd: root })).stdout.trim();
        } catch { sha = ""; }
        if (!sha) continue;
        found = true;
        const dest = path.join(dir, rel);
        try {
          const { stdout } = await exec("git", [...args, "show", `${sha}^:${rel}`], { cwd: root, encoding: "buffer", maxBuffer: 64 << 20 });
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, stdout);
        } catch { fs.rmSync(dest, { force: true }); } // the card created it
        break;
      }
    }
    if (!found) { fs.rmSync(dir, { recursive: true, force: true }); return null; }
    // Installed packages are not in git; borrow them.
    for (const d of ["", ...fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name)]) {
      const src = path.join(root, d, "node_modules"), dst = path.join(dir, d, "node_modules");
      if (fs.existsSync(src) && !fs.existsSync(dst) && fs.existsSync(path.join(dir, d || "."))) fs.symlinkSync(src, dst);
    }
    return dir;
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

/** Run `files` in the tree without the card. → {failures} or null (no baseline). */
async function defaultBaseline(files, { rels, root, commitMsg, runTests = defaultRunTests }) {
  const dir = await buildBaseline(rels, root, commitMsg);
  if (!dir) return null;
  try {
    const present = files.filter((f) => fs.existsSync(path.join(dir, f)));
    if (!present.length) return { failures: [] };
    const r = await runTests(present, dir);
    if (r.timedOut) return null;
    return { failures: r.ok ? [] : (r.failures || []) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} rels  repo-relative paths the card wrote
 * @param {{root: string, commitMsg?: string, plugins?: object, manager?: object,
 *   runTests?: Function, baseline?: Function}} o
 *   commitMsg = the card's commit message (finds the tree without it);
 *   plugins = lib/plugins.cjs, manager = lib/plugin-manager.mjs,
 *   baseline(files) → {failures} | null (test seams)
 * @returns {Promise<{ok: boolean, error?: string, notes: string[],
 *   tests_failed?: boolean, failures?: string[]}>}
 *   tests_failed/failures: set when what stops it is failing tests new with the
 *   card (the poller queues a repair for those).
 */
export async function goLive(rels, { root, commitMsg = "", plugins: P = null, manager: M = null, runTests = defaultRunTests, baseline = null } = {}) {
  const notes = [], problems = [];
  let testsFailed = null;
  baseline = baseline || ((files) => defaultBaseline(files, { rels, root, commitMsg }));
  try {
    const names = pluginsTouched(rels);
    if (names.length) {
      // crontab-safe's 20 s default is shorter than a full install on the
      // production host (~40 s for ~280 lines). Our own budget, not the default.
      if (!process.env.CRONTAB_SAFE_TIMEOUT) process.env.CRONTAB_SAFE_TIMEOUT = "120";
      try {
        P = P || createRequire(import.meta.url)(path.join(root, "lib/plugins.cjs"));
        M = M || await import(path.join(root, "lib/plugin-manager.mjs"));
      } catch (e) {
        problems.push(`could not load the plugin manager to turn ${names.join(", ")} on (${e?.message || e}).`);
        P = M = null;
      }
      for (const name of P && M ? names : []) {
        const p = P.plugin(name);
        if (!p) continue; // the card removed it
        if (p.errors?.length) { problems.push(`the ${name} plugin's manifest has errors: ${p.errors.join("; ")}.`); continue; }
        const st = P.state().enabled || {};
        if (Object.prototype.hasOwnProperty.call(st, name) && st[name] === false) {
          notes.push(`The ${name} plugin is off because you turned it off, so approving this did not turn it on.`);
          continue;
        }
        try {
          if (!P.isEnabled(name)) M.enable(name); else M.sync();
        } catch (e) {
          problems.push(`turning on the ${name} plugin failed: ${String(e?.message || e).slice(0, 300)}`);
          continue;
        }
        if (!M.syncAllowedHere()) { notes.push(`The ${name} plugin is on; its schedules are installed by the production host.`); continue; }
        let missing;
        try {
          missing = [
            ...M.planCrontab().filter((x) => x.plugin === name && x.op !== "remove" && x.op !== "untag")
              .map((x) => `${x.label}${x.problem ? ` (${x.problem})` : ""}`),
            ...M.planLaunchd().filter((x) => x.plugin === name && (x.op === "install" || x.op === "restore")).map((x) => x.label),
          ];
        } catch (e) {
          problems.push(`could not check the ${name} plugin's schedules: ${String(e?.message || e).slice(0, 200)}`);
          continue;
        }
        if (missing.length) { problems.push(`the ${name} plugin is on but not scheduled: ${missing.join(", ")} did not get installed.`); continue; }
        const n = P.schedulesOf(p).length;
        notes.push(`The ${name} plugin is on${n ? ` and its ${n} schedule${n > 1 ? "s are" : " is"} installed` : ""}.`);
      }
    }
    const tests = testsShipped(rels, root);
    if (tests.length) {
      const t = await runTests(tests, root);
      const plural = `${tests.length} file${tests.length > 1 ? "s" : ""}`;
      if (t.ok) notes.push(`Its tests pass (${plural}).`);
      else if (t.timedOut) problems.push("its tests did not finish within 10 minutes.");
      else {
        let fails = t.failures || (t.failed || []).map((name) => ({ name, file: "", why: "" }));
        let pre = [];
        const files = [...new Set(fails.map((f) => f.file).filter(Boolean))];
        if (files.length) {
          let b = null;
          try { b = await baseline(files); } catch { b = null; }
          if (b) {
            const was = new Set((b.failures || []).map(failureKey));
            pre = fails.filter((f) => f.file && was.has(failureKey(f)));
            fails = fails.filter((f) => !pre.includes(f));
          }
        }
        const list = (xs) => xs.slice(0, 3).map(failureLabel).join("; ") + (xs.length > 3 ? ` and ${xs.length - 3} more` : "");
        if (pre.length) notes.push(`${pre.length === 1 ? "One test was" : `${pre.length} tests were`} already failing before this change and still ${pre.length === 1 ? "is" : "are"}, so not counted against it: ${list(pre)}.`);
        if (fails.length || !pre.length) {
          problems.push(`its tests fail${fails.length ? `: ${list(fails)}` : ""}.`);
          testsFailed = fails.map(failureLabel);
        } else notes.push(`Its other tests pass (${plural}).`);
      }
    }
  } catch (e) {
    problems.push(`the running check itself failed: ${String(e?.message || e).slice(0, 200)}`);
  }
  if (!problems.length) return { ok: true, notes };
  // Failing tests are the only problem → the poller can queue a repair. A
  // plugin left off or unscheduled is not something a code fix repairs.
  const onlyTests = testsFailed && problems.length === 1;
  return { ok: false, error: problems.join(" "), notes, ...(onlyTests ? { tests_failed: true, failures: testsFailed } : {}) };
}
