// __NAME__: the command runs and reads its settings. Run: node --test plugins/__NAME__/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("__NAME__ --dry-run prints its result and reads local settings over the defaults", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "__NAME__-"));
  fs.mkdirSync(path.join(local, "config"));
  fs.writeFileSync(path.join(local, "config", "__NAME__.json"), JSON.stringify({ enabled_example: false }));
  const r = spawnSync(process.execPath, [path.join(DIR, "bin", "__NAME__"), "--dry-run"], { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: local } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dry, true);
  assert.equal(out.settings.enabled_example, false);
});
