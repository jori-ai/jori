import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.join(import.meta.dirname, "..", "bin", "trip-day-email-guard");

// Run the guard against an isolated HOME so the test never touches the real
// data/trip-day-email-sent.json state file.
function run(args, opts = {}) {
  try {
    const out = execFileSync(BIN, args, {
      encoding: "utf8",
      env: { ...process.env, HOME: opts.home, JORI_HOME: opts.home },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trip-day-email-guard-test-"));
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("check is clear when nothing has been recorded", () => {
  withTempHome((home) => {
    const r = run(["check", "--date", "2026-07-28", "--area", "old_town"], { home });
    assert.equal(r.code, 0);
    assert.match(r.out, /clear/);
  });
});

test("record then check within the window is BLOCKED", () => {
  withTempHome((home) => {
    const rec = run(["record", "--date", "2026-07-22", "--area", "harbour_town", "--message-id", "msg-abc"], { home });
    assert.equal(rec.code, 0);
    const chk = run(["check", "--date", "2026-07-22", "--area", "harbour_town"], { home });
    assert.equal(chk.code, 1);
    assert.match(chk.out, /BLOCKED/);
    assert.match(chk.out, /msg-abc/);
  });
});

test("check with --window-hours 0 always clears (explicit override)", () => {
  withTempHome((home) => {
    run(["record", "--date", "2026-07-22", "--area", "harbour_town"], { home });
    const chk = run(["check", "--date", "2026-07-22", "--area", "harbour_town", "--window-hours", "0"], { home });
    assert.equal(chk.code, 0);
  });
});

test("different area on the same date is independent", () => {
  withTempHome((home) => {
    run(["record", "--date", "2026-07-22", "--area", "harbour_town"], { home });
    const chk = run(["check", "--date", "2026-07-22", "--area", "old_town"], { home });
    assert.equal(chk.code, 0);
  });
});

test("re-recording the same date+area is idempotent (no error, updates timestamp)", () => {
  withTempHome((home) => {
    const first = run(["record", "--date", "2026-07-22", "--area", "harbour_town", "--message-id", "m1"], { home });
    assert.equal(first.code, 0);
    const second = run(["record", "--date", "2026-07-22", "--area", "harbour_town", "--message-id", "m2"], { home });
    assert.equal(second.code, 0);
    const list = run(["list", "--date", "2026-07-22", "--area", "harbour_town"], { home });
    const parsed = JSON.parse(list.out);
    assert.equal(parsed["2026-07-22::harbour_town"].message_id, "m2");
  });
});

test("missing --date or --area is a usage error (exit 64)", () => {
  withTempHome((home) => {
    const r1 = run(["check", "--area", "old_town"], { home });
    assert.equal(r1.code, 64);
    const r2 = run(["check", "--date", "2026-07-28"], { home });
    assert.equal(r2.code, 64);
    const r3 = run(["check", "--date", "not-a-date", "--area", "old_town"], { home });
    assert.equal(r3.code, 64);
  });
});
