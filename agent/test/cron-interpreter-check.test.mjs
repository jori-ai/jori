// cron-interpreter-check.test.mjs — doctor check (8d2): will every script cron
// exec's DIRECTLY find its interpreter under cron's bare PATH?
//
// Run: node --test agent/test/cron-interpreter-check.test.mjs
//
// The filesystem is faked so these are deterministic on any host. The two
// headline cases are the real regressions: calendar-attendee-audit (failed
// silently every night until 2026-08-05) and hum-channel-audit (same shebang,
// fires once a year with no --label, so nothing would have noticed for 12
// months). The equally important cases are the NEGATIVES — the scripts that
// keep `#!/usr/bin/env node` safely because their crontab line names the
// interpreter explicitly. Flagging those would make the check noise.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mod from "../../lib/cron-interpreter-check.js";

const { findUnresolvableInterpreters } = mod;

const HOME = "/Users/example";
const G = `${HOME}/Dev/jori`;

// Fake fs: `files` maps path -> first line (shebang) for executables;
// `plain` are non-executable files (logs); `present` are bare existing paths.
function fakeFs({ exec = {}, plain = [], present = [] } = {}) {
  const existing = new Set([
    ...Object.keys(exec), ...plain, ...present,
    "/bin/bash", "/bin/sh", "/usr/bin/env", "/usr/bin/perl",
  ]);
  return {
    statSync(p) {
      if (Object.hasOwn(exec, p)) return { isFile: () => true, mode: 0o755 };
      if (plain.includes(p)) return { isFile: () => true, mode: 0o644 };
      if (existing.has(p)) return { isFile: () => true, mode: 0o644 };
      throw new Error(`ENOENT ${p}`);
    },
    readFileSync(p) {
      if (Object.hasOwn(exec, p)) return `${exec[p]}\n// body\n`;
      throw new Error(`ENOENT ${p}`);
    },
    existsSync: (p) => existing.has(p),
  };
}

const run = (lines, fsImpl) =>
  findUnresolvableInterpreters(lines, { homedir: HOME, fsImpl, repoMarker: "/jori/" });

describe("the two real regressions", () => {
  it("flags an env-node script cron exec's directly (calendar-attendee-audit)", () => {
    const f = fakeFs({ exec: { [`${G}/bin/calendar-attendee-audit`]: "#!/usr/bin/env node" } });
    const { bad } = run(
      [`17 5 * * * ${G}/bin/cron-run --label calendar-attendee-audit -- ${G}/bin/calendar-attendee-audit >> ${G}/agent/logs/x.log 2>&1`],
      f
    );
    assert.equal(bad.length, 1);
    assert.equal(bad[0].file, "calendar-attendee-audit");
    assert.match(bad[0].shebang, /env node/);
  });

  it("flags the once-a-year job that bypasses cron-run entirely (hum-channel-audit)", () => {
    // No `--label`, so it never reaches cron-runs.jsonl and the ledger check is
    // structurally blind to it. This static scan is the only thing that can see it.
    const f = fakeFs({ exec: { [`${G}/bin/hum-channel-audit`]: "#!/usr/bin/env node" } });
    const { bad } = run([`0 8 23 6 * ${G}/bin/hum-channel-audit --days 3 --compare --email`], f);
    assert.deepEqual(bad.map((b) => b.file), ["hum-channel-audit"]);
  });

  it("passes once the shebang is hardcoded (the actual fix)", () => {
    const f = fakeFs({
      exec: { [`${G}/bin/hum-channel-audit`]: "#!/opt/homebrew/bin/node" },
      present: ["/opt/homebrew/bin/node"],
    });
    const { bad } = run([`0 8 23 6 * ${G}/bin/hum-channel-audit --days 3`], f);
    assert.deepEqual(bad, []);
  });
});

describe("must NOT flag (else the check is noise)", () => {
  it("ignores a script whose crontab line names the interpreter explicitly", () => {
    // apns-token-cleanup/tmdb/resy keep `env node` safely for exactly this reason.
    const f = fakeFs({ exec: { [`${G}/bin/apns-token-cleanup`]: "#!/usr/bin/env node" } });
    const { bad, scanned } = run(
      [`0 4 * * * ${G}/bin/cron-run --label apns -- bash -c 'PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/node ${G}/bin/apns-token-cleanup >> ${G}/agent/logs/a.log 2>&1'`],
      f
    );
    assert.deepEqual(bad, [], "shebang is never consulted when node is named explicitly");
    assert.deepEqual(scanned, [], "and it should not even be scanned");
  });

  it("ignores /bin/bash-prefixed one-shots", () => {
    const f = fakeFs({ exec: { [`${G}/data/loop-mode-watch.sh`]: "#!/usr/bin/env node" } });
    const { bad } = run([`0 9 * * * /bin/bash ~/Dev/jori/data/loop-mode-watch.sh >/dev/null 2>&1`], f);
    assert.deepEqual(bad, []);
  });

  it("accepts env bash — bash IS on cron's bare PATH, unlike node", () => {
    const f = fakeFs({ exec: { [`${G}/bin/browsing-skills-sync`]: "#!/usr/bin/env bash" } });
    const { bad } = run([`0 10 * * * ${G}/bin/browsing-skills-sync`], f);
    assert.deepEqual(bad, [], "/bin/bash exists, so env resolves it");
  });

  it("accepts an absolute non-Homebrew interpreter", () => {
    const f = fakeFs({ exec: { [`${G}/bin/meeting-remind`]: "#!/bin/bash" } });
    const { bad } = run([`0 14 * * * ${G}/bin/meeting-remind pre "15:00"`], f);
    assert.deepEqual(bad, []);
  });

  it("does not treat a log redirect target as an exec", () => {
    const f = fakeFs({
      exec: { [`${G}/bin/ok-script`]: "#!/bin/bash" },
      plain: [`${G}/agent/logs/out.log`],
    });
    const { scanned } = run([`0 1 * * * ${G}/bin/ok-script >> ${G}/agent/logs/out.log 2>&1`], f);
    assert.deepEqual(scanned, [`${G}/bin/ok-script`]);
  });

  it("leaves a missing shebang to check 8d rather than double-reporting", () => {
    const f = fakeFs({ exec: { [`${G}/bin/no-shebang`]: "echo hi" } });
    const { bad } = run([`0 1 * * * ${G}/bin/no-shebang`], f);
    assert.deepEqual(bad, []);
  });

  it("ignores paths outside the repo", () => {
    const f = fakeFs({ exec: { "/usr/local/bin/other": "#!/usr/bin/env node" } });
    const { bad, scanned } = run([`0 1 * * * /usr/local/bin/other`], f);
    assert.deepEqual(bad, []);
    assert.deepEqual(scanned, []);
  });

  it("ignores a webhook curl line with no script exec at all", () => {
    const f = fakeFs({ present: [`${G}/secrets/webhook-token`] });
    const { bad } = run(
      [`*/5 * * * * TOKEN=$(cat ~/Dev/jori/secrets/webhook-token) && curl -s -X POST http://localhost:9092 -d '{"job":"x"}'`],
      f
    );
    assert.deepEqual(bad, []);
  });
});

// The third safe form: `PATH=/opt/homebrew/bin:$PATH /…/script`. receipt-scan
// and amazon-mail-orders run that way and exit 0 every morning, and this check
// called them unrunnable for two weeks. Four of these six are negatives — the
// point is to widen the check by exactly one shape and not one inch more.
describe("env-assignment prefixes", () => {
  const HB = "/opt/homebrew/bin";
  const envNode = (name) => fakeFs({
    exec: { [`${G}/bin/${name}`]: "#!/usr/bin/env node" },
    present: [`${HB}/node`],
  });

  it("does not flag a script whose line puts node back on PATH first (receipt-scan)", () => {
    const { bad } = run(
      [`0 6 * * * ${G}/bin/cron-run --label receipt-scan -- bash -c 'PATH=${HB}:$PATH ${G}/bin/receipt-scan --since 2026-08-25'`],
      envNode("receipt-scan")
    );
    assert.deepEqual(bad, []);
  });

  it("STILL flags when the assignment adds nothing absolute", () => {
    const { bad } = run([`0 6 * * * bash -c 'PATH=$PATH ${G}/bin/thing'`], envNode("thing"));
    assert.deepEqual(bad.map((b) => b.file), ["thing"], "$PATH is cron's own bare PATH");
  });

  it("STILL flags when the assignment is not adjacent to the script", () => {
    const { bad } = run([`0 6 * * * bash -c 'PATH=${HB}:$PATH && ${G}/bin/thing'`], envNode("thing"));
    assert.deepEqual(bad.map((b) => b.file), ["thing"], "&& breaks the assignment run");
  });

  it("STILL flags when the assignment comes AFTER the script", () => {
    const { bad } = run([`0 6 * * * ${G}/bin/thing PATH=${HB}`], envNode("thing"));
    assert.deepEqual(bad.map((b) => b.file), ["thing"], "an argument is not a prefix");
  });

  it("a non-PATH assignment rescues nothing", () => {
    const { bad } = run([`0 6 * * * bash -c 'TZ=UTC ${G}/bin/thing'`], envNode("thing"));
    assert.deepEqual(bad.map((b) => b.file), ["thing"]);
  });

  it("one line's PATH never vouches for the same script on a bare line, in either order", () => {
    const wrapped = `0 1 * * * bash -c 'PATH=${HB}:$PATH ${G}/bin/dual'`;
    const bare = `0 2 * * * ${G}/bin/dual`;
    for (const order of [[wrapped, bare], [bare, wrapped]]) {
      const { bad, scanned } = run(order, envNode("dual"));
      assert.deepEqual(bad.map((b) => b.file), ["dual"], `order ${order === undefined ? "" : ""}`);
      assert.equal(scanned.length, 1, "and it is counted once, not twice");
    }
  });
});

describe("mechanics", () => {
  it("expands ~/ so tilde entries are not silently skipped", () => {
    const f = fakeFs({ exec: { [`${G}/bin/tilde-job`]: "#!/usr/bin/env node" } });
    const { bad } = run([`0 3 * * * ~/Dev/jori/bin/tilde-job`], f);
    assert.deepEqual(bad.map((b) => b.file), ["tilde-job"], "a ~/ path must still be checked");
  });

  it("reports each script once even when several entries run it", () => {
    const f = fakeFs({ exec: { [`${G}/bin/dupe`]: "#!/usr/bin/env node" } });
    const { bad } = run([`0 1 * * * ${G}/bin/dupe`, `0 2 * * * ${G}/bin/dupe`], f);
    assert.equal(bad.length, 1);
  });

  it("checks against cron's PATH, not the caller's rich PATH", () => {
    // The whole point: doctor runs from a shell that CAN see /opt/homebrew/bin.
    // Resolving against that would call every broken script healthy.
    const f = fakeFs({
      exec: { [`${G}/bin/x`]: "#!/usr/bin/env node" },
      present: ["/opt/homebrew/bin/node"], // exists on the box, absent from cron's PATH
    });
    const { bad } = run([`0 1 * * * ${G}/bin/x`], f);
    assert.equal(bad.length, 1, "must still flag — cron cannot see /opt/homebrew/bin");
  });
});

// 2026-10-20: the verdict ignores the wrapper (above), but the report must not
// claim a script cron-run rescues exits 127 now. daily-summary-fix's hourly
// sweep runs `env node` under cron-run, exits 0 every hour, and doctor said 127.
// cron-run appends node's own directory to PATH, so only `env node` is rescued.
describe("wrapperRescued: runs today only because cron-run puts node on PATH", () => {
  const envFs = (name, interp = "node") => fakeFs({ exec: { [`${G}/bin/${name}`]: `#!/usr/bin/env ${interp}` } });
  const WRAPPED = `52 * * * * ${G}/bin/cron-run --label s -- bash -c '${G}/bin/sweep sweep >> /tmp/s.log 2>&1'`;
  const BARE = `0 3 * * * ${G}/bin/sweep`;

  it("is true for env node under cron-run, and the script is still flagged", () => {
    const { bad } = run([WRAPPED], envFs("sweep"));
    assert.deepEqual(bad, [{ file: "sweep", shebang: "#!/usr/bin/env node", wrapperRescued: true }]);
  });

  it("is false on a bare line (hum-channel-audit's shape)", () => {
    assert.equal(run([BARE], envFs("sweep")).bad[0].wrapperRescued, false);
  });

  it("is false for any other interpreter, even under cron-run", () => {
    assert.equal(run([WRAPPED], envFs("sweep", "deno")).bad[0].wrapperRescued, false);
  });

  it("is false when any line runs it bare, in either order, and it is reported once", () => {
    for (const order of [[WRAPPED, BARE], [BARE, WRAPPED]]) {
      const { bad } = run(order, envFs("sweep"));
      assert.equal(bad.length, 1);
      assert.equal(bad[0].wrapperRescued, false);
    }
  });

  it("counts cron-run behind a VAR=value prefix, and not a plain bash -c", () => {
    assert.equal(run([`0 1 * * * TZ=UTC ${G}/bin/cron-run -- ${G}/bin/sweep`], envFs("sweep")).bad[0].wrapperRescued, true);
    assert.equal(run([`0 1 * * * bash -c '${G}/bin/sweep'`], envFs("sweep")).bad[0].wrapperRescued, false);
  });
});
