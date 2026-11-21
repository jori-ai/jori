// jori-plugin-tasks.test.mjs — `jori tasks` and `jori doctor` see the enabled
// plugins' tasks (plugin.json jobs.<job>.task).
// Run: node --test tests/jori-plugin-tasks.test.mjs
//
// bin/jori read the tasks registry with an explicit root, which skips the
// plugin layer, so `jori tasks match "rental car"` never found the car-rental
// plugin. A first fix (2026-11-18) dropped the root and took doctor and
// `tasks match` down on the host: a plugin task had no `phrases` (and none of
// the other fields every kernel task has). Plugin tasks are now full entries
// (lib/plugins.cjs pluginTask), the root is dropped for tasks when the install
// is this checkout, doctor finds a scheduled plugin task by its plugin's cron
// marker, and `jori tasks run <task> --task "…"` passes this request along.
//
// Runs the real CLI against a fixture install (JORI_HOME = the fixture, so the
// install IS the checkout and the plugin layer loads; with HOME alone the
// root would be passed and the test would pass vacuously), with fake
// `crontab` / `curl` first on PATH.

import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const kernelTask = {
  name: "kernel-job", schedule: "on-demand", schedule_human: "On request", trigger_script: null,
  webhook_url: "http://localhost:9092", webhook_task: "kernel-job", ops_playbook_section: null,
  delivers_to: "jori", phrases: ["kernel thing"], description: "A kernel job.", job: "kernel-job",
};

function plugin(tools, name, manifest) {
  const dir = path.join(tools, "plugins", name);
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name, title: name, description: `${name} plugin`, ...manifest }));
  for (const job of Object.keys(manifest.jobs || {})) fs.writeFileSync(path.join(dir, "jobs", `${job}.md`), `# ${job}\n`);
}

// A fixture install; returns { tools, run(args) → spawnSync result, cleanup }.
function fixture({ rentalPhrases = ["rental car", "hire car"], cronLines = [], localTasks = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jori-plugin-tasks-"));
  const tools = path.join(home, "Dev/jori");
  const bin = path.join(home, "fakebin");
  for (const d of ["system", "agent/scripts", "agent/local", "data"]) fs.mkdirSync(path.join(tools, d), { recursive: true });
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(ROOT, "lib"), path.join(tools, "lib"));
  fs.writeFileSync(path.join(tools, "system/tasks.json"), JSON.stringify({ tasks: [kernelTask] }));
  fs.writeFileSync(path.join(tools, "system/services.json"), JSON.stringify({ services: [] }));
  fs.writeFileSync(path.join(tools, "data/clock-jobs.json"), "[]");
  fs.writeFileSync(path.join(tools, "data/user-timezone.json"),
    JSON.stringify({ timezone: "America/New_York", updated_at: new Date().toISOString() }));
  // On request, chat-dispatched (car-rental's shape).
  plugin(tools, "rentals-demo", { jobs: { "rentals-demo": { chrome: true, routing: { target: "ops", model: "sonnet" }, task: { phrases: rentalPhrases, description: "Find a rental car." } } } });
  // Nightly, from its own plugin schedule; its task names no schedule or phrases (projects' shape).
  plugin(tools, "nightly-demo", {
    schedules: [{ label: "nightly-demo", cron: "5 3 * * *", run: "bin/nightly-demo" }],
    jobs: { "nightly-demo": { routing: { target: "ops-light", model: "sonnet" }, task: { description: "Nightly sweep." } } },
  });
  // Off: its job leaves the registry, and its local entry must survive a write.
  plugin(tools, "off-demo", { default: "disabled", jobs: { "off-job": { task: { phrases: ["off thing"], description: "Off." } } } });
  if (localTasks) fs.writeFileSync(path.join(tools, "agent/local/tasks.json"), JSON.stringify(localTasks, null, 2));
  fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\ncat <<'EOF'\n${cronLines.join("\n")}\nEOF\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, "bin/jori"), ...args], {
    encoding: "utf8", timeout: 60000,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, JORI_HOME: tools, NO_COLOR: "1" },
  });
  return { tools, run, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const doctor = (fx) => {
  const r = fx.run(["doctor", "--json"]);
  assert.ok(!/TypeError|ReferenceError/.test(r.stderr), r.stderr.slice(0, 600));
  const checks = JSON.parse(r.stdout);
  return (name) => {
    const ck = checks.find((x) => x.name === name);
    assert.ok(ck, `doctor check "${name}" missing`);
    return ck;
  };
};

it("plugin tasks are listed as full entries, the disabled plugin's left out", () => {
  const fx = fixture();
  try {
    const r = fx.run(["tasks", "list", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const tasks = JSON.parse(r.stdout);
    const byName = Object.fromEntries(tasks.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), ["kernel-job", "nightly-demo", "rentals-demo"]);
    const rental = byName["rentals-demo"];
    assert.deepEqual(rental.phrases, ["rental car", "hire car"]);
    assert.equal(rental.job, "rentals-demo");
    assert.equal(rental.plugin, "rentals-demo");
    assert.equal(rental.schedule, "on-demand");
    assert.equal(rental.trigger_script, null);
    const nightly = byName["nightly-demo"];
    assert.deepEqual(nightly.phrases, [], "a task with no phrases gets an empty list");
    assert.equal(nightly.schedule, "5 3 * * *", "the plugin schedule labelled as the job gives the schedule");
    const show = fx.run(["tasks", "show", "nightly-demo"]);
    assert.equal(show.status, 0, show.stderr);
  } finally { fx.cleanup(); }
});

it("tasks match finds a plugin task by its phrase", () => {
  const fx = fixture();
  try {
    const r = fx.run(["tasks", "match", "I need a rental car in Lisbon", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.confidence, "high");
    assert.equal(out.matches[0].name, "rentals-demo");
    assert.equal(out.matches[0].plugin, "rentals-demo");
  } finally { fx.cleanup(); }
});

it("doctor: a scheduled plugin task is found by its plugin's cron marker; phrases are checked across plugins", () => {
  const fx = fixture({ cronLines: ["7 4 * * * /x/bin/cron-run --label nightly-demo -- /x/bin/nightly-demo # jori-plugin:nightly-demo:nightly-demo"] });
  try {
    const check = doctor(fx);
    const sched = check("tasks.json schedules ↔ crontab");
    assert.equal(sched.ok, true, `${sched.detail} (a retimed plugin line still counts)`);
    assert.equal(check("task phrases are unique").ok, true);
    assert.equal(check("trigger_script paths exist").ok, true);
  } finally { fx.cleanup(); }
});

it("doctor: a plugin task with no cron line, or a phrase shared with a kernel task, is reported", () => {
  const fx = fixture({ rentalPhrases: ["rental car", "kernel thing"] });
  try {
    const check = doctor(fx);
    const sched = check("tasks.json schedules ↔ crontab");
    assert.equal(sched.ok, false);
    assert.equal(sched.detail, "missing cron: nightly-demo (plugin nightly-demo)");
    const phrases = check("task phrases are unique");
    assert.equal(phrases.ok, false);
    assert.match(phrases.detail, /"kernel thing" in \[kernel-job,rentals-demo\]/);
  } finally { fx.cleanup(); }
});

it("tasks run passes --task along: to a plugin job through jori dispatch, to a webhook job in the body", () => {
  const fx = fixture();
  try {
    for (const args of [["rentals-demo", "--task", "Lisbon airport; Dec 3; Dec 9"], ["--task", "Lisbon airport; Dec 3; Dec 9", "rentals-demo"]]) {
      const r = fx.run(["tasks", "run", ...args, "--dry-run"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /tier chain: ops:/, "a chrome job goes to ops");
      assert.ok(r.stdout.includes(JSON.stringify({ job: "rentals-demo", source: "rentals-demo", task: "Lisbon airport; Dec 3; Dec 9" })), r.stdout);
    }
    const k = fx.run(["tasks", "run", "kernel-job", "--task", "only this week", "--dry-run"]);
    assert.equal(k.status, 0, k.stderr);
    assert.ok(k.stdout.includes(JSON.stringify({ job: "kernel-job", task: "only this week" })), k.stdout);
    const plain = fx.run(["tasks", "run", "kernel-job", "--dry-run"]);
    assert.ok(plain.stdout.includes(JSON.stringify({ job: "kernel-job" })), plain.stdout);
    const empty = fx.run(["tasks", "run", "kernel-job", "--task", "", "--dry-run"]);
    assert.notEqual(empty.status, 0, "an empty --task is refused");
  } finally { fx.cleanup(); }
});

it("tasks pause on a plugin task writes only the override, and keeps a disabled plugin's local entry", () => {
  const offEntry = { name: "off-job", paused_until: "2099-01-01", paused_reason: "kept" };
  const fx = fixture({ localTasks: { tasks: [offEntry] } });
  try {
    const r = fx.run(["tasks", "pause", "rentals-demo", "--until", "2099-02-01", "--reason", "away"]);
    assert.equal(r.status, 0, r.stderr);
    const local = JSON.parse(fs.readFileSync(path.join(fx.tools, "agent/local/tasks.json"), "utf8"));
    const byName = Object.fromEntries(local.tasks.map((t) => [t.name, t]));
    assert.deepEqual(byName["rentals-demo"], { name: "rentals-demo", paused_until: "2099-02-01", paused_reason: "away" },
      "the plugin's own fields are not copied into the local file");
    assert.deepEqual(byName["off-job"], offEntry, "a disabled plugin's local entry is not dropped");
    assert.equal(byName["kernel-job"], undefined);
    const resume = fx.run(["tasks", "resume", "rentals-demo"]);
    assert.equal(resume.status, 0, resume.stderr);
    const after = JSON.parse(fs.readFileSync(path.join(fx.tools, "agent/local/tasks.json"), "utf8"));
    assert.deepEqual(after.tasks.map((t) => t.name), ["off-job"]);
  } finally { fx.cleanup(); }
});
