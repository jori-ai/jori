// lib/env-isolate.cjs — a long-running process moves its .env values out of
// its visible starting environment (docs/agent-secrets.md § 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { splitEnv } = require("../lib/env-isolate.cjs");

test("splitEnv moves exactly the names whose value .env gives back unchanged", () => {
  const dotenv = ['SECRET_A=abc', 'QUOTED="q v"', 'OVERRIDDEN=file', '# comment', 'export EXPORTED=e'].join("\n");
  const { env, moved } = splitEnv({ SECRET_A: "abc", QUOTED: "q v", OVERRIDDEN: "launchd", PATH: "/usr/bin", EXPORTED: "e" }, dotenv);
  assert.deepEqual(moved.sort(), ["EXPORTED", "QUOTED", "SECRET_A"]);
  assert.deepEqual(env, { OVERRIDDEN: "launchd", PATH: "/usr/bin" }, "an overridden value and a non-.env name stay");
});

function runChild(isolate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-isolate-"));
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(path.join(dir, "config", "agent-env.json"), JSON.stringify({ isolate }));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "PROBE_SECRET_TOKEN=s3cret\nPROBE_URL=http://x\n");
  const script = path.join(dir, "child.cjs");
  fs.writeFileSync(script, `
    const r = require(${JSON.stringify(path.join(ROOT, "lib/env-isolate.cjs"))}).isolateProcessEnv("probe", { envPath: ${JSON.stringify(envFile)}, log: () => {} });
    let names = null; // null: ps cannot see this process here (a sandbox)
    try { names = require("node:child_process").execFileSync("/bin/ps", ["eww", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\\s+/).filter((t) => /^[A-Z_][A-Z0-9_]*=/.test(t)).map((t) => t.split("=")[0]); } catch {}
    console.log(JSON.stringify({ r, pid: process.pid, argv: process.argv.slice(2), secret: process.env.PROBE_SECRET_TOKEN, url: process.env.PROBE_URL, visible: names && names.filter((n) => n.startsWith("PROBE_")) }));
  `);
  const r = spawnSync(process.execPath, [script, "serve", "--port", "1"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, JORI_LOCAL_DIR: dir, PROBE_SECRET_TOKEN: "s3cret", PROBE_URL: "http://x" },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  if (!r.stdout.trim()) throw new Error(`child printed nothing: ${String(r.stderr).slice(0, 400)}`);
  return { out: JSON.parse(r.stdout.trim().split("\n").pop()), pid: r.pid };
}

test("a listed process re-execs in place: same pid and argv, same process.env, no .env value visible", { skip: typeof process.execve !== "function" }, () => {
  const { out, pid } = runChild(["probe"]);
  assert.equal(out.pid, pid, "same pid");
  assert.deepEqual(out.argv, ["serve", "--port", "1"]);
  assert.equal(out.secret, "s3cret");
  assert.equal(out.url, "http://x");
  if (out.visible) assert.deepEqual(out.visible, [], "ps eww shows none of the .env values");
  assert.equal(out.r.why, "already");
});

test("a process the installation does not list is left alone", { skip: typeof process.execve !== "function" }, () => {
  const { out } = runChild([]);
  assert.equal(out.r.why, "not listed");
  if (out.visible) assert.deepEqual(out.visible.sort(), ["PROBE_SECRET_TOKEN", "PROBE_URL"]);
});
