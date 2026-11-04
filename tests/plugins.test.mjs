// Feature plugins (lib/plugins.cjs, lib/plugin-manager.mjs, system/plugins.md):
// discovery and validation, on/off state, dependency order, registry and
// playbook contributions, and the crontab plan — against temp dirs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-"));
const KDIR = path.join(tmp, "plugins");
const LOCAL = path.join(tmp, "local");
fs.mkdirSync(path.join(LOCAL, "config"), { recursive: true });
process.env.JORI_PLUGINS_DIR = KDIR;
process.env.JORI_LOCAL_DIR = LOCAL;
process.env.JORI_PLUGIN_ANY_HOST = "1";

function mk(name, manifest, files = {}) {
  const d = path.join(KDIR, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "plugin.json"), JSON.stringify({ name, title: name, description: `the ${name} plugin`, ...manifest }));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), body);
  }
  return d;
}

mk("alpha", { schedules: [{ label: "alpha-tick", cron: "*/15 * * * *", run: "bin/alpha --go", log: "logs/alpha.log" }], provides_bins: ["alpha"],
  jobs: { "alpha-job": { routing: { target: "ops", model: "sonnet" }, task: { description: "does alpha" } } } },
  { "bin/alpha": "#!/bin/sh\n", "jobs/alpha-job.md": "ALPHA\n" });
mk("beta", { requires: { plugins: ["alpha"] }, config: { name: "beta", schedules: true } });
mk("gamma", { default: "disabled" });
mk("broken", { schedules: [{ label: "x", cron: "* *", run: "" }] });
fs.writeFileSync(path.join(LOCAL, "config", "beta.json"), JSON.stringify({ schedules: [{ label: "beta-daily", cron: "5 9 * * *", run: "{node} bin/beta" }] }));

const P = (await import("../lib/plugins.cjs")).default;
const M = await import("../lib/plugin-manager.mjs");

test("discovery validates manifests; a broken plugin is listed with its problems and never enabled", () => {
  const all = P.plugins();
  assert.deepEqual(all.map((p) => p.name), ["alpha", "beta", "broken", "gamma"]);
  const broken = all.find((p) => p.name === "broken");
  assert.ok(broken.errors.some((e) => /five fields/.test(e)));
  assert.equal(P.isEnabled("broken"), false);
  assert.ok(P.validate({ name: "Bad Name", title: "t", description: "d" }).some((e) => /lowercase/.test(e)));
});

test("defaults, state overrides and dependency order", () => {
  assert.equal(P.isEnabled("alpha"), true);
  assert.equal(P.isEnabled("gamma"), false, "manifest default: disabled");
  assert.deepEqual(P.enabledPlugins().map((p) => p.name), ["alpha", "beta"]);
  fs.writeFileSync(P.stateFile(), JSON.stringify({ enabled: { alpha: false, gamma: true } }));
  assert.deepEqual(P.enabledPlugins().map((p) => p.name), ["gamma"], "beta drops out with its requirement off");
  fs.writeFileSync(P.stateFile(), JSON.stringify({ enabled: {} }));
});

test("an enabled plugin contributes its playbooks, routing, tasks and settings-driven schedules", () => {
  assert.equal(P.jobDirs().length, 1);
  assert.ok(P.jobDirs()[0].endsWith(path.join("alpha", "jobs")));
  assert.deepEqual(P.registryContributions("job-routing")["alpha-job"], { target: "ops", model: "sonnet", plugin: "alpha" });
  assert.equal(P.registryContributions("tasks")[0].name, "alpha-job");
  assert.deepEqual(P.schedulesOf(P.plugin("beta")).map((s) => s.label), ["beta-daily"]);
  assert.equal(P.ownerOf({ label: "beta-daily" }), "beta");
  assert.equal(P.ownerOf({ job: "alpha-job" }), "alpha");
  assert.equal(P.ownerOf({ label: "nobody" }), null);
});

test("crontab plan: add a missing line, adopt an unmarked one keeping its time, keep a retimed one, remove an orphan", () => {
  const alpha = P.plugin("alpha");
  const cmd = M.scheduleCommand(alpha, P.schedulesOf(alpha)[0]);
  assert.match(cmd, /--label alpha-tick -- bash -c '.*plugins\/alpha\/bin\/alpha --go >> .*logs\/alpha\.log 2>&1' # jori-plugin:alpha:alpha-tick$/);
  const lines = [
    "7 9 * * * /x/cron-run --label beta-daily -- old command",                       // unmarked: adopt, keep 7 9
    `3,33 * * * * ${cmd}`,                                                              // marked and current, retimed: leave
    "0 1 * * * /x/cron-run --label gone -- y # jori-plugin:alpha:gone",                // a label alpha no longer has
    "0 2 * * * /x/cron-run --label g -- z # jori-plugin:gamma:g",                      // gamma is off
  ];
  const plan = M.planCrontab({ lines });
  const by = Object.fromEntries(plan.map((c) => [`${c.op}:${c.label}`, c]));
  assert.ok(by["adopt:beta-daily"]);
  assert.ok(by["adopt:beta-daily"].line.startsWith("7 9 * * * "), "the existing time is kept");
  assert.match(by["adopt:beta-daily"].line, /# jori-plugin:beta:beta-daily$/);
  assert.equal(plan.some((c) => c.label === "alpha-tick"), false, "a current, retimed line is left alone");
  assert.ok(by["remove:gone"]);
  assert.ok(by["remove:g"]);
  // nothing there yet → add at the manifest's time
  const fresh = M.planCrontab({ lines: [] });
  assert.ok(fresh.find((c) => c.op === "add" && c.label === "alpha-tick").line.startsWith("*/15 * * * * "));
  // a commented-out copy is left alone: the adopted line is named by its whole text
  const withComment = M.planCrontab({ lines: ["1 1 * * * a --label beta-daily -- x", "# 1 1 * * * a --label beta-daily -- old"] });
  const a = withComment.find((c) => c.label === "beta-daily");
  assert.equal(a.op, "adopt");
  assert.equal(a.tag, "1 1 * * * a --label beta-daily -- x");
  // two live lines for one label → a conflict, never a guess
  const two = M.planCrontab({ lines: ["1 1 * * * a --label beta-daily -- x", "2 2 * * * a --label beta-daily -- y"] });
  assert.equal(two.find((c) => c.label === "beta-daily").op, "conflict");
});

test("enable checks requirements; disable refuses while a dependent is on; check finds duplicate claims", () => {
  const calls = [];
  M._setIo({ readCrontab: () => "", crontabSafe: (a) => calls.push(a), launchctl: () => "" });
  mk("delta", { requires: { plugins: ["missing-one"], env: ["NO_SUCH_KEY_X"] } });
  assert.throws(() => M.enable("delta"), /needs: plugin missing-one \(not installed\), \.env key NO_SUCH_KEY_X/);
  assert.throws(() => M.disable("alpha"), /beta need alpha/);
  M.enable("gamma");
  assert.equal(P.isEnabled("gamma"), true);
  assert.ok(calls.some((a) => a[0] === "replace" && a[1] === "# jori-plugin:alpha:alpha-tick"), "sync added alpha's line");
  M.disable("gamma");
  assert.equal(P.isEnabled("gamma"), false);
  mk("epsilon", { schedules: [{ label: "alpha-tick", cron: "* * * * *", run: "x" }] });
  const probs = M.check({ scanCode: false });
  assert.ok(probs.some((p) => /label alpha-tick is also claimed by alpha/.test(p.problem)));
  fs.rmSync(path.join(KDIR, "epsilon"), { recursive: true });
  fs.rmSync(path.join(KDIR, "delta"), { recursive: true });
});

test("install copies a plugin in and enables it; remove deletes the directory and the state entry", () => {
  M._setIo({ readCrontab: () => "", crontabSafe: () => "", launchctl: () => "" });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "plugsrc-"));
  const pdir = path.join(src, "zeta");
  fs.mkdirSync(pdir);
  fs.writeFileSync(path.join(pdir, "plugin.json"), JSON.stringify({ name: "zeta", title: "Zeta", description: "z" }));
  const r = M.install(pdir);
  assert.equal(r.name, "zeta");
  assert.ok(fs.existsSync(path.join(KDIR, "zeta", "plugin.json")));
  assert.equal(P.isEnabled("zeta"), true);
  assert.throws(() => M.install(pdir), /already installed/);
  M.remove("zeta");
  assert.equal(fs.existsSync(path.join(KDIR, "zeta")), false);
  assert.equal("zeta" in (P.state().enabled || {}), false);
});

test("the CLI's flags reach the manager (--dry-run changes nothing)", async () => {
  const calls = [];
  M._setIo({ readCrontab: () => "", crontabSafe: (a) => calls.push(a), launchctl: () => "", dryRun: false });
  const cli = (await import("../bin/cli.d/plugin.mjs")).default;
  const log = console.log; console.log = () => {};
  try {
    await cli.run(["sync", "--dry-run"], { c: new Proxy({}, { get: () => (s) => s }), die: (m) => { throw new Error(m); }, hasFlag: (args, ...n) => n.some((x) => args.includes(x)), table: () => "" });
  } finally { console.log = log; M._setIo({ dryRun: false }); }
  assert.equal(calls.length, 0, "a dry run wrote nothing");
});

test("verbatim schedules: adopted by exact command, pause prefix kept, other tools' tagged lines removed when off", () => {
  mk("theta", { default: "disabled", cron_tags: ["# THETA_REMINDER"], schedules: [{ label: "theta-poll", cron: "*/2 * * * *", command: "{root}/bin/poll >> {root}/x.log 2>&1  # POLL" }] });
  const st = P.state(); st.enabled = { ...(st.enabled || {}), theta: true }; fs.writeFileSync(P.stateFile(), JSON.stringify(st));
  const root = (await_root());
  const lines = [`#MKTPAUSE# */2 * * * * ${root}/bin/poll >> ${root}/x.log 2>&1  # POLL`, `5 5 4 11 * ${root}/bin/remind pre # THETA_REMINDER`];
  const plan = M.planCrontab({ lines });
  const ad = plan.find((c) => c.label === "theta-poll");
  assert.equal(ad.op, "adopt");
  assert.equal(ad.line, `${lines[0]} # jori-plugin:theta:theta-poll`, "the line is unchanged apart from the marker");
  assert.equal(plan.some((c) => c.op === "untag"), false, "an enabled plugin's tagged lines are its tool's business");
  st.enabled.theta = false; fs.writeFileSync(P.stateFile(), JSON.stringify(st));
  const off = M.planCrontab({ lines: [ad.line, lines[1]] });
  assert.ok(off.find((c) => c.op === "remove" && c.label === "theta-poll"));
  assert.ok(off.find((c) => c.op === "untag" && c.tag === "# THETA_REMINDER"));
  delete st.enabled.theta; fs.writeFileSync(P.stateFile(), JSON.stringify(st));
  fs.rmSync(path.join(KDIR, "theta"), { recursive: true });
});

test("a core plugin is always on and cannot be turned off or removed; a disabled plugin's adopted jobs are hidden", () => {
  mk("kappa", { core: true, default: "disabled" });
  mk("lambda", { default: "disabled", adopted_jobs: ["lambda-job"] });
  assert.equal(P.isEnabled("kappa"), true);
  assert.throws(() => M.disable("kappa"), /core/);
  assert.throws(() => M.remove("kappa"), /core/);
  assert.ok(P.disabledJobs().has("lambda-job"));
  assert.equal(P.ownerOf({ job: "lambda-job" }), "lambda");
  fs.rmSync(path.join(KDIR, "kappa"), { recursive: true });
  fs.rmSync(path.join(KDIR, "lambda"), { recursive: true });
});

function await_root() { return require_root(); }
import { createRequire as _cr } from "node:module";
function require_root() { return _cr(import.meta.url)("../lib/root.cjs").installTools(); }

test("plugin new: the template becomes a valid, off-by-default plugin with its schedule and job", () => {
  fs.cpSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "plugins", "_template"), path.join(KDIR, "_template"), { recursive: true });
  const r = M.create("mu-check", { title: "Mu check", schedule: "10 6 * * *", job: true });
  const m = JSON.parse(fs.readFileSync(path.join(r.dir, "plugin.json"), "utf8"));
  assert.equal(m.name, "mu-check");
  assert.equal(m.title, "Mu check");
  assert.equal(m.default, "disabled");
  assert.deepEqual(m.schedules[0], { label: "mu-check", cron: "10 6 * * *", run: "{node} bin/mu-check", log: "agent/logs/mu-check.log" });
  assert.ok(m.jobs["mu-check"]);
  assert.ok(fs.existsSync(path.join(r.dir, "bin", "mu-check")));
  assert.ok(fs.existsSync(path.join(r.dir, "jobs", "mu-check.md")));
  assert.equal(fs.readFileSync(path.join(r.dir, "README.md"), "utf8").includes("__NAME__"), false);
  assert.deepEqual(P.plugin("mu-check").errors, []);
  assert.equal(P.isEnabled("mu-check"), false);
  assert.throws(() => M.create("mu-check"), /already exists/);
  assert.throws(() => M.create("Bad Name"), /lowercase/);
  assert.throws(() => M.create("nu", { schedule: "daily" }), /five-field/);
  const plain = M.create("nu-check");
  assert.equal(fs.existsSync(path.join(plain.dir, "jobs")), false, "no playbook without --job");
  fs.rmSync(path.join(KDIR, "mu-check"), { recursive: true });
  fs.rmSync(path.join(KDIR, "nu-check"), { recursive: true });
});
