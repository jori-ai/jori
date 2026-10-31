// hum-action-workset — the executor's Step 1 filter runs in the trigger, so an
// empty backlog never costs an agent turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/hum-action-workset");
const base = { scope: "jori_autonomous", risk: "low", effort: "quick", status: "proposed" };

function run(rows, args) {
  const dir = mkdtempSync(join(tmpdir(), "haw-"));
  const f = join(dir, "ideas.jsonl");
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = spawnSync(process.execPath, [BIN, ...args.map((a) => a.replace("$DIR", dir))], { encoding: "utf8", env: { ...process.env, HUM_IDEAS_FILE: f, JORI_OWNER_ID: "tester" } });
  return { ...r, dir };
}

test("selects build routes, carries the route, sorts oldest first", () => {
  const rows = [
    { ...base, id: "b", proposed_at: "2026-09-02" },
    { ...base, id: "a", proposed_at: "2026-08-01" },
    { ...base, id: "manual", scope: "manual_tester", proposed_at: "2026-07-01" }, // waits for the user's yes in chat
    { ...base, id: "yes", scope: "manual_tester", status: "approved", proposed_at: "2026-07-15" }, // the user said yes
    { ...base, id: "high", risk: "high", proposed_at: "2026-07-20" }, // built, then one card
    { ...base, id: "big", effort: "multi-day", proposed_at: "2026-07-01" }, // weekly email, not a run
    { ...base, id: "done", proposed_at: "2026-07-01" },
    { id: "done", status: "awaiting_approval" }, // later row wins
  ];
  const r = run(rows, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.map((x) => x.id), ["yes", "high", "a", "b"]);
  assert.deepEqual(out.map((x) => x.route), ["build", "build_card", "build_auto", "build_auto"]);
});

test("--write prints the count and writes the work set; empty backlog prints 0", () => {
  let r = run([{ ...base, id: "a", proposed_at: "2026-08-01" }], ["--write", "$DIR/ws.json"]);
  assert.equal(r.stdout, "1");
  assert.deepEqual(JSON.parse(readFileSync(join(r.dir, "ws.json"), "utf8")).ids, ["a"]);
  r = run([{ ...base, id: "a", status: "superseded" }], ["--write", "$DIR/ws.json"]);
  assert.equal(r.stdout, "0");
});
