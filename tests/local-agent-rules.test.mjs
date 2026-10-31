// local-agent-rules.test.mjs — the operator's own agent rules and playbook
// additions (agent/local/) reach the agent.
//
// The kernel rulebooks (agent/CLAUDE.md, <agent>/CLAUDE.md) and kernel
// playbooks are generic; an instance's own rules live in agent/local/.
//   - shared.md + <chat|ops>.md are joined into <state>/local-rules.md at session
//     start and passed as --append-system-prompt-file (claude-session.mjs);
//   - local/jobs/<job>.md is appended to a dispatched playbook (http-server.mjs);
//   - local/email-triage-rules.md is merged into the triage ruleset by heading
//     (dispatch-preamble.mjs mergeSectionedMarkdown) and read through
//     TRIAGE_RULES_FILE.
//
// Run: node --test tests/local-agent-rules.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ClaudeSession, buildLocalRulesFile, readLocalRules, LOCAL_RULES_FILE } from "../agent/supervisor/claude-session.mjs";
import {
  withLocalCompanion, sliceAll, mergeSectionedMarkdown, composeTriageRules, writeFileIfChanged,
} from "../agent/supervisor/dispatch-preamble.mjs";
import { parse, core, index, section } from "../lib/triage-rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Where an installation sits under HOME (lib/root.cjs), for the fake homes below.
const INSTALL_REL = path.relative(os.homedir(), createRequire(import.meta.url)("../lib/root.cjs").installRoot());
const MOCK_CLAUDE = path.join(ROOT, "agent/test/mock-claude.mjs");

function tmp(prefix = "local-rules-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ---- the joined rules file ---------------------------------------------------

test("shared.md + <role>.md are joined, in that order, into <state>/local-rules.md", () => {
  const local = tmp(); const state = tmp();
  fs.writeFileSync(path.join(local, "shared.md"), "# Local rules — shared\n\nS1\n");
  fs.writeFileSync(path.join(local, "ops.md"), "# Local rules — ops\n\nO1\n");
  fs.writeFileSync(path.join(local, "chat.md"), "# Local rules — chat\n\nC1\n");
  const ops = buildLocalRulesFile({ localDir: local, role: "ops", stateDir: state });
  assert.equal(ops.path, path.join(state, LOCAL_RULES_FILE));
  assert.equal(fs.readFileSync(ops.path, "utf8"), "# Local rules — shared\n\nS1\n\n# Local rules — ops\n\nO1\n");
  assert.equal(ops.content, fs.readFileSync(ops.path, "utf8"));
  const chatState = tmp();
  const chat = buildLocalRulesFile({ localDir: local, role: "chat", stateDir: chatState });
  assert.match(fs.readFileSync(chat.path, "utf8"), /S1[\s\S]*C1/); // lang-regex-ok: asserts on our own fixture file, not the user's words
  assert.doesNotMatch(fs.readFileSync(chat.path, "utf8"), /O1/);
});

test("a missing or blank file is skipped; no local rules at all → no file, path null", () => {
  const local = tmp(); const state = tmp();
  fs.writeFileSync(path.join(local, "shared.md"), "only shared\n");
  fs.writeFileSync(path.join(local, "ops.md"), "  \n\n");
  assert.equal(readLocalRules({ localDir: local, role: "ops" }), "only shared\n");
  const r = buildLocalRulesFile({ localDir: local, role: "ops", stateDir: state });
  assert.equal(fs.readFileSync(r.path, "utf8"), "only shared\n");

  // Empty local dir: nothing to append, and the stale file from before is gone.
  fs.rmSync(path.join(local, "shared.md"));
  const none = buildLocalRulesFile({ localDir: local, role: "ops", stateDir: state });
  assert.equal(none.path, null);
  assert.equal(none.content, "");
  assert.equal(fs.existsSync(path.join(state, LOCAL_RULES_FILE)), false);

  // No local dir at all.
  const gone = buildLocalRulesFile({ localDir: path.join(local, "nope"), role: "chat", stateDir: state });
  assert.equal(gone.path, null);
});

test("the file is rewritten only when its content changes (stable bytes for the prompt cache)", () => {
  const local = tmp(); const state = tmp();
  fs.writeFileSync(path.join(local, "shared.md"), "rule A\n");
  const first = buildLocalRulesFile({ localDir: local, role: "ops", stateDir: state });
  const old = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(first.path, old, old);
  buildLocalRulesFile({ localDir: local, role: "ops", stateDir: state });
  assert.equal(fs.statSync(first.path).mtimeMs, old.getTime(), "unchanged content must not be rewritten");
  fs.writeFileSync(path.join(local, "shared.md"), "rule B\n");
  const second = buildLocalRulesFile({ localDir: local, role: "ops", stateDir: state });
  assert.equal(second.path, first.path, "same stable path");
  assert.equal(fs.readFileSync(second.path, "utf8"), "rule B\n");
});

// ---- the claude argv -----------------------------------------------------------

test("ClaudeSession passes --append-system-prompt-file only when a file is given", () => {
  const base = { sessionId: "00000000-0000-4000-8000-000000000000", model: "m", cwd: ROOT };
  const withFile = new ClaudeSession({ ...base, appendSystemPromptFile: "/x/local-rules.md" })._buildArgs({ resume: false });
  assert.equal(argValue(withFile, "--append-system-prompt-file"), "/x/local-rules.md");
  const without = new ClaudeSession({ ...base, appendSystemPromptFile: undefined })._buildArgs({ resume: false });
  assert.equal(without.includes("--append-system-prompt-file"), false);
});

for (const [file, role] of [["agent/supervisor/index.mjs", "ops"], ["agent/supervisor/chat-supervisor.mjs", "chat"]]) {
  test(`${path.basename(file)} builds the ${role} local rules at session start and passes them`, () => {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    const start = src.indexOf("async startSession(");
    const body = src.slice(start, src.indexOf("new ClaudeSession(sessionOpts)", start));
    assert.match(body, /const localRulesFile = this\._buildLocalRules\(\);/);
    assert.match(body, /appendSystemPromptFile: localRulesFile \|\| undefined/);
    assert.match(src, new RegExp(`buildLocalRulesFile\\(\\{ localDir: LOCAL_DIR, role: "${role}", stateDir: this\\.dataDir \\}\\)`));
    assert.match(src, /startLocalWatchers\(\);/);
  });
}

// End to end: the supervisor spawns "claude" (a wrapper that records its argv
// and then runs mock-claude) with the flag pointing at the joined file, and
// without it when local/ is empty. Runs both supervisors under a throwaway
// HOME so nothing touches the real repo's state or logs.
function canListen() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.once("error", () => resolve(false));
    s.listen(0, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function fakeHome() {
  const home = tmp("local-rules-home-");
  const root = path.join(home, INSTALL_REL);
  for (const d of ["agent/chat-agent", "agent/ops-agent", "agent/logs", "data"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  // index.mjs imports lib/triage-log.js from the kernel tree at start.
  fs.symlinkSync(path.join(ROOT, "lib"), path.join(root, "lib"));
  return home;
}

function argvRecorder(dir) {
  const out = path.join(dir, "argv.json");
  const wrapper = path.join(dir, "claude-wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import fs from "node:fs";',
    `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`,
    `await import(${JSON.stringify(MOCK_CLAUDE)});`,
  ].join("\n"));
  return { wrapper, out };
}

let nextPort = 21000 + Math.floor(Math.random() * 2000);

async function spawnedArgs({ supervisor, localFiles }) {
  const home = fakeHome();
  const work = tmp("local-rules-run-");
  const local = path.join(work, "local");
  fs.mkdirSync(local, { recursive: true });
  for (const [name, text] of Object.entries(localFiles)) fs.writeFileSync(path.join(local, name), text);
  const state = path.join(work, "state");
  fs.mkdirSync(state, { recursive: true });
  const { wrapper, out } = argvRecorder(work);
  const base = nextPort; nextPort += 5;
  const isChat = supervisor === "chat";
  const agent = isChat ? "test-chat" : "test-ops";
  const cfg = {
    agents: {
      [agent]: {
        model: "mock", runtime: "supervisor", devChannels: [], permissionMode: "bypassPermissions",
        allowedTools: ["Bash"], remoteControlPrefix: agent,
        cwd: isChat ? "agent/chat-agent" : "agent/ops-agent",
        supervisor: isChat ? { healthPort: base } : { controlPort: base, webhookPort: base + 1, healthPort: base + 2 },
      },
    },
  };
  const configPath = path.join(work, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify(cfg));
  const script = path.join(ROOT, "agent/supervisor", isChat ? "chat-supervisor.mjs" : "index.mjs");
  const proc = spawn(process.execPath, [
    script, "--agent", agent, "--config", configPath, "--state-dir", state,
    "--claude-bin", JSON.stringify([process.execPath, wrapper]), "--no-resume",
  ], {
    cwd: work,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env, HOME: home, JORI_LOCAL_DIR: local, OPS_HANDOFF_DISABLED: "1",
      MEMORY_INDEX_DB: path.join(work, "event-index.db"), TRIAGE_RULES_FILE: "",
    },
  });
  let stderr = "";
  proc.stderr.on("data", (b) => { stderr += b.toString(); });
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(out)) {
      if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`claude never spawned. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 50));
    return { args: JSON.parse(fs.readFileSync(out, "utf8")), state };
  } finally {
    proc.kill("SIGKILL");
  }
}

for (const supervisor of ["chat", "ops"]) {
  test(`${supervisor} supervisor: claude gets --append-system-prompt-file with shared + ${supervisor} rules, and none when local/ is empty`, async (t) => {
    if (!(await canListen())) { t.skip("cannot bind a local port here"); return; }
    const files = { "shared.md": "# shared\nSHARED-RULE\n", "chat.md": "# chat\nCHAT-RULE\n", "ops.md": "# ops\nOPS-RULE\n" };
    const { args, state } = await spawnedArgs({ supervisor, localFiles: files });
    const p = argValue(args, "--append-system-prompt-file");
    assert.equal(p, path.join(state, "local-rules.md"));
    const text = fs.readFileSync(p, "utf8");
    assert.equal(text, `# shared\nSHARED-RULE\n\n# ${supervisor}\n${supervisor.toUpperCase()}-RULE\n`);

    const empty = await spawnedArgs({ supervisor, localFiles: {} });
    assert.equal(empty.args.includes("--append-system-prompt-file"), false);
  });
}

// ---- playbook companions ------------------------------------------------------

test("a playbook's local companion is appended verbatim; no companion leaves it unchanged", () => {
  assert.equal(withLocalCompanion("KERNEL\n", null), "KERNEL\n");
  assert.equal(withLocalCompanion("KERNEL\n", "  \n"), "KERNEL\n");
  assert.equal(withLocalCompanion("KERNEL\n\n", "## Local additions\nX\n"), "KERNEL\n\n## Local additions\nX\n");
});

test("http-server appends local/jobs/<job>.md to a webhook job's playbook", () => {
  const src = fs.readFileSync(path.join(ROOT, "agent/supervisor/http-server.mjs"), "utf8");
  assert.match(src, /task = withLocalCompanion\(task, readOptional\(localCompanionPath\(LOCAL_DIR, payload\.job\)\)\);/);
});

test("marker blocks are taken from the kernel and the companion alike", () => {
  const k = "intro\n<!-- e:start -->\nKERNEL PART\n<!-- e:end -->\n";
  const l = "<!-- e:start -->\nLOCAL PART\n<!-- e:end -->\n<!-- o:start -->x<!-- o:end -->";
  assert.equal(sliceAll(k, "<!-- e:start -->", "<!-- e:end -->"), "KERNEL PART");
  assert.equal(sliceAll(k + l, "<!-- e:start -->", "<!-- e:end -->"), "KERNEL PART\n\nLOCAL PART");
  assert.equal(sliceAll("none", "<!-- e:start -->", "<!-- e:end -->"), null);
});

// ---- the triage ruleset ---------------------------------------------------------

const KERNEL_RULES = `# Rules

intro

### Step 3: Classify
Assign one label from the instance's label set.

### Step 4: Prioritize
Generic P1 rules.

### Shipping
Generic shipping.

### Step 6: Record classification
Record it.
`;

const LOCAL_RULES = `# Local additions

### Step 3: Classify
Labels: \`alpha\`, \`beta\`.

### Step 4: Prioritize
Mail from the landlord is P1.

### Landlord fast-path
Label \`alpha\`, P3.

### Step 6: Record classification
Also tag it.
`;

test("local triage sections merge into the kernel ones by heading and keep their place", () => {
  const merged = mergeSectionedMarkdown(KERNEL_RULES, LOCAL_RULES);
  const doc = parse(merged);
  assert.deepEqual(doc.sections.map((s) => s.title),
    ["Step 3: Classify", "Step 4: Prioritize", "Landlord fast-path", "Shipping", "Step 6: Record classification"]);
  assert.match(section("step-3-classify", doc), /instance's label set\.\n\nLabels: `alpha`, `beta`\./);
  assert.match(core(doc), /Mail from the landlord is P1\./);
  assert.match(core(doc), /Record it\.\n\nAlso tag it\./);
  assert.match(index(doc), /landlord-fast-path — Landlord fast-path/);
  assert.match(doc.preamble, /intro[\s\S]*# Local additions/);
  // No companion → the kernel text, untouched.
  assert.equal(mergeSectionedMarkdown(KERNEL_RULES, null), KERNEL_RULES);
});

test("composeTriageRules writes the merged file once and only on change; null without a companion", () => {
  const d = tmp();
  const kernelPath = path.join(d, "kernel.md"), localPath = path.join(d, "local.md"), outPath = path.join(d, "out", "merged.md");
  fs.writeFileSync(kernelPath, KERNEL_RULES);
  assert.equal(composeTriageRules({ kernelPath, localPath, outPath }), null);
  fs.writeFileSync(localPath, LOCAL_RULES);
  assert.equal(composeTriageRules({ kernelPath, localPath, outPath }), outPath);
  assert.equal(fs.readFileSync(outPath, "utf8"), mergeSectionedMarkdown(KERNEL_RULES, LOCAL_RULES));
  assert.equal(writeFileIfChanged(outPath, fs.readFileSync(outPath, "utf8")), false);
});

test("the real kernel + local triage rules merge with every local section placed", (t) => {
  const kernelPath = path.join(ROOT, "agent/ops-agent/email-triage-rules.md");
  const localPath = path.join(ROOT, "agent/local/email-triage-rules.md");
  if (!fs.existsSync(localPath)) { t.skip("no local triage rules in this checkout"); return; }
  const kernel = parse(fs.readFileSync(kernelPath, "utf8"));
  const local = parse(fs.readFileSync(localPath, "utf8"));
  const merged = parse(mergeSectionedMarkdown(fs.readFileSync(kernelPath, "utf8"), fs.readFileSync(localPath, "utf8")));
  const titles = new Set(merged.sections.map((s) => s.title));
  for (const s of [...kernel.sections, ...local.sections]) assert.ok(titles.has(s.title), `missing section ${s.title}`);
  // Every local section's body is in the merged document.
  const all = merged.sections.map((s) => s.text).join("\n\n");
  for (const s of local.sections) {
    const body = s.text.split("\n").slice(1).join("\n").trim();
    if (body) assert.ok(all.includes(body), `local section body lost: ${s.title}`);
  }
  // What the agent reads keeps the shape triage-intake-determinism checks:
  // core well under half the ruleset, unique category slugs, Step 5 in core.
  const mergedText = mergeSectionedMarkdown(fs.readFileSync(kernelPath, "utf8"), fs.readFileSync(localPath, "utf8"));
  assert.ok(core(merged).length < mergedText.length * 0.45, "core must be well under half the merged ruleset");
  const slugs = merged.sections.filter((s) => !s.core).map((s) => s.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(core(merged).includes("### Step 5: Act"));
});

test("the ops supervisor points TRIAGE_RULES_FILE at the merged ruleset", () => {
  const src = fs.readFileSync(path.join(ROOT, "agent/supervisor/index.mjs"), "utf8");
  assert.match(src, /composeTriageRules\(\{/);
  assert.match(src, /process\.env\.TRIAGE_RULES_FILE = merged;/);
  assert.match(src, /this\._refreshTriageRules\(\);\n\s+const localRulesFile = this\._buildLocalRules\(\);/);
});

// ---- forks outside the supervisors --------------------------------------------
//
// A `claude -p` started in an agent dir loads that dir's CLAUDE.md files, which
// used to carry the instance's own rules. Every such fork also gets the local
// rules: the ephemeral runners and the other launchers with their own `claude -p`
// line (agent/scripts/lib/local-rules.sh), the chat fork executor and
// one-shots (claude-session.mjs localRulesFileForCwd).

import { spawnSync } from "node:child_process";
import { localRulesRoleForCwd, localRulesFileForCwd } from "../agent/supervisor/claude-session.mjs";

const LOCAL_RULES_SH = path.join(ROOT, "agent/scripts/lib/local-rules.sh");

// The fixtures say where their local dir is (HOME / an explicit
// JORI_LOCAL_DIR); an operator's exported JORI_LOCAL_DIR must not override them.
const { JORI_LOCAL_DIR: _operatorLocal, ...BASE_ENV } = process.env;

function bash(script, env = {}) {
  return spawnSync("/bin/bash", ["-c", `source ${JSON.stringify(LOCAL_RULES_SH)}; ${script}`], {
    encoding: "utf8", env: { ...BASE_ENV, ...env },
  });
}

function localFixture() {
  const home = tmp("local-rules-fork-");
  const root = path.join(home, INSTALL_REL);
  const local = path.join(root, "agent/local");
  fs.mkdirSync(path.join(local, "jobs"), { recursive: true });
  for (const d of ["ops-agent/jobs", "chat-agent", "ops-light-agent", "logs"]) fs.mkdirSync(path.join(root, "agent", d), { recursive: true });
  fs.writeFileSync(path.join(local, "shared.md"), "# Local rules — shared\nSHARED RULE\n\n");
  fs.writeFileSync(path.join(local, "ops.md"), "# Local rules — ops\nOPS RULE\n");
  fs.writeFileSync(path.join(local, "chat.md"), "# Local rules — chat\nCHAT RULE\n");
  fs.writeFileSync(path.join(local, "jobs/demo-job.md"), "## Local additions — demo-job\nLOCAL STEP\n");
  fs.writeFileSync(path.join(root, "agent/ops-agent/jobs/demo-job.md"), "# Demo job\nKERNEL STEP\n");
  fs.writeFileSync(path.join(root, "agent/ops-agent/jobs/plain-job.md"), "# Plain job\nKERNEL ONLY\n");
  return { home, root, local };
}

test("local-rules.sh: the role follows the cwd's CLAUDE.md hierarchy", () => {
  const { home, root } = localFixture();
  const role = (cwd) => bash(`jori_local_rules_role ${JSON.stringify(cwd)}`, { HOME: home }).stdout.trim();
  assert.equal(role(path.join(root, "agent/ops-agent")), "ops");
  assert.equal(role(path.join(root, "agent/ops-light-agent")), "ops");
  assert.equal(role(path.join(root, "agent/chat-agent")), "chat");
  assert.equal(role(path.join(root, "agent/logs")), "shared");
  assert.equal(role(root), "", "the repo root loads no agent CLAUDE.md");
  assert.equal(role(home), "");
  // node twin agrees
  assert.equal(localRulesRoleForCwd(path.join(root, "agent/ops-light-agent"), root), "ops");
  assert.equal(localRulesRoleForCwd(path.join(root, "agent/chat-agent"), root), "chat");
  assert.equal(localRulesRoleForCwd(path.join(root, "agent/logs"), root), "shared");
  assert.equal(localRulesRoleForCwd(root, root), null);
});

test("local-rules.sh: the joined rules file is byte-identical to the supervisors' own", () => {
  const { home, local } = localFixture();
  for (const role of ["ops", "chat", "shared"]) {
    const out = path.join(home, `rules-${role}.md`);
    const r = bash(`jori_local_rules_file ${role} ${JSON.stringify(out)}; echo rc=$?`, { HOME: home });
    assert.match(r.stdout, /rc=0/);
    assert.equal(fs.readFileSync(out, "utf8"), readLocalRules({ localDir: local, role }), role);
  }
  // nothing to append → rc 1 and no file left behind
  const empty = tmp("local-rules-empty-");
  const out = path.join(empty, "none.md");
  const r = bash(`jori_local_rules_file ops ${JSON.stringify(out)}; echo rc=$?`, { HOME: empty, JORI_LOCAL_DIR: empty });
  assert.match(r.stdout, /rc=1/);
  assert.equal(fs.existsSync(out), false);
  assert.match(bash(`jori_local_rules_file "" ${JSON.stringify(out)}; echo rc=$?`, { HOME: home }).stdout, /rc=1/);
});

test("local-rules.sh: a playbook gets its companion after a blank line; without one it is unchanged", () => {
  const { home, root } = localFixture();
  const demo = bash(`jori_job_prompt ${JSON.stringify(path.join(root, "agent/ops-agent/jobs/demo-job.md"))}`, { HOME: home }).stdout;
  assert.equal(demo, "# Demo job\nKERNEL STEP\n\n## Local additions — demo-job\nLOCAL STEP\n");
  const plainMd = path.join(root, "agent/ops-agent/jobs/plain-job.md");
  assert.equal(bash(`jori_job_prompt ${JSON.stringify(plainMd)}`, { HOME: home }).stdout, fs.readFileSync(plainMd, "utf8"));
  assert.equal(bash(`jori_job_companion ${JSON.stringify(plainMd)}`, { HOME: home }).stdout, "");
});

// A fake claude: `auth status` reads Max; a run records its argv, its stdin and
// the --append-system-prompt-file content (the runner deletes that file after).
function recordingClaude(dir) {
  const f = path.join(dir, "claude");
  fs.writeFileSync(f, `#!/bin/bash
if [ "$1" = auth ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'; exit 0; fi
printf '%s\\n' "$@" > ${JSON.stringify(path.join(dir, "argv"))}
cat > ${JSON.stringify(path.join(dir, "stdin"))}
prev=""; for a in "$@"; do [ "$prev" = --append-system-prompt-file ] && cat "$a" > ${JSON.stringify(path.join(dir, "appended"))}; prev="$a"; done
echo '{"type":"result","result":"done"}'
`);
  fs.chmodSync(f, 0o755);
  return f;
}

// The runners use macOS `mktemp -t <prefix>`; GNU mktemp wants X's in it. Off
// macOS, a shim on PATH adds them so the runners can be exercised here.
function runnerEnv(home, claude) {
  const env = { ...BASE_ENV, HOME: home, CLAUDE_BIN: claude, TMPDIR: home };
  if (process.platform !== "darwin") {
    const real = spawnSync("/bin/bash", ["-c", "command -v mktemp"], { encoding: "utf8" }).stdout.trim();
    const shimDir = path.join(home, "shim");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, "mktemp"),
      `#!/bin/bash\nif [ "$1" = -t ] && [[ "$2" != *XXX* ]]; then exec ${real} -t "$2.XXXXXXXX"; fi\nexec ${real} "$@"\n`);
    fs.chmodSync(path.join(shimDir, "mktemp"), 0o755);
    env.PATH = `${shimDir}:${process.env.PATH}`;
  }
  return env;
}

for (const runner of ["run-ephemeral-opus.sh", "run-ephemeral-fable.sh"]) {
  test(`${runner} appends the playbook's companion and passes shared + ops as the system-prompt append`, () => {
    const { home, root, local } = localFixture();
    const claude = recordingClaude(home);
    const md = path.join(root, "agent/ops-agent/jobs/demo-job.md");
    const r = spawnSync("/bin/bash", [path.join(ROOT, "agent/scripts/lib", runner), "demo-job", md, "--task", "TASK LINE", "--model", "claude-test"], {
      encoding: "utf8", env: runnerEnv(home, claude),
    });
    assert.equal(r.status, 0, r.stderr + fs.readFileSync(path.join(root, "agent/logs/demo-job.log"), "utf8"));
    assert.equal(fs.readFileSync(path.join(home, "stdin"), "utf8"), "TASK LINE\n\n# Demo job\nKERNEL STEP\n\n## Local additions — demo-job\nLOCAL STEP\n");
    assert.equal(fs.readFileSync(path.join(home, "appended"), "utf8"), readLocalRules({ localDir: local, role: "ops" }));
    const argv = fs.readFileSync(path.join(home, "argv"), "utf8").split("\n");
    assert.ok(argv.includes("--append-system-prompt-file"));
    // the temp rules file is cleaned up
    const left = fs.readdirSync(home).filter((n) => n.endsWith(".local-rules"));
    assert.deepEqual(left, []);
  });
}

test("a runner whose cwd loads no Jori CLAUDE.md passes no local rules", () => {
  const { home, root } = localFixture();
  const claude = recordingClaude(home);
  const md = path.join(root, "agent/ops-agent/jobs/plain-job.md");
  const other = tmp("other-repo-");
  const r = spawnSync("/bin/bash", [path.join(ROOT, "agent/scripts/lib/run-ephemeral-opus.sh"), "plain-job", md, "--model", "claude-test", "--cwd", other], {
    encoding: "utf8", env: runnerEnv(home, claude),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(home, "argv"), "utf8").includes("--append-system-prompt-file"), false);
  assert.equal(fs.readFileSync(path.join(home, "stdin"), "utf8"), "# Plain job\nKERNEL ONLY\n");
});

test("launchers with their own claude -p line source local-rules.sh and pass the append", () => {
  // bin/daily-summary-run, plus every trigger script (kernel or this
  // installation's) that sources local-rules.sh.
  const triggers = fs.readdirSync(path.join(ROOT, "agent/scripts"))
    .filter((f) => f.endsWith(".sh"))
    .map((f) => `agent/scripts/${f}`)
    .filter((rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").includes('lib/local-rules.sh"'));
  for (const rel of ["bin/daily-summary-run", ...triggers]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(src, /local-rules\.sh"/, rel);
    assert.match(src, /jori_local_rules_file "\$\(jori_local_rules_role "\$CWD"\)" "\$LOCAL_RULES_FILE"/, rel);
    assert.match(src, /\$\{LOCAL_RULES_FILE:\+--append-system-prompt-file "\$LOCAL_RULES_FILE"\}/, rel);
    assert.match(src, /rm -f "\$OUT_TMP\.local-rules"/, rel);
  }
  for (const rel of triggers) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (/^JOB_MD=/m.test(src)) assert.match(src, /jori_job_prompt "\$JOB_MD"/, rel);
  }
  assert.match(fs.readFileSync(path.join(ROOT, "bin/daily-summary-run"), "utf8"), /LOCAL_COMPANION="\$\(jori_job_companion "\$JOB_MD"\)"/);
});

test("localRulesFileForCwd builds the role's file for a fork in an agent dir, and none outside", () => {
  const { home, root, local } = localFixture();
  const state = path.join(home, "state");
  const p = localRulesFileForCwd({ cwd: path.join(root, "agent/ops-agent"), root, localDir: local, stateDir: state });
  assert.equal(fs.readFileSync(p, "utf8"), readLocalRules({ localDir: local, role: "ops" }));
  const c = localRulesFileForCwd({ cwd: path.join(root, "agent/chat-agent"), root, localDir: local, stateDir: state });
  assert.equal(fs.readFileSync(c, "utf8"), readLocalRules({ localDir: local, role: "chat" }));
  assert.notEqual(p, c);
  assert.equal(localRulesFileForCwd({ cwd: root, root, localDir: local, stateDir: state }), null);
});

test("the chat fork executor gets the chat session's local rules", () => {
  const src = fs.readFileSync(path.join(ROOT, "agent/supervisor/chat-supervisor.mjs"), "utf8");
  const at = src.indexOf("forkExecutor: makeStatelessExecutor({");
  assert.ok(at > 0);
  const block = src.slice(at, src.indexOf("})", at));
  assert.match(block, /appendSystemPromptFile: localRulesFile \|\| undefined/);
});

test("runOneShot passes the local rules for its cwd unless told otherwise", async () => {
  const src = fs.readFileSync(path.join(ROOT, "agent/core/one-shot.mjs"), "utf8");
  assert.match(src, /appendSystemPromptFile: appendSystemPromptFile === undefined \? defaultLocalRulesFile\(cwd\) : appendSystemPromptFile/);
});
