// companion-pickup-rules.test.mjs — the app's "did my message get through?"
// rules (apps/companion/Jori/PickupRules.swift), checked without Xcode: the
// file is pure Foundation, so swiftc compiles it with a small driver and the
// driver's checks run here. Skipped where there is no swiftc (Linux CI).
// Run: node --test tests/companion-pickup-rules.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES = path.join(here, "../apps/companion/Jori/PickupRules.swift");
const hasSwiftc = spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status === 0;

// Each check prints "ok <name>" or "FAIL <name>"; the driver exits non-zero on any FAIL.
const DRIVER = String.raw`
import Foundation

var failures = 0
func check(_ name: String, _ cond: Bool) {
    print((cond ? "ok " : "FAIL ") + name)
    if !cond { failures += 1 }
}

let t0 = Date(timeIntervalSince1970: 1_800_000_000)
let mine = PickupEntry(id: UUID(), channel: "chat", sentAt: t0)

func row(_ role: String, _ at: TimeInterval, channel: String = "chat", id: UUID = UUID(),
         replyTo: UUID? = nil, ack: Bool = false, stamped: Bool = false) -> PickupRow {
    PickupRow(id: id, role: role, channel: channel, createdAt: t0.addingTimeInterval(at),
              replyTo: replyTo, isAck: ack, stamped: stamped)
}

// Signal 1: a stamp on the user's own row.
check("own stamp clears", PickupRules.pickedUp(mine, by: row("user", 0, id: mine.id, stamped: true), stampSupported: true))
check("own row unstamped does not clear", !PickupRules.pickedUp(mine, by: row("user", 0, id: mine.id), stampSupported: true))
check("a later stamped message in the channel clears", PickupRules.pickedUp(mine, by: row("user", 30, stamped: true), stampSupported: true))
check("an earlier stamped message does not", !PickupRules.pickedUp(mine, by: row("user", -30, stamped: true), stampSupported: true))
check("a stamped message in another channel does not", !PickupRules.pickedUp(mine, by: row("user", 30, channel: "system", stamped: true), stampSupported: true))

// Signal 2: an assistant row replying to it, whenever it was written.
check("reply_to clears", PickupRules.pickedUp(mine, by: row("assistant", 5, replyTo: mine.id), stampSupported: true))

// Signal 3: the phone link's placeholder after it.
check("ack after clears", PickupRules.pickedUp(mine, by: row("assistant", 2, ack: true), stampSupported: true))
check("ack before does not", !PickupRules.pickedUp(mine, by: row("assistant", -2, ack: true), stampSupported: true))
check("ack in another channel does not", !PickupRules.pickedUp(mine, by: row("assistant", 2, channel: "system", ack: true), stampSupported: true))

// Signal 4: any later assistant row, only until the stamp column exists.
check("plain later assistant row clears without stamp column", PickupRules.pickedUp(mine, by: row("assistant", 60), stampSupported: false))
check("plain later assistant row does not clear once stamps exist", !PickupRules.pickedUp(mine, by: row("assistant", 60), stampSupported: true))
check("plain earlier assistant row never clears", !PickupRules.pickedUp(mine, by: row("assistant", -60), stampSupported: false))

// Metadata helpers read structure only.
check("is_ack metadata", PickupRules.isAckMetadata(["is_ack": "1"]) && !PickupRules.isAckMetadata(["is_ack": "0"]) && !PickupRules.isAckMetadata(nil))
check("metadata stamp", PickupRules.hasStamp(["picked_up_at": "2026-11-04T12:00:00Z"]) && PickupRules.hasStamp(["handled_at": "x"]) && !PickupRules.hasStamp(["handled_at": ""]) && !PickupRules.hasStamp(nil))

// Timing.
check("not overdue at 9:59", !PickupRules.isOverdue(mine, now: t0.addingTimeInterval(599)))
check("overdue at 10:00", PickupRules.isOverdue(mine, now: t0.addingTimeInterval(600)))
check("forgotten after 48h", !PickupRules.isOverdue(mine, now: t0.addingTimeInterval(48 * 3600)) && PickupRules.isExpired(mine, now: t0.addingTimeInterval(48 * 3600)))

// One status line per channel: the newest overdue message.
let a = PickupEntry(id: UUID(), channel: "chat", sentAt: t0)
let b = PickupEntry(id: UUID(), channel: "chat", sentAt: t0.addingTimeInterval(120))
let c = PickupEntry(id: UUID(), channel: "chat", sentAt: t0.addingTimeInterval(700))
let q = PickupEntry(id: UUID(), channel: "questions", sentAt: t0)
let now = t0.addingTimeInterval(900)
check("newest overdue per channel", PickupRules.flagged([a, b, c, q], now: now) == Set([b.id, q.id]))
check("nothing flagged before the deadline", PickupRules.flagged([c], now: now).isEmpty)
check("next wake is the soonest deadline ahead", PickupRules.nextWake([a, b, c], now: now) == c.sentAt.addingTimeInterval(600))
check("no wake when nothing is ahead", PickupRules.nextWake([a, b], now: now) == nil)

// cleared(): an ack after b clears b and c's predecessors only when after them.
let ack = row("assistant", 200, ack: true)
check("ack clears the messages before it only", PickupRules.cleared([a, b, c], by: [ack], stampSupported: true) == Set([a.id, b.id]))

// Codable round trip (entries are persisted in UserDefaults).
let data = try! JSONEncoder().encode([a, q])
check("entries round-trip", (try? JSONDecoder().decode([PickupEntry].self, from: data)) == [a, q])

exit(failures == 0 ? 0 : 1)
`;

test("PickupRules.swift behaves as documented", { skip: !hasSwiftc && "swiftc not available" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pickup-rules-"));
  try {
    const driver = path.join(dir, "main.swift");
    fs.writeFileSync(driver, DRIVER);
    const bin = path.join(dir, "pickup-rules");
    execFileSync("swiftc", ["-module-cache-path", path.join(dir, "mc"), "-o", bin, RULES, driver], { stdio: "pipe" });
    const run = spawnSync(bin, [], { encoding: "utf8" });
    const lines = run.stdout.trim().split("\n");
    const failed = lines.filter((l) => l.startsWith("FAIL"));
    assert.deepEqual(failed, [], run.stdout);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(lines.length >= 20, `expected the full set of checks, got:\n${run.stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
