// location-enrich-compose-run.test.mjs — end-to-end over
// bin/location-enrich-compose with a throwaway installation (JORI_HOME), a fake
// Ollama (/api/chat on 127.0.0.1) and a fake calendar CLI. The Sonnet rung is
// disabled (--no-sonnet), so whatever the local rung can't phrase validly must
// land in the residue. No network, no model.
// Run: node --test tests/location-enrich-compose-run.test.mjs
import "./synthetic-instance.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/location-enrich-compose");

function setup({ events = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lec-"));
  const data = path.join(home, "data");
  fs.mkdirSync(path.join(data, "logs"), { recursive: true });
  const mk = (id, extra = {}) => ({
    visit_id: id, arrived_at: "2099-02-04T16:10:00Z", departed_at: "2099-02-04T17:05:00Z",
    candidates: [{ name: "Café Aurora", type: "Restaurant", rating: 4.5, distance_m: 12 }], ...extra,
  });
  fs.writeFileSync(path.join(data, "location-pending-enrich.json"), JSON.stringify({
    pending: [mk("v1"), mk("v2"), mk("v3", { stage: "identify" })],
  }));
  const st = (id, stage = "confirm") => ({ visit_id: id, stage, arrived_local: "12:10", departed_local: "13:05", duration_min: 55, movement_led: false, food_heavy: true });
  fs.writeFileSync(path.join(data, "location-enrich-brief.json"), JSON.stringify({ stops: [st("v1"), st("v2"), st("v3", "identify")] }));
  const gog = path.join(home, "fake-gog");
  fs.writeFileSync(gog, `#!/bin/sh\necho '${JSON.stringify(events)}'\n`);
  fs.chmodSync(gog, 0o755);
  return { home, data, gog };
}

function fakeOllama(reply) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: { content: reply } }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function run(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, "--no-sonnet", "--json"], { env: { ...process.env, ...env } });
    let out = ""; p.stdout.on("data", (c) => (out += c));
    p.on("close", () => resolve(JSON.parse(out.trim().split("\n").pop())));
  });
}

test("queues the local rung's valid ask, templates identify, and leaves the invalid one as residue", async () => {
  const { home, data, gog } = setup();
  const reply = JSON.stringify({ asks: [
    { visit_id: "v1", hypothesis_candidate_id: "c1", framing: "venue", message: "Was Café Aurora your 12:10 lunch? ~55m there. If not, what was it?" },
    { visit_id: "v2", hypothesis_candidate_id: "c7", framing: "venue", message: "Was it lunch at 12:10? ~55m there." },
  ] });
  const srv = await fakeOllama(`Sure! ${reply}`);
  try {
    const s = await run({ JORI_HOME: home, GOG_BIN: gog, OLLAMA_URL: `http://127.0.0.1:${srv.address().port}` });
    assert.equal(s.residue, 1);
    assert.deepEqual(s.residue_visits.map((r) => r.visit_id), ["v2"]);
    const q = JSON.parse(fs.readFileSync(path.join(data, "location-ask-queue.json"), "utf8")).queue;
    assert.deepEqual(q.map((e) => e.visit_id).sort(), ["v1", "v3"]);
    const residue = JSON.parse(fs.readFileSync(path.join(data, "location-enrich-residue.json"), "utf8"));
    assert.equal(residue.visits[0].visit_id, "v2");
  } finally { srv.close(); }
});

test("a calendar event in the window sends the stop to the agent untouched", async () => {
  const { home, data, gog } = setup({ events: [{ summary: "Show", start: { dateTime: "2099-02-04T16:30:00Z" }, end: { dateTime: "2099-02-04T18:00:00Z" } }] });
  const srv = await fakeOllama("{}");
  try {
    const s = await run({ JORI_HOME: home, GOG_BIN: gog, OLLAMA_URL: `http://127.0.0.1:${srv.address().port}` });
    assert.equal(s.residue, 3);
    assert.equal(fs.existsSync(path.join(data, "location-ask-queue.json")), false);
  } finally { srv.close(); }
});

test("a failed calendar lookup fails open to the agent", async () => {
  const { home } = setup();
  const s = await run({ JORI_HOME: home, GOG_BIN: "/nonexistent/gog", OLLAMA_URL: "http://127.0.0.1:9" });
  assert.equal(s.residue, 3);
});
