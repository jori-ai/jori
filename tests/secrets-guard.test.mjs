// lib/secrets-guard.mjs — an agent reading the installation's secrets itself
// (docs/agent-secrets.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { findAccesses, runHook, protectedPath } from "../lib/secrets-guard.mjs";
import { gitGuardHooks } from "../lib/rollback-guard-settings.mjs";

const ROOT = "/srv/jori";
const HOME = "/Users/u";
const bash = (command, cwd = `${ROOT}/agent/ops-agent`) =>
  findAccesses({ tool_name: "Bash", tool_input: { command }, cwd }, { root: ROOT, home: HOME }).map((h) => h.kind);

test("direct reads of the secrets are found", () => {
  assert.deepEqual(bash("cat ../../.env"), ["dotenv"]);
  assert.deepEqual(bash(`grep PLAID ${ROOT}/.env.local`), ["dotenv"]);
  assert.deepEqual(bash('source "$JORI_HOME/.env"'), ["dotenv"]);
  assert.deepEqual(bash(`cd ${ROOT} && cat secrets/plaid.json`), ["secrets-dir"]);
  assert.deepEqual(bash(`ls ${ROOT}/credentials`), ["credentials-dir"]);
  assert.deepEqual(bash("cat ../../data/.supabase-oauth.json"), ["supabase-oauth-store"]);
  assert.deepEqual(bash("op item get example"), ["1password-cli"]);
  assert.deepEqual(bash("security find-generic-password -s icloud -w"), ["keychain-read"]);
  assert.deepEqual(bash("env"), ["env-dump"]);
  assert.deepEqual(bash("printenv | sort"), ["env-dump"]);
  assert.deepEqual(bash("export -p"), ["env-dump"]);
  assert.deepEqual(bash('bash -lc "cat ../../.env | head"'), ["dotenv"]);
  assert.deepEqual(bash("eval 'op item list'"), ["1password-cli"]);
  assert.deepEqual(bash("node x.js --env-file=../../.env"), ["dotenv"]);
});

test("ordinary work is not flagged", () => {
  for (const c of [
    "cat ../../.env.example", "cp .env.tpl /tmp/x", "env FOO=1 node bin/x", "git status",
    "bin/site-pass example.com", "bin/card-pass amazon", "bin/email-send --to me --subject hi --body-file /tmp/b",
    "ls ../../data", "grep -n secret lib/x.js", "echo $HOME", "security list-keychains",
  ]) assert.deepEqual(bash(c), [], c);
});

test("Read / Grep / Glob on a secrets path", () => {
  const f = (tool_name, tool_input) => findAccesses({ tool_name, tool_input, cwd: ROOT }, { root: ROOT, home: HOME }).map((h) => h.kind);
  assert.deepEqual(f("Read", { file_path: `${ROOT}/.env` }), ["dotenv"]);
  assert.deepEqual(f("Grep", { pattern: "TOKEN", path: `${ROOT}/secrets` }), ["secrets-dir"]);
  assert.deepEqual(f("Read", { file_path: `${ROOT}/README.md` }), []);
  assert.equal(protectedPath(`${HOME}/.config/op/config`, { cwd: ROOT, root: ROOT, home: HOME }), "1password-config");
});

test("log mode allows and logs names only; block mode refuses", () => {
  const lines = [];
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat .env && echo VALUE_MARKER_42" }, cwd: "/tmp/x" });
  const r = runHook(input, { mode: "log", log: (s) => lines.push(s) });
  assert.equal(r.code, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^LOGGED Bash in x :: dotenv:\.env$/);
  assert.doesNotMatch(lines[0], /VALUE_MARKER_42/); // the command line can carry a value: never logged
  const b = runHook(input, { mode: "block", log: () => {} });
  assert.equal(b.code, 2);
  assert.match(b.stderr, /secrets-guard: blocked/);
  assert.equal(runHook(input, { mode: "off", log: () => assert.fail("no log when off") }).code, 0);
  const dump = JSON.stringify({ tool_name: "Bash", tool_input: { command: "env | grep PATH" }, cwd: "/tmp/x" });
  const seen = [];
  assert.equal(runHook(dump, { mode: "block", log: (s) => seen.push(s) }).code, 0, "an env dump is logged, not blocked");
  assert.match(seen[0], /^LOGGED/);
  assert.equal(runHook("not json", { mode: "block" }).code, 0);
});

test("the session settings carry both guards", () => {
  const h = gitGuardHooks({ node: "/n", root: "/r" }).PreToolUse;
  assert.equal(h.length, 2);
  assert.equal(h[0].matcher, "Bash");
  assert.match(h[0].hooks[0].command, /rollback-guard/);
  assert.match(h[1].matcher, /Read/);
  assert.match(h[1].hooks[0].command, /secrets-guard/);
});

test("Claude Code's user config is a secrets file; the rest of ~/.claude is not", () => {
  const o = { cwd: ROOT, root: ROOT, home: HOME };
  assert.equal(protectedPath(`${HOME}/.claude.json`, o), "claude-config");
  assert.equal(protectedPath(`${HOME}/.claude.json.backup`, o), "claude-config");
  assert.equal(protectedPath(`${HOME}/.claude/backups/.claude.json.backup.1`, o), "claude-config");
  assert.equal(protectedPath(`${HOME}/.claude/settings.json`, o), null);
  assert.equal(protectedPath(`${ROOT}/.claude.json`, o), null);
  const hits = findAccesses({ tool_name: "Bash", cwd: ROOT, tool_input: { command: `jq .mcpServers ${HOME}/.claude.json` } }, { root: ROOT, home: HOME });
  assert.deepEqual(hits.map((h) => h.kind), ["claude-config"]);
});
