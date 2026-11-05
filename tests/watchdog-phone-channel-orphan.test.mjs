// watchdog-phone-channel-orphan.test.mjs — pins the orphan reaping in the
// duplicate-phone-channel probe of agent/scripts/watchdog.sh.
//
// History: when the turn watchdog SIGKILLs a hung chat `claude -p`, its
// phone-channel MCP child is re-parented to launchd (ppid 1) and lingers as a
// second Supabase subscriber — long enough that chat is effectively down
// beside the replacement session, while the probe paged the operator to "kill
// the non-supervisor one" by hand. The probe now SIGTERMs (then SIGKILLs) a ppid-1
// phone-channel itself — but ONLY when a live-parented one is positively seen —
// and pages only about duplicates that are still live-parented.
//
// The probe block is extracted from watchdog.sh and run in real bash with
// `ps`, `pgrep` and `kill` replaced by shell functions (functions shadow both
// builtins and PATH binaries), so nothing is ever signalled: every kill is
// RECORDED, never sent. notify/log/incident_should_alert/incident_clear are
// recorders too; incident_seen is the real one, against a scratch dir.
//
// Run: node --test tests/watchdog-phone-channel-orphan.test.mjs
// Against a proposed copy:
//   WATCHDOG_SH=/tmp/pc/watchdog.sh node --test tests/watchdog-phone-channel-orphan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "../lib/root.cjs";
const WATCHDOG =
  process.env.WATCHDOG_SH ||
  path.join(REPO_ROOT, "agent/scripts/watchdog.sh");
const SRC = fs.readFileSync(WATCHDOG, "utf8");

const GRACE_OLD = "1:00:00"; // 3600s — well past the 300s handover grace
const ORPHAN_FILE = "phone-channel-duplicate.orphans_termed";

function fnBody(name) {
  const start = SRC.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} must be defined in watchdog.sh`);
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} must be a closed function body`);
  return SRC.slice(start, end + 3);
}

/** From the _etime_secs helper through the end of the duplicate-probe if/else. */
function probeBlock() {
  const start = SRC.indexOf("_etime_secs() {");
  assert.notEqual(start, -1, "_etime_secs must be defined in watchdog.sh");
  const tail = 'incident_clear "phone-channel-duplicate"\nfi\n';
  const end = SRC.indexOf(tail, start);
  assert.notEqual(end, -1, "duplicate-phone-channel block must end with incident_clear + fi");
  return SRC.slice(start, end + tail.length);
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * procs: [{ pid, ppid (string | null = unreadable), etime }]
 * Runs ONE watchdog tick against `dir` (persisting incident state across
 * ticks) and returns the recorded side effects as lines.
 */
function tick(dir, procs) {
  const rec = path.join(dir, "rec.log");
  fs.writeFileSync(rec, "");
  const psCases = [];
  for (const p of procs) {
    if (p.ppid !== null) psCases.push(`    ${shq(`ppid=:${p.pid}`)}) printf '%s\\n' ${shq(p.ppid)} ;;`);
    psCases.push(`    ${shq(`etime=:${p.pid}`)}) printf '%s\\n' ${shq(p.etime)} ;;`);
  }
  const pgrepOut = procs.map((p) => p.pid).join("\n");
  const script = `
REC=${shq(rec)}
INCIDENT_DIR=${shq(dir)}
ISSUES=""
log() { printf 'LOG %s\\n' "$1" >> "$REC"; }
notify() { printf 'NOTIFY %s\\n' "$1" >> "$REC"; }
incident_should_alert() { printf 'SHOULD_ALERT %s\\n' "$1" >> "$REC"; return 0; }
incident_clear() { printf 'CLEAR %s\\n' "$1" >> "$REC"; }
kill() { printf 'SIGNAL %s\\n' "$*" >> "$REC"; return 0; }
pgrep() { ${pgrepOut ? `printf '%s\\n' ${procs.map((p) => p.pid).join(" ")}` : "return 1"}; }
ps() {
  case "$2:$4" in
${psCases.join("\n")}
    *) return 1 ;;
  esac
}
${fnBody("incident_seen")}
${probeBlock()}
`;
  execFileSync("bash", ["-c", script], { encoding: "utf8" });
  return fs.readFileSync(rec, "utf8").split("\n").filter(Boolean);
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wd-pc-orphan-"));
}
const signals = (lines) => lines.filter((l) => l.startsWith("SIGNAL "));
const notifies = (lines) => lines.filter((l) => l.startsWith("NOTIFY "));
const clears = (lines) => lines.filter((l) => l.startsWith("CLEAR "));

test("(a) one live + one orphan: the orphan gets SIGTERM, no page, no clear", () => {
  const dir = scratch();
  try {
    const out = tick(dir, [
      { pid: 5001, ppid: "4242", etime: "00:40" }, // replacement session's child
      { pid: 4001, ppid: "1", etime: "06:10" }, // left behind by the SIGKILLed claude
    ]);
    assert.deepEqual(signals(out), ["SIGNAL -TERM 4001"]);
    assert.deepEqual(notifies(out), []);
    assert.deepEqual(clears(out), [], "incident_clear waits for a tick where pgrep counts one");
    assert.ok(
      out.some((l) => /orphaned phone-channel 4001 \(ppid 1, up 370s\).*the live one is 5001/.test(l)),
      `expected the orphan log line, got:\n${out.join("\n")}`,
    );
    assert.equal(fs.readFileSync(path.join(dir, ORPHAN_FILE), "utf8"), "pid 4001\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(b) two LIVE-parented duplicates past grace still page exactly as before", () => {
  const dir = scratch();
  try {
    const procs = [
      { pid: 5001, ppid: "4242", etime: GRACE_OLD },
      { pid: 7001, ppid: "6100", etime: GRACE_OLD }, // e.g. a stray desktop MCP entry
    ];
    const t1 = tick(dir, procs);
    assert.deepEqual(signals(t1), []);
    assert.deepEqual(notifies(t1), [], "first tick is debounced (ATTEMPT 1)");
    const t2 = tick(dir, procs);
    assert.deepEqual(signals(t2), [], "a live-parented phone-channel is never signalled");
    assert.equal(notifies(t2).length, 1);
    assert.match(notifies(t2)[0], /2 phone-channel processes running \(expected 1\) for 2 consecutive ticks/);
    assert.match(notifies(t2)[0], /Kill the non-supervisor one/);
    assert.ok(!fs.existsSync(path.join(dir, ORPHAN_FILE)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(c) all orphans: nothing is killed, today's behaviour is unchanged", () => {
  const dir = scratch();
  try {
    const procs = [
      { pid: 4001, ppid: "1", etime: GRACE_OLD },
      { pid: 4002, ppid: "1", etime: GRACE_OLD },
    ];
    const t1 = tick(dir, procs);
    const t2 = tick(dir, procs);
    assert.deepEqual(signals(t1), []);
    assert.deepEqual(signals(t2), []);
    assert.equal(notifies(t2).length, 1, "with no live instance seen, it falls through to the old page");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(d) an unreadable ppid is never killed and never counts as the live one", () => {
  const dir = scratch();
  try {
    // orphan + unknown: no positively-live instance, so the orphan is spared too.
    const t1 = tick(dir, [
      { pid: 4001, ppid: "1", etime: GRACE_OLD },
      { pid: 5001, ppid: null, etime: GRACE_OLD },
    ]);
    assert.deepEqual(signals(t1), []);
    // live + unknown: no orphan, nothing to reap.
    const dir2 = scratch();
    try {
      const t2 = tick(dir2, [
        { pid: 5001, ppid: "4242", etime: GRACE_OLD },
        { pid: 5002, ppid: "garbage", etime: GRACE_OLD },
      ]);
      assert.deepEqual(signals(t2), []);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(d2) live + orphan + unknown: only the orphan goes, the unknown stays in the paging set", () => {
  const dir = scratch();
  try {
    const procs = [
      { pid: 5001, ppid: "4242", etime: GRACE_OLD },
      { pid: 4001, ppid: "1", etime: GRACE_OLD },
      { pid: 5002, ppid: null, etime: GRACE_OLD },
    ];
    const t1 = tick(dir, procs);
    assert.deepEqual(signals(t1), ["SIGNAL -TERM 4001"]);
    const t2 = tick(dir, procs);
    assert.deepEqual(signals(t2), ["SIGNAL -KILL 4001"]);
    assert.equal(notifies(t2).length, 1, "two non-orphans past grace remain a duplicate worth paging");
    assert.match(notifies(t2)[0], /^NOTIFY ⚠️ 2 phone-channel processes running/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(e) an orphan still present on the next tick escalates to SIGKILL, still no page", () => {
  const dir = scratch();
  try {
    // Both past grace and ATTEMPT reaches 2 on tick 2 — without the reaping
    // this exact shape paged the operator.
    const procs = [
      { pid: 5001, ppid: "4242", etime: GRACE_OLD },
      { pid: 4001, ppid: "1", etime: GRACE_OLD },
    ];
    const t1 = tick(dir, procs);
    assert.deepEqual(signals(t1), ["SIGNAL -TERM 4001"]);
    const t2 = tick(dir, procs);
    assert.deepEqual(signals(t2), ["SIGNAL -KILL 4001"]);
    assert.deepEqual(notifies(t2), []);
    assert.ok(t2.some((l) => /4001 survived SIGTERM/.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("orphan state is dropped once the duplicate clears, so a later orphan starts at SIGTERM", () => {
  const dir = scratch();
  try {
    const live = { pid: 5001, ppid: "4242", etime: GRACE_OLD };
    const orphan = { pid: 4001, ppid: "1", etime: GRACE_OLD };
    tick(dir, [live, orphan]);
    assert.ok(fs.existsSync(path.join(dir, ORPHAN_FILE)));
    const t2 = tick(dir, [live]);
    assert.deepEqual(clears(t2), ["CLEAR phone-channel-duplicate"]);
    assert.ok(!fs.existsSync(path.join(dir, ORPHAN_FILE)));
    const t3 = tick(dir, [live, orphan]);
    assert.deepEqual(signals(t3), ["SIGNAL -TERM 4001"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every signal in the block is aimed at a pid re-checked to have ppid 1", () => {
  const block = probeBlock();
  const kills = block.match(/^\s*kill\s.*$/gm) || [];
  assert.equal(kills.length, 2, `expected exactly the TERM and KILL calls, got:\n${kills.join("\n")}`);
  for (const k of kills) assert.match(k, /kill -(TERM|KILL) "\$_pco_pid"/);
  const recheck = block.indexOf('[ "$(_pc_ppid "$_pco_pid")" = "1" ] || continue');
  assert.ok(recheck !== -1, "the ppid must be re-read right before signalling");
  assert.ok(recheck < block.indexOf("kill -TERM"), "re-check must precede the signal");
});

// ── Chat message delivery check + phone-channel heartbeat check ─────────────
// THE GAPS THESE CLOSE:
//   - The delivery query wrote its cutoff as "…+00:00" unencoded. A query string
//     reads "+" as a space, PostgREST answered 400, `curl -sf` printed nothing and
//     the check counted 0: it never fired.
//   - It asked for read=false user rows, but `read` is the app's display flag and
//     most user rows keep it false forever, so a working query would have paged
//     on history. Delivery is now measured from the phone-channel's own cursor.
//   - A phone-channel that never sent a heartbeat reported a null age, which the
//     watchdog read as 0, healthy.
// Behavioral cases run the real delivery section in bash, through the real
// incident_* / notify machinery, with `curl` replaced by a stub that answers like
// PostgREST (a malformed timestamp is a 400, so `curl -sf` prints nothing).
// Nothing touches the real machine.
{
  const SECTION_HEADER = "# --- Chat message delivery check";
  const NEXT_HEADER = "# --- Cloudflare Tunnel (Gmail-push ingress) health ---";

  function fnSrc(name) {
    const start = SRC.indexOf(`\n${name}() {`);
    assert.notEqual(start, -1, `${name} must be defined in watchdog.sh`);
    const end = SRC.indexOf("\n}\n", start);
    assert.notEqual(end, -1, `${name} must be a closed function body`);
    return SRC.slice(start + 1, end + 3);
  }

  function sectionSrc() {
    const start = SRC.indexOf(SECTION_HEADER);
    assert.notEqual(start, -1, `expected a "${SECTION_HEADER}" section in watchdog.sh`);
    const end = SRC.indexOf(NEXT_HEADER, start);
    assert.notEqual(end, -1, "the delivery section must end before the Cloudflare Tunnel section");
    return SRC.slice(start, end);
  }

  function findJq() {
    for (const p of ["/usr/bin/jq", "/opt/homebrew/bin/jq", "/usr/local/bin/jq"]) if (fs.existsSync(p)) return p;
    try { return execFileSync("bash", ["-c", "command -v jq"], { encoding: "utf8" }).trim() || null; } catch { return null; }
  }
  const JQ = findJq();
  const needJq = JQ ? {} : { skip: "jq not installed" };

  const MIN = 60_000;
  const iso = (ms) => new Date(ms).toISOString();
  // The cursor's own form: Postgres timestamptz as PostgREST returns it.
  const pgTs = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");

  // ---- stub harness --------------------------------------------------------

  // A PostgREST stand-in: filters the fixture rows by the query the section sent.
  // URLSearchParams decodes the way a server does ("+" → space, %2B → "+"), and a
  // timestamp that is not ISO-8601 is a 400 (exit 22, nothing printed, as curl -sf).
  const FAKE_PGRST = `
import fs from "node:fs";
const url = new URL(process.argv[2]);
if (process.env.FAKE_PGRST_DOWN === "1") process.exit(22);
const TS = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$/;
let rows = JSON.parse(fs.readFileSync(process.env.FAKE_ROWS, "utf8"));
let limit = Infinity;
for (const [k, v] of url.searchParams) {
  const dot = v.indexOf(".");
  const op = v.slice(0, dot), val = v.slice(dot + 1);
  if (k === "select" || k === "order") continue;
  if (k === "limit") { limit = Number(v); continue; }
  if (k === "role" && op === "eq") { rows = rows.filter((r) => r.role === val); continue; }
  if (k === "read" && op === "eq") { rows = rows.filter((r) => String(r.read) === val); continue; }
  if (k === "created_at" && (op === "gt" || op === "lt")) {
    if (!TS.test(val)) process.exit(22);
    const t = Date.parse(val);
    rows = rows.filter((r) => (op === "gt" ? Date.parse(r.created_at) > t : Date.parse(r.created_at) < t));
    continue;
  }
  process.exit(22);
}
rows.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
process.stdout.write(JSON.stringify(rows.slice(0, limit).map((r) => ({ id: r.id, created_at: r.created_at }))));
`;

  function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wd-chat-delivery-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, "Dev/jori/data"), { recursive: true });
    fs.writeFileSync(path.join(home, "Dev/jori/.env"), "SUPABASE_SERVICE_ROLE_KEY=test-key\n");
    const fake = path.join(root, "fake-pgrst.mjs");
    fs.writeFileSync(fake, FAKE_PGRST);
    const stub = (name, body) => {
      const p = path.join(bin, name);
      fs.writeFileSync(p, `#!/bin/bash\n${body}\n`);
      fs.chmodSync(p, 0o755);
      return p;
    };
    // curl: a POST …/restart is recorded; a jori_messages GET goes to the fake.
    stub("curl", [
      'url=""; for a; do case "$a" in http*) url="$a" ;; esac; done',
      'echo "$url" >> "$STUB_LOG_DIR/curl.calls"',
      'case "$url" in',
      '  */restart) echo restart >> "$STUB_LOG_DIR/restarts"; exit 0 ;;',
      `  */rest/v1/jori_messages\\?*) exec ${JSON.stringify(process.execPath)} "$FAKE_PGRST" "$url" ;;`,
      'esac',
      'exit 7',
    ].join("\n"));
    if (JQ) fs.symlinkSync(JQ, path.join(bin, "jq"));
    const send = stub("send", 'line=""; for a; do line="$line$a"$\'\\x1f\'; done; printf "%s\\n" "$line" >> "$STUB_LOG_DIR/sent"');
    return { root, bin, home, fake, send, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  function readLines(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  }

  // Each tick is a fresh bash process, as under cron; incident state persists in
  // $HOME/Dev/jori/data/watchdog-incidents between ticks.
  function ticker() {
    const sb = makeSandbox();
    const rowsFile = path.join(sb.root, "rows.json");
    const cursorFile = path.join(sb.home, "Dev/jori/data/phone-channel-cursor.json");
    const harness = [
      'LOG="$HOME/watchdog.log"',
      'log() { echo "$(date \'+%Y-%m-%d %H:%M:%S\') $1" >> "$LOG"; }',
      `SEND=${JSON.stringify(sb.send)}`,
      'EMAIL_SEND="/nonexistent/email-send"',
      'PENDING_ALERT_KEY=""',
      'INCIDENT_DIR="$HOME/Dev/jori/data/watchdog-incidents"',
      'mkdir -p "$INCIDENT_DIR"',
      'ISSUES=""',
      fnSrc("log_throttled"),
      fnSrc("notify"),
      fnSrc("_incident_label"),
      fnSrc("incident_seen"),
      fnSrc("incident_clear"),
      fnSrc("incident_should_alert"),
      sectionSrc(),
      'printf "ISSUES=%s\\n" "$ISSUES"',
    ].join("\n");
    let seenPages = 0, seenRestarts = 0, seenCalls = 0;
    const tick = ({ rows = [], cursor, hold = "", down = false } = {}) => {
      fs.writeFileSync(rowsFile, JSON.stringify(rows));
      if (cursor === null) fs.rmSync(cursorFile, { force: true });
      else if (cursor !== undefined) fs.writeFileSync(cursorFile, JSON.stringify({ lastSeenAt: cursor, updated: iso(Date.now()) }));
      const out = execFileSync("bash", ["-c", harness], {
        encoding: "utf8",
        env: {
          PATH: `${sb.bin}:/usr/bin:/bin`,
          HOME: sb.home,
          JORI_INSTALL_TOOLS: path.join(sb.home, "Dev/jori"),
          STUB_LOG_DIR: sb.root,
          FAKE_PGRST: sb.fake,
          FAKE_ROWS: rowsFile,
          FAKE_PGRST_DOWN: down ? "1" : "0",
          JORI_SUPABASE_PROJECT: "testproject",
          CHAT_HEALTH_PORT: "9999",
          CHAT_HOLD_UNTIL: hold,
        },
      });
      const sent = readLines(path.join(sb.root, "sent")).map((l) => l.split("\x1f").filter(Boolean));
      const restarts = readLines(path.join(sb.root, "restarts")).length;
      const calls = readLines(path.join(sb.root, "curl.calls"));
      const r = {
        issues: (out.match(/^ISSUES=(.*)$/m) || [])[1],
        pages: sent.slice(seenPages).map((a) => a[a.length - 1]),
        args: sent.slice(seenPages),
        restarts: restarts - seenRestarts,
        queries: calls.slice(seenCalls).filter((u) => u.includes("/rest/v1/jori_messages")),
        log: readLines(path.join(sb.home, "watchdog.log")),
      };
      seenPages = sent.length; seenRestarts = restarts; seenCalls = calls.length;
      return r;
    };
    return { tick, sb, cleanup: sb.cleanup };
  }

  const user = (id, ms) => ({ id, role: "user", read: false, created_at: pgTs(ms) });
  const assistant = (id, ms) => ({ id, role: "assistant", read: false, created_at: pgTs(ms) });

  // ---- the query ------------------------------------------------------------

  test("chat_delivery_query sends '+' as %2B and Z-form timestamps unchanged", () => {
    const out = execFileSync("bash", ["-c", `${fnSrc("chat_delivery_query")}\nchat_delivery_query "$1" "$2" "$3"`, "bash",
      "2026-01-01T10:00:00.12345+00:00", "2025-12-25T10:00:00Z", "2026-01-01T11:50:00Z"], { encoding: "utf8" });
    assert.ok(!out.includes("+"), `no bare '+' may reach the query string: ${out}`);
    const q = new URLSearchParams(out);
    assert.deepEqual(q.getAll("created_at"), ["gt.2026-01-01T10:00:00.12345+00:00", "gt.2025-12-25T10:00:00Z", "lt.2026-01-01T11:50:00Z"]);
    assert.equal(q.get("role"), "eq.user");
    assert.equal(q.get("read"), null, "`read` is the app's display flag, not a delivery signal");
    assert.equal(q.get("order"), "created_at.asc");
  });

  test("the section's cutoff is a Z-form UTC timestamp, not '+00:00'", () => {
    const line = (SRC.match(/^CUTOFF=\$\(date [^\n]*/m) || [])[0] || "";
    assert.ok(line, "expected the CUTOFF assignment");
    assert.ok(!line.includes("+00:00"), line);
    assert.ok(line.includes("%SZ'"), line);
  });

  // ---- the section, tick by tick -------------------------------------------

  test("an unreceived user message >10 min old restarts chat once, then pages exactly once", needJq, () => {
    const t = ticker();
    try {
      const now = Date.now();
      const cursor = pgTs(now - 60 * MIN);
      const rows = [user("old-handled", now - 90 * MIN), user("stuck", now - 15 * MIN)];

      const t1 = t.tick({ rows, cursor });
      assert.equal(t1.issues, " chat-delivery-stuck(1msg)");
      assert.deepEqual(t1.pages, [], "the first tick self-heals, it does not page");
      assert.equal(t1.restarts, 1, "the self-heal is one chat restart");
      assert.equal(t1.queries.length, 1);

      const t2 = t.tick({ rows, cursor });
      assert.equal(t2.pages.length, 1, `expected one page, got ${JSON.stringify(t2.pages)}`);
      assert.ok(t2.pages[0].startsWith("🔴 Chat delivery still stuck after self-heal — 1 message(s)"), t2.pages[0]);
      assert.ok(t2.args[0].includes("--channel") && t2.args[0].includes("system"), "pages go to the system channel");
      assert.equal(t2.restarts, 0, "no restart on later ticks");

      for (let i = 0; i < 3; i++) {
        const tn = t.tick({ rows, cursor });
        assert.deepEqual(tn.pages, [], "one page per incident");
        assert.equal(tn.restarts, 0);
      }
    } finally {
      t.cleanup();
    }
  });

  test("handled history and messages under 10 min never page", needJq, () => {
    const t = ticker();
    try {
      const now = Date.now();
      const cursor = pgTs(now - 20 * MIN);
      // Dozens of old user rows the app never marked read, all at or before the cursor;
      // one fresh message past it; assistant rows past it.
      const rows = [];
      for (let i = 0; i < 40; i++) rows.push(user(`hist-${i}`, now - (21 + i * 30) * MIN));
      rows.push(user("at-cursor", Date.parse(cursor)));
      rows.push(user("fresh", now - 2 * MIN));
      rows.push(assistant("reply", now - 15 * MIN));
      for (let i = 0; i < 4; i++) {
        const r = t.tick({ rows, cursor });
        assert.equal(r.issues, "");
        assert.deepEqual(r.pages, []);
        assert.equal(r.restarts, 0);
        assert.equal(r.queries.length, 1, "the query ran (and parsed) every tick");
      }
    } finally {
      t.cleanup();
    }
  });

  test("a cursor that moves between ticks is a backlog draining, not a page", needJq, () => {
    const t = ticker();
    try {
      const now = Date.now();
      const rows = [user("a", now - 40 * MIN), user("b", now - 30 * MIN), user("c", now - 20 * MIN)];
      assert.equal(t.tick({ rows, cursor: pgTs(now - 50 * MIN) }).restarts, 1);
      const t2 = t.tick({ rows, cursor: pgTs(now - 40 * MIN) });
      assert.equal(t2.issues, " chat-delivery-stuck(2msg)");
      assert.deepEqual(t2.pages, [], "the cursor moved: the phone-channel is handing messages over");
      const t3 = t.tick({ rows, cursor: pgTs(now - 40 * MIN) });
      assert.equal(t3.pages.length, 1, "stuck again with the cursor where it was: page");
    } finally {
      t.cleanup();
    }
  });

  test("recovery after a delivered page sends one ✅ after 3 green ticks", needJq, () => {
    const t = ticker();
    try {
      const now = Date.now();
      const rows = [user("stuck", now - 15 * MIN)];
      const memo = path.join(t.sb.home, "Dev/jori/data/.watchdog-chat-delivery-cursor");
      const incidents = path.join(t.sb.home, "Dev/jori/data/watchdog-incidents");
      t.tick({ rows, cursor: pgTs(now - 60 * MIN) });
      assert.equal(t.tick({ rows, cursor: pgTs(now - 60 * MIN) }).pages.length, 1);
      assert.ok(fs.existsSync(memo), "the cursor memo sits beside the incident dir");
      assert.deepEqual(fs.readdirSync(incidents).filter((f) => f.endsWith(".cursor")), [],
        "`jori watchdog` lists every file in the incident dir as an incident: the memo is not one");
      const handed = pgTs(now - 15 * MIN);
      assert.deepEqual(t.tick({ rows, cursor: handed }).pages, []);
      assert.deepEqual(t.tick({ rows, cursor: handed }).pages, []);
      const t5 = t.tick({ rows, cursor: handed });
      assert.equal(t5.pages.length, 1);
      assert.ok(t5.pages[0].startsWith("✅ Recovered: chat message delivery is back to normal"), t5.pages[0]);
      assert.ok(!fs.existsSync(memo));
    } finally {
      t.cleanup();
    }
  });

  test("a failed query is no reading: it neither counts, pages nor clears", needJq, () => {
    const t = ticker();
    try {
      const now = Date.now();
      const rows = [user("stuck", now - 15 * MIN)];
      const cursor = pgTs(now - 60 * MIN);
      assert.equal(t.tick({ rows, cursor }).restarts, 1);
      for (let i = 0; i < 4; i++) {
        const r = t.tick({ rows, cursor, down: true });
        assert.equal(r.issues, "");
        assert.deepEqual(r.pages, [], "no ✅ and no 🔴 from a query that failed");
      }
      assert.ok(t.tick({ rows, cursor, down: true }).log.some((l) => l.includes("Chat delivery check: the Supabase query failed")));
      const back = t.tick({ rows, cursor });
      assert.equal(back.pages.length, 1, "the incident counter survived the failed queries: attempt 2 pages");
    } finally {
      t.cleanup();
    }
  });

  test("while chat holds for the usage limit, waiting messages are logged, not counted", needJq, () => {
    const t = ticker();
    try {
      const now = Date.now();
      const rows = [user("waiting", now - 30 * MIN)];
      for (let i = 0; i < 3; i++) {
        const r = t.tick({ rows, cursor: pgTs(now - 60 * MIN), hold: "2026-01-02T03:01:00.000Z" });
        assert.equal(r.issues, "");
        assert.deepEqual(r.pages, []);
        assert.equal(r.restarts, 0, "a restart during the hold starts no turn");
      }
      assert.ok(t.tick({ rows, cursor: pgTs(now - 60 * MIN), hold: "x" }).log.some((l) => l.includes("Chat delivery waiting:")));
    } finally {
      t.cleanup();
    }
  });

  test("no cursor file: no query, nothing to measure from", needJq, () => {
    const t = ticker();
    try {
      const r = t.tick({ rows: [user("x", Date.now() - 30 * MIN)], cursor: null });
      assert.equal(r.queries.length, 0);
      assert.equal(r.issues, "");
    } finally {
      t.cleanup();
    }
  });

  test("rows past a cursor older than the 7-day lookback are not counted", needJq, () => {
    const t = ticker();
    try {
      const now = Date.now();
      const r = t.tick({ rows: [user("ancient", now - 8 * 24 * 60 * MIN)], cursor: pgTs(now - 9 * 24 * 60 * MIN) });
      assert.equal(r.issues, "");
      assert.equal(r.queries.length, 1);
    } finally {
      t.cleanup();
    }
  });

  // ---- phone-channel heartbeat (inside the chat supervisor health block) ------

  function heartbeatBlock() {
    const start = SRC.indexOf("    # Phone-channel heartbeat staleness");
    assert.notEqual(start, -1, "expected the phone-channel heartbeat block");
    const end = SRC.indexOf("\n    fi\n", start);
    assert.notEqual(end, -1);
    return SRC.slice(start, end + "\n    fi\n".length);
  }

  function heartbeatIssues(health) {
    const sb = makeSandbox();
    try {
      const script = ['log() { :; }', 'ISSUES=""', `CHAT_HEALTH=${JSON.stringify(JSON.stringify(health))}`,
        heartbeatBlock(), 'printf "%s" "$ISSUES"'].join("\n");
      return execFileSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${sb.bin}:/usr/bin:/bin` } });
    } finally {
      sb.cleanup();
    }
  }

  test("a phone-channel that never heartbeated reads stale once the supervisor says so", needJq, () => {
    assert.equal(heartbeatIssues({ phoneChannelHeartbeatAgeMs: null, phoneChannelStale: true }), " phone-channel(no-heartbeat)");
    assert.equal(heartbeatIssues({ phoneChannelHeartbeatAgeMs: null, phoneChannelStale: false }), "", "within the grace");
    assert.equal(heartbeatIssues({ phoneChannelHeartbeatAgeMs: null }), "", "a supervisor without the field: as before");
    assert.equal(heartbeatIssues({ phoneChannelHeartbeatAgeMs: 400000, phoneChannelStale: true }), " phone-channel(heartbeat-stale)");
    assert.equal(heartbeatIssues({ phoneChannelHeartbeatAgeMs: 400000 }), " phone-channel(heartbeat-stale)");
    assert.equal(heartbeatIssues({ phoneChannelHeartbeatAgeMs: 30000, phoneChannelStale: false }), "");
  });
}
