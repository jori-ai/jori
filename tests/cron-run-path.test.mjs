// cron-run PATH repair — a cron child must be able to resolve `node`.
//
// Paths are derived from import.meta.url, never from $HOME: pinned to $HOME a
// test running inside a git worktree silently exercises the MAIN checkout, so a
// change can pass its own tests without ever having been executed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CRON_RUN = resolve(HERE, "../bin/cron-run");
const CRON_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"; // what cron actually hands a child
const INTERP_DIR = dirname(process.execPath);

// Run cron-run with a controlled environment. HOME is redirected at a temp dir
// so the wrapper's own cron-runs.jsonl append never touches the real log.
function runCronRun(argv, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "cron-run-home-"));
  mkdirSync(join(home, "Dev/jori/data"), { recursive: true });
  return spawnSync(process.execPath, [CRON_RUN, ...argv], {
    encoding: "utf8",
    env: { HOME: home, PATH: CRON_PATH, ...env },
  });
}

// A script with the exact shebang that dies under cron today.
function envNodeScript(body) {
  const dir = mkdtempSync(join(tmpdir(), "cron-run-script-"));
  const f = join(dir, "probe");
  writeFileSync(f, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

describe("cron-run: child PATH", () => {
  test("a `#!/usr/bin/env node` child runs under cron's PATH (the exit-127 class)", () => {
    const probe = envNodeScript('console.log("RAN_OK");');
    const r = runCronRun(["--label", "probe-test", "--", probe]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stdout, /RAN_OK/);
  });

  test("the interpreter dir is APPENDED, so no existing resolution changes", () => {
    // The child prints where it resolves a binary that exists in BOTH cron's
    // PATH and the homebrew dir. It must still be the cron-PATH one.
    const probe = envNodeScript('console.log("PATH=" + process.env.PATH);');
    const r = runCronRun(["--", probe]);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const path = /PATH=(.*)/.exec(r.stdout)[1];
    assert.ok(path.startsWith(CRON_PATH), `cron's entries must stay first, got: ${path}`);
    // The exact-string equality IS the append-vs-prepend proof: a prepend would
    // produce `${INTERP_DIR}:${CRON_PATH}` and fail here. (An earlier version of
    // this test also asserted that `which python3` still resolved outside
    // INTERP_DIR; that was vacuous, because INTERP_DIR is the version-pinned
    // Cellar bin and contains only node/npm/npx — python3 could never be there.)
    assert.equal(path, `${CRON_PATH}:${INTERP_DIR}`);
  });

  test("idempotent — already-present interpreter dir is not duplicated", () => {
    const probe = envNodeScript('console.log("PATH=" + process.env.PATH);');
    const r = runCronRun(["--", probe], { PATH: `${INTERP_DIR}:${CRON_PATH}` });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const path = /PATH=(.*)/.exec(r.stdout)[1];
    assert.equal(path, `${INTERP_DIR}:${CRON_PATH}`, "must be left untouched");
    assert.equal(path.split(":").filter((p) => p === INTERP_DIR).length, 1);
  });

  test("an empty PATH is left alone rather than replaced", () => {
    // Appending to nothing would REPLACE the system default resolution path.
    // Invoke by absolute interpreter so the child can start with no PATH at all.
    const dir = mkdtempSync(join(tmpdir(), "cron-run-script-"));
    const f = join(dir, "probe.js");
    writeFileSync(f, 'console.log("PATH=[" + (process.env.PATH ?? "") + "]");');
    const r = runCronRun(["--", process.execPath, f], { PATH: "" });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /PATH=\[\]/);
  });

  test("the child's exit code is still propagated", () => {
    const probe = envNodeScript("process.exit(3);");
    const r = runCronRun(["--", probe]);
    assert.equal(r.status, 3);
  });
});
