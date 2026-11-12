// cron-run hands a cron child the Max subscription token (JORI_CRON_CLAUDE_TOKEN
// → CLAUDE_CODE_OAUTH_TOKEN) so its `claude -p` works without the keychain,
// but never under launchd, where the keychain login stays in charge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CRON_RUN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/cron-run");
const probe = `console.log(JSON.stringify({ t: process.env.CLAUDE_CODE_OAUTH_TOKEN || null, raw: process.env.JORI_CRON_CLAUDE_TOKEN || null }))`;

function run(env) {
  const home = mkdtempSync(join(tmpdir(), "cron-run-home-"));
  mkdirSync(join(home, "Dev/jori/data"), { recursive: true });
  const r = spawnSync(process.execPath, [CRON_RUN, "--label", "t", "--", process.execPath, "-e", probe],
    { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin", ...env } });
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("under cron the child gets the token as CLAUDE_CODE_OAUTH_TOKEN", () => {
  assert.deepEqual(run({ JORI_CRON_CLAUDE_TOKEN: "tok" }), { t: "tok", raw: null });
});

test("under launchd the keychain stays in charge", () => {
  assert.deepEqual(run({ JORI_CRON_CLAUDE_TOKEN: "tok", XPC_SERVICE_NAME: "ai.claude.x" }), { t: null, raw: null });
});

test("no token configured: nothing set", () => {
  assert.deepEqual(run({}), { t: null, raw: null });
});
