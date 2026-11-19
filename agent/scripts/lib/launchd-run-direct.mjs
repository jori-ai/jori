#!/usr/bin/env node
// launchd-run-direct.mjs — run an on-demand launchd agent's program without
// launchd, for hosts that have none (Linux).
//
// On macOS a scripted job's cron line hands its run to an on-demand launchd
// agent (lib/launchd-kick.sh), only because the Claude credential sits in the
// login keychain, which cron can't open. Linux has no keychain and no
// launchd: Claude Code keeps its login in a file cron can read, so the job
// can run straight from cron. This reads the rendered plist on stdin and
// starts its ProgramArguments the way launchd would: same environment
// additions, working directory and log files, detached, and at most one
// copy at a time (like `launchctl kickstart` without -k: a second kick while
// a run is going is a no-op).
//
// Usage (from launchd-kick.sh):
//   launchd_render_plist <plist> - | node launchd-run-direct.mjs <label> <locks-dir>
// Exit 0 when started or already running; 1 when the plist has no program.
// Test: tests/launchd-run-direct.test.mjs.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const unxml = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, "&");

/** The parts of a launchd plist this runner needs. Only flat values, as the kernel's on-demand agents use. */
export function parsePlist(xml) {
  const body = String(xml || "").replace(/<!--[\s\S]*?-->/g, ""); // lang-regex-ok: XML comment syntax
  const after = (key) => {
    const i = body.indexOf(`<key>${key}</key>`);
    return i < 0 ? null : body.slice(i + key.length + 11);
  };
  const strings = (block) => [...block.matchAll(/<string>([\s\S]*?)<\/string>|<string\/>/g)].map((m) => unxml(m[1] ?? "")); // lang-regex-ok: plist syntax
  const out = { args: [], env: {}, cwd: null, stdout: null, stderr: null };
  const a = after("ProgramArguments");
  if (a) {
    const m = a.match(/^\s*<array>([\s\S]*?)<\/array>/); // lang-regex-ok: plist syntax
    if (m) out.args = strings(m[1]);
  }
  const e = after("EnvironmentVariables");
  if (e) {
    const m = e.match(/^\s*<dict>([\s\S]*?)<\/dict>/); // lang-regex-ok: plist syntax
    if (m) for (const kv of m[1].matchAll(/<key>([\s\S]*?)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|<string\/>)/g)) out.env[unxml(kv[1])] = unxml(kv[2] ?? ""); // lang-regex-ok: plist syntax
  }
  const one = (key) => {
    const s = after(key);
    const m = s && s.match(/^\s*<string>([\s\S]*?)<\/string>/); // lang-regex-ok: plist syntax
    return m ? unxml(m[1]) : null;
  };
  out.cwd = one("WorkingDirectory");
  out.stdout = one("StandardOutPath");
  out.stderr = one("StandardErrorPath");
  return out;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Start the program unless a run started by this runner is still going. Returns "started" | "running". */
export function runDirect(plist, { label, locksDir, spawnFn = spawn, env = process.env } = {}) {
  if (!plist.args.length) throw new Error(`${label}: the plist has no ProgramArguments`);
  fs.mkdirSync(locksDir, { recursive: true });
  const pidFile = path.join(locksDir, `${label}.pid`);
  let prior = NaN;
  try { prior = Number(fs.readFileSync(pidFile, "utf8").trim()); } catch { /* none yet */ }
  if (alive(prior)) return "running";
  const open = (f) => {
    if (!f) return "ignore";
    fs.mkdirSync(path.dirname(f), { recursive: true });
    return fs.openSync(f, "a");
  };
  const outFd = open(plist.stdout);
  const errFd = plist.stderr && plist.stderr === plist.stdout ? outFd : open(plist.stderr);
  const child = spawnFn(plist.args[0], plist.args.slice(1), {
    cwd: plist.cwd && fs.existsSync(plist.cwd) ? plist.cwd : undefined,
    env: { ...env, ...plist.env },
    detached: true,
    stdio: ["ignore", outFd, errFd],
  });
  fs.writeFileSync(pidFile, `${child.pid}\n`);
  child.unref?.();
  return "started";
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const [label, locksDir] = process.argv.slice(2);
  if (!label || !locksDir) {
    console.error("usage: launchd-run-direct.mjs <label> <locks-dir>  (plist on stdin)");
    process.exit(2);
  }
  try {
    const state = runDirect(parsePlist(fs.readFileSync(0, "utf8")), { label, locksDir });
    console.log(state);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
