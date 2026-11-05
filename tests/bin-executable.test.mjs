// Every script in bin must be executable — enforced, not remembered.
//
// The recurring defect: a Face-ID self-improve apply (and any other path that
// writes a new file programmatically) creates it mode 0644. A `bin`
// script without the exec bit is broken in exactly the way that hides — it
// still gets committed, still passes review, still works for any caller that
// happens to invoke it as `node <path>`, and fails only for the direct
// `bin/foo` invocation its own playbook documents.
//
// It has been "fixed" twice per-file — daily-summary-lock and
// self-improve-approval-poll — and recurred both times, because
// chmod-ing the one file that broke does nothing about the next one. On
// 2026-07-29 a full sweep found TEN non-executable scripts, one of which
// (trip-day-email-guard) had been silently failing its whole test file since
// it was added on 2026-07-28.
//
// So this is a guard, not a note. Same reasoning as the pre-commit hook for
// `git add -A` and the fabricated-outage gate in jori-send-curl: when prose
// has demonstrably not held, make it mechanical.
//
// The rule: a file under bin whose first bytes are a shebang is a
// program, and a program must be executable — in the GIT INDEX, not merely in
// someone's working tree, since the mode is what ships to the mini. Data files
// (package.json, .json, .md) carry no shebang and are correctly 0644, so they
// need no allowlist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO, "bin");

function hasShebang(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(2);
    const n = fs.readSync(fd, buf, 0, 2, 0);
    return n === 2 && buf[0] === 0x23 && buf[1] === 0x21; // "#!"
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Mode as git has it staged — the thing that actually ships.
function indexModes() {
  const out = execFileSync("git", ["ls-files", "-s", "bin"], {
    cwd: REPO, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  const modes = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // "<mode> <sha> <stage>\t<path>"
    const [meta, file] = line.split("\t");
    if (!file) continue;
    modes.set(file, meta.split(" ")[0]);
  }
  return modes;
}

test("every shebang script in bin is executable in the git index", () => {
  const modes = indexModes();
  const offenders = [];
  for (const [file, mode] of modes) {
    const abs = path.join(REPO, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    if (!hasShebang(abs)) continue;
    if (mode !== "100755") offenders.push(`${file} (mode ${mode})`);
  }
  assert.deepEqual(
    offenders, [],
    `These bin scripts have a shebang but are not executable, so a direct ` +
    `\`bin/<name>\` invocation fails. Fix with:\n` +
    `  chmod +x ${offenders.map((o) => o.split(" ")[0]).join(" ")}\n` +
    `and commit the mode change.`,
  );
});

test("every executable in bin actually has a shebang", () => {
  // The converse: an 0755 file with no shebang is either a stray binary or a
  // data file that got the bit by accident. Both are worth knowing about —
  // the kernel would try to run it as a shell script.
  const modes = indexModes();
  const offenders = [];
  for (const [file, mode] of modes) {
    if (mode !== "100755") continue;
    const abs = path.join(REPO, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    if (!hasShebang(abs)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "executable files in bin without a shebang");
});

test("the guard can actually see the bin directory", () => {
  // Cheap canary: if the path resolution or `git ls-files` ever breaks, both
  // tests above would pass vacuously on an empty set.
  const modes = indexModes();
  assert.ok(modes.size > 50, `expected many tracked files under bin, saw ${modes.size}`);
  assert.ok(fs.existsSync(BIN), "bin should exist");
});

// The Supabase MCP server reads its token from the environment once, at spawn.
// Every MCP config starts it through bin/supabase-mcp, which hands it a current
// token (bin/supabase-token's OAuth app, else the environment's own), and
// bin/mcp-manifest-check fails on a config that starts it directly.
{
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const CHECK = path.join(REPO, "bin/mcp-manifest-check");
  const SHIPPED = [
    "agent/supervisor/chat-mcp-config.json",
    "agent/ops-light-agent/.mcp.json",
    "agent/ops-haiku-agent/.mcp.json",
    "examples/mcp/ops-agent.mcp.example.json",
  ];
  const DIRECT = {
    command: "npx",
    args: ["-y", "@supabase/mcp-server-supabase@latest", "--project-ref=${JORI_SUPABASE_PROJECT}"],
    env: { SUPABASE_ACCESS_TOKEN: "${SUPABASE_ACCESS_TOKEN}" },
  };

  // An installation root holding only what the check reads: the shipped MCP
  // configs, an empty job routing, a local dir, and the kernel lib it loads.
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-mcp-launch-"));
    fs.symlinkSync(path.join(REPO, "lib"), path.join(root, "lib"));
    const write = (rel, obj) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
    };
    write("agent/config/job-routing.json", { jobs: {} });
    fs.mkdirSync(path.join(root, "agent/local"), { recursive: true });
    for (const rel of SHIPPED) write(rel, fs.readFileSync(path.join(REPO, rel), "utf8"));
    return { root, write };
  }

  function check(root, ...args) {
    const r = spawnSync(process.execPath, [CHECK, ...args], {
      encoding: "utf8",
      env: { ...process.env, JORI_HOME: root, JORI_LOCAL_DIR: path.join(root, "agent/local"), JORI_NO_PLUGINS: "1" },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  }

  test("the shipped MCP configs start the Supabase server through bin/supabase-mcp", () => {
    for (const rel of SHIPPED) {
      const servers = JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8")).mcpServers;
      const supa = Object.entries(servers).filter(([, s]) => /supabase/.test(`${s.command} ${(s.args || []).join(" ")}`)); // lang-regex-ok: a command line
      assert.ok(supa.length, `${rel} has a Supabase server`);
      for (const [name, s] of supa) {
        assert.equal(s.command, "${JORI_HOME}/bin/supabase-mcp", `${rel} ${name}`);
        assert.ok(!s.env?.SUPABASE_ACCESS_TOKEN, `${rel} ${name} must not pin the environment's token`);
      }
    }
    const { root } = fixture();
    const r = check(root);
    assert.equal(r.code, 0, r.out);
  });

  test("a config that starts @supabase/mcp-server-supabase directly is a hard error", () => {
    const { root, write } = fixture();
    write("agent/ops-agent/.mcp.json", { mcpServers: { "supabase-x": DIRECT } });
    const r = check(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /agent\/ops-agent\/\.mcp\.json: "supabase-x" starts @supabase\/mcp-server-supabase directly/); // lang-regex-ok: the check's own output
    const j = JSON.parse(check(root, "--json").out);
    assert.equal(j.hard_errors.length, 1);
  });

  test("the agent dir's own config and the installation's local MCP configs are checked too", () => {
    const { root, write } = fixture();
    write("agent/.mcp.json", { mcpServers: { db: DIRECT } });
    write("agent/local/mcp/chat-mcp-config.json", { mcpServers: { other: { command: "npx", args: ["-y", "@supabase/mcp-server-supabase@0.15.0"] } } });
    const j = JSON.parse(check(root, "--json").out);
    assert.deepEqual(j.hard_errors.map((e) => e.split(":")[0]).sort(), ["agent/.mcp.json", "agent/local/mcp/chat-mcp-config.json"]);
  });

  // The wrapper, with node and a stand-in npx that reports what it was given.
  function wrapper(env) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-mcp-bin-"));
    fs.symlinkSync(process.execPath, path.join(dir, "node"));
    fs.writeFileSync(path.join(dir, "npx"), '#!/bin/sh\necho "token=$SUPABASE_ACCESS_TOKEN args=$*"\n', { mode: 0o755 });
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-mcp-local-"));
    const base = { ...process.env, JORI_NODE: path.join(dir, "node"), JORI_LOCAL_DIR: local };
    delete base.SUPABASE_OAUTH_CLIENT_ID;
    delete base.SUPABASE_ACCESS_TOKEN;
    const r = spawnSync(path.join(REPO, "bin/supabase-mcp"), ["--project-ref=abc"], { encoding: "utf8", env: { ...base, ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  test("without an OAuth app the wrapper passes the environment's token through", () => {
    const r = wrapper({ SUPABASE_ACCESS_TOKEN: "env-token" });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "token=env-token args=-y @supabase/mcp-server-supabase@latest --project-ref=abc");
  });

  test("with no OAuth app and no token the wrapper refuses to start the server", () => {
    const r = wrapper({});
    assert.equal(r.code, 1);
    assert.equal(r.out, "", "the server is not started");
    assert.match(r.err, /no token/); // lang-regex-ok: the wrapper's own error line
  });

  test("supabase-token --configured says whether an OAuth app is configured, offline", () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-token-local-"));
    const run = (env) => {
      const e = { ...process.env, JORI_LOCAL_DIR: local, ...env };
      if (!("SUPABASE_OAUTH_CLIENT_ID" in env)) delete e.SUPABASE_OAUTH_CLIENT_ID;
      return spawnSync(process.execPath, [path.join(REPO, "bin/supabase-token"), "--configured"], { encoding: "utf8", env: e });
    };
    assert.equal(run({}).status, 1);
    assert.equal(run({ SUPABASE_OAUTH_CLIENT_ID: "00000000-0000-0000-0000-000000000000" }).status, 0);
    fs.mkdirSync(path.join(local, "supabase-oauth"));
    fs.writeFileSync(path.join(local, "supabase-oauth/app.json"), JSON.stringify({ client_id: "00000000-0000-0000-0000-000000000000" }));
    const r = run({});
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", "prints nothing");
  });
}
