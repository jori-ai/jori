// jori-calendar sets Zoom as the event's video conference (2026-11-23).
//
// The owner: "when scheduling a zoom meeting using google calendar … the video
// conferencing field should be set to zoom (automatically connects my link)."
// A create/update whose location or description carries a Zoom join link must
// PATCH the event's conferenceData (addOn "Zoom Meeting"); events without a
// Zoom link, dry runs, and events that already have a conference are untouched.
// Nothing here reaches Google: gog is a fake and the Calendar API is a local server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findZoomLink, findPasscode, parseCreatedId, zoomConferenceData, hasConference } from "../lib/calendar-zoom.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/jori-calendar");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jori-calendar-zoom-"));
const LOG = path.join(TMP, "calendar-writes.jsonl");
const FAKE_GOG = path.join(TMP, "fake-gog.mjs");
fs.writeFileSync(FAKE_GOG, [
  "#!/usr/bin/env node",
  "const a = process.argv.slice(2);",
  'if (a[0] === "calendar" && a[1] === "events") { process.stdout.write(JSON.stringify({ events: [] })); process.exit(0); }',
  'if (a[0] === "calendar" && a[1] === "event") { process.stdout.write(JSON.stringify({ id: a[3], organizer: { self: true }, extendedProperties: { private: { jori_created: "1" } } })); process.exit(0); }',
  'if (a[0] === "calendar" && a[1] === "create") { process.stdout.write("id\\tnewevt123\\nsummary\\tx\\n"); process.exit(0); }',
  "process.exit(0);",
  "",
].join("\n"));
fs.chmodSync(FAKE_GOG, 0o755);

const LINK = "https://us02web.zoom.us/j/7781853221?pwd=eHJ1V0FLdGxIVEpiSHB0Y1YzeTdhdz09";

function api(existing = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.method === "GET" ? existing : { id: "x" }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, calls, base: `http://127.0.0.1:${server.address().port}` })));
}

function run(args, base) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, JORI_CALENDAR_GOG_BIN: FAKE_GOG, JORI_CALENDAR_LOG_FILE: LOG, JORI_CALENDAR_API_BASE: base, JORI_CALENDAR_ACCESS_TOKEN: "test-token" },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (status) => resolve({ status, out, err }));
  });
}

const CREATE = ["create", "--calendar", "primary", "--summary", "Zoom: test", "--from", "2031-01-01T10:00:00-05:00", "--to", "2031-01-01T11:00:00-05:00"];

test("pure helpers", () => {
  assert.deepEqual(findZoomLink(null, `Zoom: ${LINK}.`), { uri: LINK, meetingCode: "7781853221" });
  assert.equal(findZoomLink("Office", "meet.google.com/abc"), null);
  assert.equal(findPasscode("Meeting ID: 1\nPasscode: 463975"), "463975");
  assert.equal(parseCreatedId("id\tabc123\nsummary\tx"), "abc123");
  assert.equal(parseCreatedId('{"event":{"id":"j1"}}'), "j1");
  const cd = zoomConferenceData({ uri: LINK, meetingCode: "7781853221" }, "463975");
  assert.equal(cd.conferenceSolution.key.type, "addOn");
  assert.equal(cd.conferenceSolution.name, "Zoom Meeting");
  assert.equal(cd.entryPoints[0].passcode, "463975");
  assert.equal(hasConference({ hangoutLink: "https://meet.google.com/x" }), true);
  assert.equal(hasConference({ conferenceData: {} }), false);
});

test("create with a Zoom link in the description patches conferenceData on the new event", async () => {
  const { server, calls, base } = await api({});
  const r = await run([...CREATE, "--description", `Zoom: ${LINK}`], base);
  server.close();
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /newevt123/); // gog's output still reaches the caller
  const patch = calls.find((c) => c.method === "PATCH");
  assert.ok(patch, "a PATCH was sent");
  assert.match(patch.url, /\/calendars\/primary\/events\/newevt123\?conferenceDataVersion=1&sendUpdates=none/);
  assert.equal(patch.body.conferenceData.entryPoints[0].uri, LINK);
  assert.equal(patch.auth, "Bearer test-token");
});

test("update with a Zoom location patches the given event", async () => {
  const { server, calls, base } = await api({});
  const r = await run(["update", "evtA", "--calendar", "primary", "--location", LINK], base);
  server.close();
  assert.equal(r.status, 0, r.err);
  assert.ok(calls.some((c) => c.method === "PATCH" && c.url.includes("/events/evtA?")));
});

test("an event that already has a video conference is left alone", async () => {
  const { server, calls, base } = await api({ conferenceData: { entryPoints: [{ entryPointType: "video", uri: LINK }] } });
  const r = await run(["update", "evtB", "--calendar", "primary", "--location", LINK], base);
  server.close();
  assert.equal(r.status, 0, r.err);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});

test("no Zoom link, dry run, or --no-zoom-conference: no API call", async () => {
  const { server, calls, base } = await api({});
  await run([...CREATE, "--description", "lunch"], base);
  await run([...CREATE, "--description", LINK, "--dry-run"], base);
  await run([...CREATE, "--description", LINK, "--no-zoom-conference"], base);
  server.close();
  assert.equal(calls.length, 0);
});
