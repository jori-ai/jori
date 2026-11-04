// The skills a Jori agent session does not list (lib/hidden-skills.cjs): the
// supervisors pass them as skillOverrides in their per-session --settings, and
// the forks get the same list from agent/scripts/lib/fork-connector-deny.sh.
// Guards the two lists staying equal, both supervisor spawn paths, the opt-out,
// and the skills that must never be hidden.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ClaudeSession } from "../agent/supervisor/claude-session.mjs";
import { REPO_ROOT as ROOT } from "../lib/root.cjs";

const require = createRequire(import.meta.url);
const hs = require("../lib/hidden-skills.cjs");

function shellList(name) {
  const src = fs.readFileSync(path.join(ROOT, "agent/scripts/lib/fork-connector-deny.sh"), "utf8");
  const line = src.split("\n").find((l) => l.startsWith(`${name}="`));
  assert.ok(line, `${name} not found in fork-connector-deny.sh`);
  return line.slice(name.length + 2, line.lastIndexOf('"')).split(/\s+/).filter(Boolean);
}

test("the account and bundled lists match the forks' shell lists", () => {
  assert.deepEqual([...hs.ACCOUNT_SKILLS].sort(), shellList("_jori_fork_skills_account").sort());
  assert.deepEqual([...hs.BUNDLED_SKILLS].sort(), shellList("_jori_fork_skills_bundled").sort());
});

test("local hidden skills are added; workflow-authoring and malformed names never are", () => {
  const localConfig = () => ({ hidden: ["my-skill", "workflow-authoring", "bad name", 7, "my-skill"] });
  const list = hs.hiddenSkills({ localConfig });
  assert.ok(list.includes("my-skill"));
  assert.equal(list.filter((s) => s === "my-skill").length, 1);
  assert.ok(!list.includes("workflow-authoring"));
  assert.ok(!list.includes("bad name"));
  assert.ok(!list.includes(7));
  assert.equal(list.length, hs.ACCOUNT_SKILLS.length + hs.BUNDLED_SKILLS.length + 1);
});

test("a missing or broken local config leaves just the generic lists", () => {
  const n = hs.ACCOUNT_SKILLS.length + hs.BUNDLED_SKILLS.length;
  assert.equal(hs.hiddenSkills({ localConfig: () => ({}) }).length, n);
  assert.equal(hs.hiddenSkills({ localConfig: () => { throw new Error("x"); } }).length, n);
});

test("every override is user-invocable-only", () => {
  const o = hs.supervisorSkillOverrides({ localConfig: () => ({ hidden: [] }) });
  assert.ok(Object.keys(o).length > 0);
  for (const v of Object.values(o)) assert.equal(v, "user-invocable-only");
});

function settingsBlock(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const start = src.indexOf("async startSession(");
  assert.ok(start >= 0, `startSession() not found in ${file}`);
  const body = src.slice(start, src.indexOf("new ClaudeSession(sessionOpts)", start));
  const line = body.split("\n").find((l) => l.trim().startsWith("settings:"));
  assert.ok(line, `${file} startSession() passes no settings option`);
  return line;
}

for (const file of ["agent/supervisor/index.mjs", "agent/supervisor/chat-supervisor.mjs"]) {
  test(`${path.basename(file)} hides unused skills unless the agent opts out`, () => {
    const block = settingsBlock(file);
    assert.match(block, /skillOverrides: supervisorSkillOverrides\(\)/);
    assert.match(block, /cfg\.hideUnusedSkills !== false/);
    assert.match(block, /idleCompaction: false/);
    assert.match(block, /hooks: gitGuardHooks\(\)/);
  });
}

test("skillOverrides reaches the claude argv inside the one --settings JSON", () => {
  const settings = JSON.stringify({ idleCompaction: false, skillOverrides: hs.supervisorSkillOverrides() });
  const sess = new ClaudeSession({ sessionId: "00000000-0000-4000-8000-000000000000", model: "m", cwd: ROOT, settings });
  const args = sess._buildArgs({ resume: false });
  assert.equal(args.filter((a) => a === "--settings").length, 1);
  const v = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.equal(v.skillOverrides["anthropic-skills:docx"], "user-invocable-only");
  assert.equal(v.idleCompaction, false);
});
