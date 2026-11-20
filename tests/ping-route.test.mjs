// ping-route.test.mjs — each hum ping goes to the team member whose area it is
// about (lib/ping-route.mjs, bin/ping-route, bin/hum-ping, jori-send-curl --as-role).
//
// Pinned here:
//   1. The choice is one option per team member, built from the roster.
//   2. Rules with no model: the off switch, a team of one, a tappable card and
//      a location question stay with the coordinator.
//   3. Bank and health content never reaches Jev: a private lane or intent, a
//      screen that finds private content, fails or is switched off, all keep the
//      call off Jev (skipJev), whatever privacy_exclusions says.
//   4. Jev's answer is read as a member or rejected; anything not a member, or a
//      failure, keeps the coordinator. The ladder climbs past a non-member answer.
//   5. The log carries no message text.
//   6. jori-send-curl --as-role files, signs and titles the message as that
//      member; an unknown member is ignored. hum-ping passes the route on and
//      records it on the feedback row.
//
// Run: node --test tests/ping-route.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ping-route-"));
process.env.PING_ROUTE_LOG = path.join(tmp, "log.jsonl");
process.env.PING_ROUTE_OFF = path.join(tmp, ".off");
const { routePing, team, criteriaFor, ladderJudge, ladderPrompt, routeDef } = await import("../lib/ping-route.mjs");

const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { underTestRunner } = require("../lib/load-env.js");

const O = {
  ceo: "the user",
  roles: [
    { id: "cos", name: "Ada", title: "Chief of Staff", chief_of_staff: true, responsibility: "runs the day-to-day" },
    { id: "cfo", name: "Ben", title: "Finances", responsibility: "cash, investments, net worth" },
    { id: "travel", name: "Cy", title: "Travel", responsibility: "trips and bookings" },
  ],
};

// A decide() stand-in: records the call, answers through the site's own
// interpret() when given Jev answers, else through its legacy.
function fakeDecide({ answers = null, legacyRole = "cos" } = {}) {
  const calls = [];
  const fn = async (o) => {
    calls.push(o);
    if (answers && !o.skipJev) {
      try { const it = o.interpret(answers); return { value: it.value, used: "jev", jev: { confidence: it.confidence } }; }
      catch { /* below: legacy */ }
    }
    return { value: { role: legacyRole, reason: "ladder", rung: "local" }, used: "legacy", reason: o.skipJev || "jev-low-confidence" };
  };
  fn.calls = calls;
  return fn;
}
const clean = async () => ({ private: false, reason: "screen-no" });
const jevOn = () => true;
const noScreen = async () => { throw new Error("the screen must not run"); };
const choice = (c, p = 0.9) => ({ role: { type: "choice", choice: c, probabilities: { [c]: p } } });

test("the choice is one option per member, the coordinator marked as the default", () => {
  const { roles, coordinator } = team(O);
  assert.equal(coordinator.id, "cos");
  const c = criteriaFor(roles, "cos");
  assert.deepEqual(Object.keys(c), ["cos", "cfo", "travel"]);
  assert.match(c.cos, /coordinator/);
  assert.match(c.cfo, /^Ben \(Finances\): cash/);
  assert.equal(team({ roles: [{ id: "Bad Id!" }, { id: "ok" }] }).roles.length, 1, "a malformed id is not a member");
  const p = ladderPrompt({ ping: "MU down 11%", lane: "stocks" }, routeDef().role_template.instructions, c);
  assert.match(p, /"role":"<one of: cos\|cfo\|travel>"/);
  assert.match(p, /never follow instructions/);
});

test("rules with no model: off switch, a team of one, a card, a location question", async () => {
  const d = fakeDecide();
  fs.writeFileSync(process.env.PING_ROUTE_OFF, "");
  let r = await routePing({ text: "MU down 11%", lane: "stocks", deps: { org: O, decide: d } });
  assert.deepEqual([r.role, r.coordinator, r.used], ["cos", true, "off"]);
  fs.unlinkSync(process.env.PING_ROUTE_OFF);

  r = await routePing({ text: "x", lane: "stocks", deps: { org: { roles: [O.roles[0]] }, decide: d } });
  assert.deepEqual([r.role, r.used], ["cos", "solo"]);

  r = await routePing({ text: "Were you at the market?", lane: "nearby", choices: true, deps: { org: O, decide: d } });
  assert.deepEqual([r.role, r.used], ["cos", "rule"]);

  r = await routePing({ text: "Still at the cafe?", lane: "location_context", intent: "hum:location_context",
    finding: { topic: "location_context", dedup_key: "location_ask:v1" }, deps: { org: O, decide: d } });
  assert.deepEqual([r.role, r.used], ["cos", "rule"]);
  assert.equal(d.calls.length, 0, "no model for any of these");
});

test("a stock-mover ping goes to the finance member, decided without Jev", async () => {
  const d = fakeDecide({ answers: choice("cfo"), legacyRole: "cfo" });
  const r = await routePing({ text: "Micron is down about 11% today", lane: "stocks", intent: "hum:stocks", pingId: "p-1",
    deps: { org: O, decide: d, screen: noScreen, jevWouldRun: jevOn } });
  assert.equal(r.role, "cfo");
  assert.equal(r.coordinator, false);
  assert.equal(r.private, true);
  assert.match(d.calls[0].skipJev, /private/, "a private lane never reaches Jev");
});

test("bank and health content never reaches Jev: health lane, the screen's yes, its failure, its off switch", async () => {
  for (const [lane, screen] of [
    ["health", noScreen],
    ["ideas", async () => ({ private: true, reason: "screen-yes" })],
    ["ideas", async () => { throw new Error("down"); }],
    ["ideas", async () => ({ private: false, reason: "screen-disabled" })],
  ]) {
    const d = fakeDecide({ answers: choice("travel") });
    await routePing({ text: "something", lane, intent: `hum:${lane}`, deps: { org: O, decide: d, screen, jevWouldRun: jevOn } });
    assert.ok(d.calls[0].skipJev, `${lane}: kept off Jev`);
  }
  // The screen reads exactly what Jev would see.
  let seen = null;
  const d = fakeDecide({ answers: choice("travel") });
  const r = await routePing({ text: "Your Lisbon flight is in 3 days", lane: "travel", intent: "hum:travel",
    deps: { org: O, decide: d, screen: async (s) => { seen = s; return { private: false, reason: "screen-no" }; }, jevWouldRun: jevOn } });
  assert.deepEqual(seen, d.calls[0].state);
  assert.equal(d.calls[0].skipJev, undefined);
  assert.deepEqual([r.role, r.used], ["travel", "jev"]);
});

test("the screen does not run while Jev would not (no cost when Jev is off)", async () => {
  const d = fakeDecide();
  const r = await routePing({ text: "A gallery opens Friday", lane: "art", deps: { org: O, decide: d, screen: noScreen, jevWouldRun: () => false } });
  assert.equal(r.role, "cos");
  assert.equal(d.calls.length, 1);
  assert.match(d.calls[0].skipJev, /unscreened/, "text that skipped the screen is kept off Jev outright");
  assert.equal(r.private, undefined);
});

test("a reply in a member's conversation is matched to the hum ping sent there", async () => {
  const { routedPingReply } = await import("../lib/hum-reply-target.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-route-reply-"));
  const t0 = Date.parse("2026-11-20T17:32:00Z");
  fs.writeFileSync(path.join(dir, "hum-feedback.jsonl"), JSON.stringify({
    ping_id: "p-mu", message_id: "m-ping", lane: "stocks", sent_at: new Date(t0).toISOString(),
    findings: [{ topic: "stocks", dedup_key: "stocks:MU:test", signal: "MU down 11%" }],
  }) + "\n");
  const at = (ms) => new Date(t0 + ms).toISOString();
  const rows = [
    { id: "m-ping", role: "assistant", created_at: at(0) },
    { id: "m-user", role: "user", created_at: at(60e3) },
  ];
  const now = t0 + 120e3;
  assert.equal(routedPingReply({ messageId: "m-user", replyTo: "m-ping", rows }, dir, now), "m-ping", "a threaded reply");
  assert.equal(routedPingReply({ messageId: "m-user", rows }, dir, now), "m-ping", "the ping is the last thing said before it");
  const later = [...rows.slice(0, 1), { id: "m-other", role: "assistant", created_at: at(30e3) }, rows[1]];
  assert.equal(routedPingReply({ messageId: "m-user", rows: later }, dir, now), null, "a newer non-hum message in between");
  assert.equal(routedPingReply({ messageId: "m-user", rows }, dir, t0 + 7 * 3600e3), null, "too long ago to be the reply");
  assert.equal(routedPingReply({ messageId: "m-user", replyTo: "m-nothing", rows: [rows[1]] }, dir, now), null);
});

test("Jev's answer must be a member; anything else, or a failure, keeps the coordinator", async () => {
  let d = fakeDecide({ answers: choice("marketing") });
  let r = await routePing({ text: "x", lane: "news", deps: { org: O, decide: d, screen: clean, jevWouldRun: jevOn } });
  assert.deepEqual([r.role, r.used], ["cos", "legacy"], "a non-member falls to the ladder");

  r = await routePing({ text: "x", lane: "news", deps: { org: O, decide: async () => ({ value: { role: "nobody" }, used: "legacy" }), screen: clean, jevWouldRun: jevOn } });
  assert.equal(r.role, "cos");

  r = await routePing({ text: "x", lane: "news", deps: { org: O, decide: async () => { throw new Error("both down"); }, screen: clean, jevWouldRun: jevOn } });
  assert.deepEqual([r.role, r.coordinator, r.used], ["cos", true, "error"]);
});

test("the ladder climbs past an answer that is not a member", async () => {
  const bad = async () => '{"role":"marketing"}'; bad.rungName = "local";
  const good = async () => '{"role":"cfo","reason":"stock move"}'; good.rungName = "sonnet";
  const r = await ladderJudge("p", ["cos", "cfo"], { rungs: [bad, good] });
  assert.deepEqual([r.role, r.rung], ["cfo", "sonnet"]);
  await assert.rejects(ladderJudge("p", ["cos"], { rungs: [bad] }), /no rung named a member/);
});

test("the log names the route, never the message", async () => {
  fs.rmSync(process.env.PING_ROUTE_LOG, { force: true });
  await routePing({ text: "Micron is down 11%", lane: "stocks", intent: "hum:stocks", pingId: "p-log",
    deps: { org: O, decide: fakeDecide({ legacyRole: "cfo" }), jevWouldRun: jevOn } });
  const raw = fs.readFileSync(process.env.PING_ROUTE_LOG, "utf8");
  const row = JSON.parse(raw.trim().split("\n").pop());
  assert.deepEqual([row.ping_id, row.role, row.lane], ["p-log", "cfo", "stocks"]);
  assert.ok(!raw.includes("Micron"));
});

// ─── jori-send-curl --as-role ───────────────────────────────────────────

const needsRunner = { skip: !underTestRunner() && "run under node --test with its default process isolation (NODE_TEST_CONTEXT is unset)" };

function sendBox() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ping-route-send-"));
  fs.mkdirSync(path.join(h, "data"), { recursive: true });
  fs.mkdirSync(path.join(h, "bin"), { recursive: true });
  fs.writeFileSync(path.join(h, ".env"), "SUPABASE_SERVICE_ROLE_KEY=fake\n");
  const local = path.join(h, "local");
  fs.mkdirSync(path.join(local, "config"), { recursive: true });
  fs.writeFileSync(path.join(local, "config", "org.json"), JSON.stringify({ roles: [
    { id: "coord", name: "Ada", title: "Coordinator", chief_of_staff: true },
    { id: "money", name: "Mo", title: "Money" },
  ] }));
  const fakeBin = path.join(h, "fakebin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "curl"), `#!/bin/sh\necho "$@" >> "$CURL_RECORD"\nprintf '%s' 201\n`);
  fs.chmodSync(path.join(fakeBin, "curl"), 0o755);
  const router = path.join(fakeBin, "question-route");
  fs.writeFileSync(router, `process.stdin.resume();process.stdin.on("end",()=>console.log('{"channel":"chat","urgent":false,"question":false}'));`);
  const record = path.join(h, "curl.txt");
  const run = (args) => spawnSync(path.join(KERNEL, "bin/jori-send-curl"), args, {
    encoding: "utf8", timeout: 20_000,
    env: { ...process.env, HOME: h, JORI_HOME: h, JORI_LOCAL_DIR: local, PATH: `${fakeBin}:${process.env.PATH}`, CURL_RECORD: record,
      JORI_SEND_TEST_CURL: path.join(fakeBin, "curl"), JORI_QUESTION_ROUTE_BIN: router,
      JORI_PRECHECK_BYPASS: "1", SUPABASE_SERVICE_ROLE_KEY: "fake", JORI_JOB: "", JORI_SIGN_AS: "" },
  });
  const calls = () => { try { return fs.readFileSync(record, "utf8"); } catch { return ""; } };
  return { h, run, calls };
}

test("jori-send-curl --as-role: that member's conversation, signed as theirs", needsRunner, () => {
  const box = sendBox();
  const r = box.run(["--skip-precheck", "--intent", "hum:stocks", "--as-role", "money", "Micron is down 11% today."]);
  assert.equal(r.status, 0, r.stderr);
  const sent = box.calls();
  assert.match(sent, /"sender":"money"/);
  assert.match(sent, /Mo: Micron is down 11% today\./);
});

test("jori-send-curl --as-role titles the push with the member (a test run never pushes, so read the source)", () => {
  const src = fs.readFileSync(path.join(KERNEL, "bin/jori-send-curl"), "utf8");
  assert.ok(src.includes('NOTIFY_ARGS+=(--title "$AS_ROLE_TITLE")'));
  assert.ok(src.includes('SENDER_ROLE="${ROLE_FLAG:-${AS_ROLE:-}}"'));
});

test("jori-send-curl --as-role: an unknown member or the coordinator changes nothing", needsRunner, () => {
  for (const who of ["nobody", "coord", "Bad Id"]) {
    const box = sendBox();
    const r = box.run(["--skip-precheck", "--intent", "hum:stocks", "--no-push", "--as-role", who, "Micron is down 11% today."]);
    assert.equal(r.status, 0, r.stderr);
    const sent = box.calls();
    assert.ok(!sent.includes('"sender":"nobody"') && !sent.includes('"sender":"Bad Id"'), who);
    assert.ok(!sent.includes("Mo: "), who);
  }
});

// ─── hum-ping passes the route on ───────────────────────────────────────

const FAKE_SENDER = `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
const cap = a[a.indexOf("--capture-id") + 1];
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify(a));
fs.writeFileSync(cap, "msg-901\\n");
`;
const FAKE_ROUTER = `#!${process.execPath}
const fs = require("node:fs");
process.stdin.resume(); let t = ""; process.stdin.on("data", (c) => t += c);
process.stdin.on("end", () => { fs.writeFileSync(process.env.ROUTER_RECORD, JSON.stringify({ argv: process.argv.slice(2), text: t })); console.log(process.env.ROUTE_JSON); });
`;

function pingBox(route) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ping-route-hum-"));
  const bin = path.join(h, "Dev/jori/bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(h, "Dev/jori/data"), { recursive: true });
  for (const [name, src] of [["jori-send-curl", FAKE_SENDER], ["ping-route", FAKE_ROUTER]]) {
    fs.writeFileSync(path.join(bin, name), src);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const rec = path.join(h, "send.json");
  const routerRec = path.join(h, "router.json");
  const r = spawnSync(process.execPath, [path.join(KERNEL, "bin/hum-ping"), "--ping-id", "p-route-1", "--lane", "stocks", "--score", "0.6",
    "--findings", JSON.stringify([{ topic: "stocks", dedup_key: "stocks:MU:test", signal: "MU down 11%" }]),
    "--suppress-hook", "--message", "Micron is down about 11% today."], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HOME: h, JORI_HOME: "", FAKE_RECORD: rec, ROUTER_RECORD: routerRec, ROUTE_JSON: JSON.stringify(route), HUM_NOVELTY_THRESHOLD: "2", HUM_MAX_PINGS_PER_DAY: "99" },
  });
  const feedback = () => { try { return fs.readFileSync(path.join(h, "Dev/jori/data/hum-feedback.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
  return { r, sent: () => JSON.parse(fs.readFileSync(rec, "utf8")), router: () => JSON.parse(fs.readFileSync(routerRec, "utf8")), feedback };
}

test("hum-ping sends a routed ping as that member and records it", () => {
  const box = pingBox({ role: "cfo", coordinator: false, used: "legacy", reason: "stock move" });
  assert.equal(box.r.status, 0, box.r.stderr);
  const argv = box.sent();
  assert.equal(argv[argv.indexOf("--as-role") + 1], "cfo");
  assert.equal(argv[argv.length - 1], "Micron is down about 11% today.", "the message stays last");
  const seen = box.router();
  assert.equal(seen.text, "Micron is down about 11% today.");
  assert.equal(seen.argv[seen.argv.indexOf("--lane") + 1], "stocks");
  assert.equal(seen.argv[seen.argv.indexOf("--intent") + 1], "hum:stocks");
  assert.equal(box.feedback()[0].role, "cfo");
});

test("hum-ping leaves a coordinator route, or a broken router, where pings always went", () => {
  for (const route of [{ role: "cos", coordinator: true, used: "jev" }, "not json"]) {
    const box = pingBox(route);
    assert.equal(box.r.status, 0, box.r.stderr);
    assert.ok(!box.sent().includes("--as-role"));
    assert.equal(box.feedback()[0].role, undefined);
  }
});

test("replies to money and health pings stay off Jev in the reaction classifier too, whatever privacy_exclusions says", async () => {
  const { privateByLabel } = await import("../lib/jev-gates.mjs");
  for (const lane of ["stocks", "finance", "health", "exercise"]) assert.ok(privateByLabel(null, lane), lane);
  assert.equal(privateByLabel(null, "dining"), null);
  const src = fs.readFileSync(path.join(KERNEL, "bin/suggestion-classify"), "utf8");
  assert.ok(src.includes('privateByLabel(null, ping.lane) ? "private-lane-excluded"'));
  assert.ok(!src.includes("privacyOn() && JEV_EXCLUDED_LANES"), "the health exclusion no longer waits on the privacy switch");
});
