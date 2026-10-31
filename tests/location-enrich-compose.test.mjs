import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A synthetic installation: the companion a question may name, and one never named.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-compose-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "config", "location-ask.json"), JSON.stringify({ partner: "Sam", never_mention: ["Rover"] }));
fs.writeFileSync(path.join(LOCAL, "instance.json"), JSON.stringify({ owner_name: "Alex" }));
process.env.JORI_LOCAL_DIR = LOCAL;
const {
  candidateList, buildItems, calendarBlockers, identifyMessage, checkAsk, validateAsks, promptFacts, systemPrompt, SYSTEM_PROMPT,
} = await import("../lib/location-enrich-compose.mjs");
const { features } = await import("../lib/location-enrich-gate.mjs");

const pendingRow = {
  visit_id: "v1",
  arrived_at: "2026-10-04T16:10:00Z",
  departed_at: "2026-10-04T17:05:00Z",
  companions: ["Sam"],
  candidates: [
    { name: "Noodle Village", type: "Restaurant", rating: 4.5, distance_m: 12.4 },
    { place_name: "Corner Cafe", type: "Cafe", rating: 4.1, distance_m: 30 },
  ],
};
const briefStop = {
  visit_id: "v1", stage: "confirm", arrived_local: "12:10", departed_local: "13:05",
  duration_min: 55, time_of_day: "lunch", duration_shape: "proper_meal_gym_appointment",
  movement_led: false, drift_m: 12, with_partner: true, food_heavy: true, top_candidate_confident: true,
};

const item = () => buildItems({ stops: [briefStop] }, [pendingRow])[0];

test("candidateList gives stable ids and accepts place_name", () => {
  const c = candidateList(pendingRow);
  assert.deepEqual(c.map((x) => x.id), ["c1", "c2"]);
  assert.equal(c[1].name, "Corner Cafe");
  assert.equal(c[0].distance_m, 12);
});

test("buildItems joins brief features with the pending row", () => {
  const it = item();
  assert.equal(it.arrived_local, "12:10");
  assert.equal(it.candidates.length, 2);
  assert.equal(it.departed_at, pendingRow.departed_at);
  assert.equal(buildItems({ stops: [{ visit_id: "nope" }] }, [pendingRow]).length, 0);
});

test("calendarBlockers: a short timed event in the window blocks", () => {
  const ev = { summary: "Show", start: { dateTime: "2026-10-04T16:30:00Z" }, end: { dateTime: "2026-10-04T18:00:00Z" } };
  assert.equal(calendarBlockers(item(), [ev]).length, 1);
});

test("calendarBlockers: containers, all-day, transparent and distant events don't", () => {
  const container = { start: { dateTime: "2026-10-04T13:00:00Z" }, end: { dateTime: "2026-10-04T19:00:00Z" } };
  const allDay = { start: { date: "2026-10-04" }, end: { date: "2026-10-05" } };
  const free = { transparency: "transparent", start: { dateTime: "2026-10-04T16:30:00Z" }, end: { dateTime: "2026-10-04T17:00:00Z" } };
  const later = { start: { dateTime: "2026-10-04T19:00:00Z" }, end: { dateTime: "2026-10-04T20:00:00Z" } };
  assert.equal(calendarBlockers(item(), [container, allDay, free, later]).length, 0);
});

test("calendarBlockers pads the window by 15 minutes", () => {
  const justAfter = { start: { dateTime: "2026-10-04T17:15:00Z" }, end: { dateTime: "2026-10-04T18:00:00Z" } };
  assert.equal(calendarBlockers(item(), [justAfter]).length, 1);
});

test("identifyMessage is the playbook list with the local time", () => {
  const m = identifyMessage(item());
  assert.match(m, /around 12:10/);
  assert.match(m, /1\. Noodle Village — Restaurant · 4\.5★ · 12m/);
  assert.match(m, /what did you order/);
});

const good = {
  visit_id: "v1", hypothesis_candidate_id: "c1", framing: "venue",
  message: "Was Noodle Village your 12:10 lunch with Sam? ~55m there. If not, what was it?",
};

test("checkAsk accepts a grounded ask", () => {
  assert.equal(checkAsk(good, item()), null);
});

test("checkAsk rejects a hypothesis that is not a candidate", () => {
  assert.match(checkAsk({ ...good, hypothesis_candidate_id: "c9" }, item()), /not one of the candidates/);
});

test("checkAsk rejects a hypothesis the message doesn't name", () => {
  assert.match(checkAsk({ ...good, hypothesis_candidate_id: "c2" }, item()), /not named/);
});

test("checkAsk rejects a message without the computed local time", () => {
  const wrongTime = { ...good, message: "Was Noodle Village your 8:10 lunch with Sam? If not, what was it?" };
  const why = checkAsk(wrongTime, item());
  assert.match(why, /local time/);
});

test("checkAsk requires walking framing when movement_led", () => {
  const it = { ...item(), movement_led: true };
  assert.match(checkAsk(good, it), /walking/);
  assert.equal(checkAsk({ ...good, framing: "walking" }, it), null);
});

test("checkAsk enforces length and enum", () => {
  const short = { ...good, message: "12:10?" };
  const long = { ...good, message: "12:10 " + "x".repeat(400) };
  const whyShort = checkAsk(short, item());
  const whyLong = checkAsk(long, item());
  assert.match(whyShort, /too short/);
  assert.match(whyLong, /too long/);
  assert.match(checkAsk({ ...good, framing: "calendar" }, item()), /enum/);
});

test("validateAsks splits valid, invalid and missing", () => {
  const items = [item(), { ...item(), visit_id: "v2" }];
  const { valid, invalid } = validateAsks({ asks: [good, { ...good, visit_id: "zzz" }] }, items);
  assert.ok(valid.has("v1"));
  assert.equal(invalid.get("v2"), "missing from model output");
  assert.equal(invalid.has("zzz"), false);
});

test("validateAsks tolerates garbage", () => {
  const { valid, invalid } = validateAsks(null, [item()]);
  assert.equal(valid.size, 0);
  assert.equal(invalid.size, 1);
});

test("promptFacts carries no raw coordinates or timestamps", () => {
  const f = promptFacts(item());
  assert.equal("arrived_at" in f, false);
  assert.equal("companions" in f, false);
  assert.equal(f.with_partner, true);
});

test("the prompt names the configured partner, never the quiet companions, and the owner", () => {
  assert.match(SYSTEM_PROMPT, /Jori asks Alex/);
  assert.match(SYSTEM_PROMPT, /with_partner true → mention Sam naturally/);
  assert.match(SYSTEM_PROMPT, /Never mention Rover\./);
  const bare = systemPrompt({ who: "the user", config: { partner: "", never_mention: [] } });
  assert.doesNotMatch(bare, /with_partner true/, "no partner configured: no partner rule");
  assert.doesNotMatch(bare, /Never mention/);
});

test("the gate flags with_partner only for the configured partner", () => {
  const row = { visit_id: "x", arrived_at: "2026-07-19T12:58:46Z", departed_at: "2026-07-19T13:40:00Z", duration_min: 41 };
  assert.equal(features({ ...row, companions: ["sam"] }, "UTC").with_partner, true);
  assert.equal(features({ ...row, companions: ["Rover"] }, "UTC").with_partner, false);
});
