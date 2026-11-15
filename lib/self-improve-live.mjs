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
//   - the test files the card ships are run; a failure means NOT live.
// Not live → the poller records the row as `apply_failed` with
// result.not_live (orange in the app, Retry offered) and says the code is in
// but not running, and why. A retry re-applies (same content, "nothing to
// commit") and runs this again.
//
// Never throws.

import fs from "node:fs";
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

/** Failing test names, each with the first line of its error, from TAP output. */
export function tapFailures(out) {
  const lines = String(out || "").split("\n"), failed = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*not ok \d+ - (.+)$/); // lang-regex-ok: TAP output
    if (!m) continue;
    let why = "";
    for (let j = i + 1; j < Math.min(lines.length, i + 40) && !/^\s*(not )?ok \d+ /.test(lines[j]); j++) { // lang-regex-ok: TAP output
      const e = lines[j].match(/^\s*error: (.+)$/); // lang-regex-ok: TAP yaml
      if (!e) continue;
      why = e[1].replace(/^['"|>-]+\s*/, "").replace(/['"]$/, "").trim();
      if (!why) { const nx = (lines[j + 1] || "").trim(); why = nx; }
      break;
    }
    failed.push(why ? `${m[1].trim()} (${why.slice(0, 120)})` : m[1].trim());
  }
  return failed;
}

export async function defaultRunTests(files, root) {
  try {
    // tap, not the default reporter: Node's default off a terminal is spec,
    // which has no "not ok" lines, so the notice could not name what failed.
    await exec(process.execPath, ["--test", "--test-reporter=tap", ...files],
      { cwd: root, timeout: 600_000, maxBuffer: 16 << 20, env: testEnv() });
    return { ok: true };
  } catch (e) {
    return { ok: false, timedOut: !!e.killed, failed: tapFailures(`${e.stdout || ""}\n${e.stderr || ""}`) };
  }
}

/**
 * @param {string[]} rels  repo-relative paths the card wrote
 * @param {{root: string, plugins?: object, manager?: object, runTests?: Function}} o
 *   plugins = lib/plugins.cjs, manager = lib/plugin-manager.mjs (test seams)
 * @returns {Promise<{ok: boolean, error?: string, notes: string[]}>}
 */
export async function goLive(rels, { root, plugins: P = null, manager: M = null, runTests = defaultRunTests } = {}) {
  const notes = [], problems = [];
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
      if (t.ok) notes.push(`Its tests pass (${tests.length} file${tests.length > 1 ? "s" : ""}).`);
      else problems.push(t.timedOut
        ? "its tests did not finish within 10 minutes."
        : `its tests fail${t.failed?.length ? `: ${t.failed.slice(0, 3).join("; ")}` : ""}.`);
    }
  } catch (e) {
    problems.push(`the running check itself failed: ${String(e?.message || e).slice(0, 200)}`);
  }
  return problems.length ? { ok: false, error: problems.join(" "), notes } : { ok: true, notes };
}
