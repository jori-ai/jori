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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
