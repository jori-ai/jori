// dream_asks floats the dream's questions from the day after, newest dream
// first, at most 3 per 24h and 2h apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../agent/scripts/hum-harvesters/dream_asks.mjs");

function run({ ideas = [], runs = [], today = "2026-10-16", tz = "Etc/GMT-3" }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dream-asks-"));
  const data = path.join(home, "data");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "hum-ideas.jsonl"), ideas.map((i) => JSON.stringify(i)).join("\n") + "\n");
  fs.writeFileSync(path.join(data, "hum-runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = spawnSync(process.execPath, [BIN], { input: "{}", encoding: "utf8",
    env: { ...process.env, HOME: home, JORI_DATA_DIR: data, HUM_RUNS_FILE: path.join(data, "hum-runs.jsonl"), DREAM_ASKS_TODAY: today, DREAM_ASKS_TZ: tz } });
  fs.rmSync(home, { recursive: true, force: true });
  const line = r.stdout.trim().split("\n").at(-1);
  return { out: line === "null" ? null : JSON.parse(line), err: r.stderr };
}

const q = (id, created_at, dream_date, extra = {}) => ({ id, source: "dream", confidence: "low", subject: id, rationale: "why",
  verify_question: `What about ${id}?`, created_at, supporting_data: { dream_date }, consumed: false, ...extra });

test("a question written today waits; one written yesterday is floated", () => {
  // 2026-10-15T22:30Z is already Oct 16 at UTC+3 → same local day → waits.
  assert.equal(run({ ideas: [q("idea-a", "2026-10-15T22:30:00Z", "2026-10-15")] }).out, null);
  const { out } = run({ ideas: [q("idea-b", "2026-10-15T08:00:00Z", "2026-10-14")] });
  assert.equal(out.topic, "dream_asks");
  assert.equal(out.dedup_key, "idea-b");
  assert.equal(out.supporting_data.memory_hook, "dream:idea-b");
  assert.match(out.signal, /What about idea-b\?/);
});

test("newest dream first; consumed, expired and non-question ideas are skipped", () => {
  const { out } = run({ ideas: [
    q("idea-old", "2026-10-15T08:00:00Z", "2026-10-02"),
    q("idea-new", "2026-10-15T09:00:00Z", "2026-10-14"),
    q("idea-done", "2026-10-15T07:00:00Z", "2026-10-14", { consumed: true }),
    q("idea-gone", "2026-10-15T07:00:00Z", "2026-10-14", { expired: true }),
    { ...q("idea-info", "2026-10-15T07:00:00Z", "2026-10-14"), confidence: "medium" },
    { ...q("idea-other", "2026-10-15T07:00:00Z", "2026-10-14"), source: "hum-ideation-agent" },
  ] });
  assert.equal(out.dedup_key, "idea-new");
  assert.equal(out.supporting_data.waiting, 2);
});

test("a consumption marker appended later retires the question", () => {
  const { out } = run({ ideas: [q("idea-b", "2026-10-15T08:00:00Z", "2026-10-14"), { id: "idea-b", consumed: true }] });
  assert.equal(out, null);
});

test("pacing: 2h spacing and 3 per 24h, counted from what was sent", () => {
  const ideas = [q("idea-b", "2026-10-15T08:00:00Z", "2026-10-14")];
  const sent = (minsAgo) => ({ ts: new Date(Date.now() - minsAgo * 60000).toISOString(), sonnet: { based_on_topic: "dream_asks" }, outcome: { sent: true } });
  assert.equal(run({ ideas, runs: [sent(30)] }).out, null);
  assert.equal(run({ ideas, runs: [sent(300), sent(500), sent(700)] }).out, null);
  assert.ok(run({ ideas, runs: [sent(300), sent(500)] }).out);
  assert.ok(run({ ideas, runs: [{ ...sent(30), outcome: { sent: false } }] }).out, "an unsent tick does not count");
});
