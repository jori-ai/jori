// Regression guard for silent system-channel row loss.
//
// THE ALERT THIS DEFENDS AGAINST: watchdog.sh paged
//   "🔴 Supabase DB unreachable — the Jori app + phone channel are down"
// The jori_messages INSERT failed because Supabase was the thing that was
// down. jori-send-curl fell back to email and exited 0, so watchdog.sh
// logged "Notified via Jori" and marked the incident delivered; eight
// minutes later incident_clear posted "✅ Recovered: Supabase is back to
// normal", which wrote fine. The channel was left holding a green check with
// nothing above it, and system-issue-review — whose only input is
// jori_messages where channel='system' — could not see the outage at all.
//
// Two invariants are pinned here:
//   1. A failed system-channel insert is PARKED, not dropped, and the next
//      successful system-channel send replays it.
//   2. Neither half can ever delay or fail a live send.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEND = path.join(ROOT, "bin/jori-send-curl");
const FLUSH = path.join(ROOT, "bin/system-channel-spool-flush");

const sendSrc = () => fs.readFileSync(SEND, "utf8");

test("a failed insert parks the row before the email fallback", () => {
  const src = sendSrc();
  const fallback = src.indexOf("falling back to email");
  const park = src.indexOf('_spool_append "$HTTP_CODE"');
  assert.ok(park > 0, "jori-send-curl no longer parks a failed row — the alert-loss bug is back");
  assert.ok(
    park < fallback,
    "the spool write must happen before the email fallback, so an email-send failure cannot also lose the row"
  );
});

test("_spool_append is scoped to the system channel and cannot fail the caller", () => {
  const src = sendSrc();
  const fn = src.slice(src.indexOf("_spool_append() {"), src.indexOf("RESP_BODY_FILE=\"\""));
  assert.ok(fn.includes('[ "$CHANNEL" = "system" ] || return 0'), "spool must stay scoped to --channel system");
  assert.ok(
    !/\breturn 1\b/.test(fn),
    "_spool_append must return 0 on every path — it runs after the send has already fallen back"
  );
});

test("a successful system send replays the spool, guarded so it cannot break the send", () => {
  const src = sendSrc();
  const m = src.match(/if \[ "\$CHANNEL" = "system" \] && \[ -x "\$SPOOL_FLUSH" \] && \[ -s "\$SPOOL_FILE" \]; then\n(.*)\n  fi/);
  assert.ok(m, "the flush invocation on the success path is missing or was reshaped");
  assert.ok(m[1].includes("&"), "the flush must be backgrounded so it never delays a send");
  assert.ok(m[1].includes("> /dev/null 2>&1"), "flush output must be discarded so it never pollutes a caller");
});

test("flush replays oldest-first, drops expired and malformed rows, and --dry-run mutates nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-test-"));
  const spool = path.join(dir, "spool.jsonl");
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const row = (created_at, content) =>
    JSON.stringify({ created_at, role: "assistant", content, channel: "system", http_code: "000" });

  const lines = [
    row(iso(60_000), "newer alert"),
    row(iso(600_000), "older alert"),
    row(iso(30 * 24 * 3600_000), "ancient alert"), // past the 7-day cap
    "{not json at all",
  ];
  fs.writeFileSync(spool, lines.join("\n") + "\n");
  const before = fs.readFileSync(spool, "utf8");

  const out = execFileSync(FLUSH, ["--dry-run", "--json", "--spool", spool], { encoding: "utf8" });
  const report = JSON.parse(out);

  assert.equal(report.expired, 1, "the 30-day-old row should be dropped, not backfilled");
  assert.equal(report.malformed, 1, "a corrupt line must be discarded without stranding the rest");
  assert.equal(report.would_send.length, 2);
  assert.ok(
    Date.parse(report.would_send[0].created_at) < Date.parse(report.would_send[1].created_at),
    "oldest first — a backfilled warning has to land above the recovery ping that followed it"
  );
  assert.equal(fs.readFileSync(spool, "utf8"), before, "--dry-run must not mutate the spool");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("flush is a no-op with no spool and never exits non-zero", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-test-"));
  const out = execFileSync(FLUSH, ["--spool", path.join(dir, "absent.jsonl")], { encoding: "utf8" });
  assert.equal(out.trim(), "");
  fs.rmSync(dir, { recursive: true, force: true });
});
