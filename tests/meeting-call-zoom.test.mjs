// meeting-call-zoom.test.mjs — a recurring meeting's Zoom actuals, from the user's own room
// (lib/meeting-call.mjs, lib/zoom-client.mjs).
//
// The call runs in the user's permanent room, so a Server-to-Server OAuth app on
// the account reads it. Zoom answers first: a call is the instance overlapping
// the calendar slot in which the counterpart was present, at their time in the
// room; a slot Zoom shows they never joined is left out. Anything Zoom cannot
// answer (no keys, 401, timeout, free plan) is null and the calendar ships
// unchanged. Also: the calendar screening, the settle step and the reading
// validator. Synthetic people and ids throughout.
//
// Fixtures are shaped like Zoom's documented responses. NOTHING here touches the
// network: every client gets a fake fetch, and the global one throws.
//
// Run: node --test tests/meeting-call-zoom.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.fetch = () => { throw new Error("a test touched the network"); };

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const zc = await import(path.join(ROOT, "lib/zoom-client.mjs"));
const MC = await import(path.join(ROOT, "lib/meeting-call.mjs"));
const { meetings } = await import(path.join(ROOT, "lib/meetings.mjs"));

// A synthetic recurring meeting: a weekday call with "Sam" in the user's own room.
const M = meetings({ config: { meetings: [{ id: "coach", name: "Sam", calendar_match: ["sam"],
  zoom: { room_id: "1234567890", participant: { emails: ["sam@example.org"], names: ["samlee", "sam lee", "sam"] } } }] } })[0];
const oc = { ...MC, ROOM_ID: M.room_id,
  calendarCandidates: (e, o = {}) => MC.calendarCandidates(e, { m: M, ...o }),
  zoomCalls: (a = {}) => MC.zoomCalls({ m: M, ...a }),
  callsForDay: (o = {}) => MC.callsForDay({ m: M, knownId: null, ...o }),
  matchZoom: (sl, room, o = {}) => MC.matchZoom(sl, room, { ids: M.zoom.participant, name: M.name, ...o }),
  participantMatch: (p) => MC.participantMatch(p, M.zoom.participant),
  zoomMeetingIdOf: (e) => MC.zoomMeetingIdOf(e, M.room_id) };

const TZ = "Asia/Jerusalem";
const ROOM = "https://us02web.zoom.us/j/1234567890?pwd=abc";
const NOW = Date.parse("2026-10-21T08:00:00Z");
// Fake, test-only Zoom credentials (the test asserts they never reach output).
const CREDS = { cfg: { accountId: "ACCTabcdefghijklmnop12", clientId: "CLIENTxyz0123456789ab", clientSecret: "SECRET0123456789abcdef0123456789" }, // gitleaks:allow
                source: "file", problem: null };
const SECRETS = Object.values(CREDS.cfg);

function gogEvent(id, start, end, extra = {}) {
  return { id, recurringEventId: "t34_R20261002T200000", status: "confirmed", summary: "Sam <> Ann",
    location: ROOM, start: { dateTime: start }, end: { dateTime: end }, organizer: { email: "sam@example.org" },
    attendees: [{ email: "owner@example.org", self: true, responseStatus: "accepted" }], ...extra };
}
// Oct 20, abroad: the Monday instance moved to 00:00-00:30, Tuesday's at 23:00-23:30.
const MON = gogEvent("t34_20261019T200000Z", "2026-10-20T00:00:00+03:00", "2026-10-20T00:30:00+03:00");
const TUE = gogEvent("t34_20261020T200000Z", "2026-10-20T23:00:00+03:00", "2026-10-20T23:30:00+03:00");
const slots = (evs = [MON, TUE]) => oc.calendarCandidates(evs, { date: "2026-10-20", tz: TZ });

// ---- a fake Zoom, answering like the documented endpoints ----
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const TOKEN = { access_token: "tok-1", token_type: "bearer", expires_in: 3599, api_url: "https://api.zoom.us",
  scope: "meeting:read:list_past_instances:admin meeting:read:past_meeting:admin meeting:read:list_past_participants:admin" };
const enc = (u) => zc.encodeUuid(u);

function fakeZoom({ instances = [], details = {}, participants = {}, token = TOKEN, override = {} } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    seen.push({ method, url, path: u.pathname, auth: (init.headers || {}).Authorization, body: init.body });
    const key = `${method} ${u.origin}${u.pathname}`;
    if (override[key]) return override[key](u, init);
    if (key === "POST https://zoom.us/oauth/token") return resp(200, token);
    if (key === "GET https://api.zoom.us/v2/past_meetings/1234567890/instances") return resp(200, { meetings: instances });
    for (const [uuid, d] of Object.entries(details)) {
      if (u.pathname === `/v2/past_meetings/${enc(uuid)}`) return resp(200, d);
      if (u.pathname === `/v2/past_meetings/${enc(uuid)}/participants`) {
        return resp(200, { page_count: 1, page_size: 300, total_records: (participants[uuid] || []).length,
                           next_page_token: "", participants: participants[uuid] || [] });
      }
    }
    return resp(404, { code: 3001, message: `Meeting does not exist: ${u.pathname}.` });
  };
  return { fetchImpl, seen };
}
const person = (name, join, leave, extra = {}) => ({ id: "", user_id: "16778240", name, user_email: "", join_time: join,
  leave_time: leave, duration: Math.round((Date.parse(leave) - Date.parse(join)) / 1000), status: "in_meeting", ...extra });
const HOST = "x1yCzABCDEfg23HiJKl4mN";
const detail = (uuid, start, end, count) => ({ id: 1234567890, uuid, type: 4, topic: "Ann Owner's Personal Meeting Room",
  start_time: start, end_time: end, duration: Math.round((Date.parse(end) - Date.parse(start)) / 60000), host_id: HOST,
  participants_count: count, total_minutes: 60, user_name: "Ann Owner", user_email: "owner@example.org", source: "Zoom" });
const owner = (join, leave) => person("Ann Owner", join, leave, { id: HOST, user_email: "owner@example.org", internal_user: true });

// Oct 20 as Zoom showed it (2026-10-21 probe), plus a session before Tuesday's:
// Monday's slot (21:00Z) had the user alone in the room. Before Tuesday's slot, a
// session with Dana; then Sam, in an instance whose UUID starts with a slash
// and has a double slash, after a few seconds in the waiting room.
const W = "kQ3x1TBdRdy0mF2zR8xQ9A==", X = "Vg8IdgluR5WDeWIkpJlElQ==", Y = "/AbC//xyzT0p+9q==";
const OCT20 = {
  instances: [
    { uuid: X, start_time: "2026-10-20T19:30:00Z", occurrence_id: "" },   // listed first: position must not matter
    { uuid: W, start_time: "2026-10-19T21:00:00Z", occurrence_id: "" },
    { uuid: Y, start_time: "2026-10-20T20:01:30Z", occurrence_id: "" },
    { uuid: "old1", start_time: "2026-10-01T20:00:00Z" },
  ],
  details: {
    [W]: detail(W, "2026-10-19T21:00:00Z", "2026-10-19T21:31:00Z", 1),
    [X]: detail(X, "2026-10-20T19:30:00Z", "2026-10-20T19:58:00Z", 2),
    [Y]: detail(Y, "2026-10-20T20:01:30Z", "2026-10-20T20:40:10Z", 2),
  },
  participants: {
    [W]: [owner("2026-10-19T21:00:00Z", "2026-10-19T21:31:00Z")],
    [X]: [owner("2026-10-20T19:30:00Z", "2026-10-20T19:58:00Z"),
          person("Dana Levi", "2026-10-20T19:31:00Z", "2026-10-20T19:58:00Z")],
    [Y]: [owner("2026-10-20T20:01:30Z", "2026-10-20T20:40:10Z"),
          person("samlee", "2026-10-20T20:01:58Z", "2026-10-20T20:02:02Z", { status: "in_waiting_room" }),
          person("samlee", "2026-10-20T20:02:05Z", "2026-10-20T20:40:00Z")],
  },
};
const zoomFor = (fake, extra = {}) => (a) => oc.zoomCalls({ ...a, creds: CREDS, now: NOW, log: () => {},
  client: zc.createZoomClient({ cfg: CREDS.cfg, fetchImpl: fake.fetchImpl }), ...extra });

test("two sessions near Tuesday's slot: the one Sam was in is the call, at their time in the room", async () => {
  const fake = fakeZoom(OCT20);
  let readingAskedFor = null;
  const r = await oc.callsForDay({ date: "2026-10-20", tz: TZ, events: [MON, TUE], flights: [],
    zoom: zoomFor(fake), ensureReading: (calls) => { readingAskedFor = calls; return null; } });
  assert.equal(r.zoom, "answered");
  assert.equal(r.calls.length, 1);
  const c = r.calls[0];
  assert.equal(c.source, "zoom");
  assert.equal(c.status, "held");
  assert.equal(c.start, "2026-10-20T20:02:05.000Z");   // Sam joined, not the session's start
  assert.equal(c.end, "2026-10-20T20:40:00.000Z");
  assert.equal(c.minutes, 38);
  assert.equal(c.evidence.zoom.matched_as, "name");
  assert.deepEqual(c.evidence.zoom.instances.map((i) => i.uuid), [Y]);
  assert.equal(Date.parse(c.calendar.start), Date.parse(TUE.start.dateTime)); // the slot is kept: the event leaves the unmatched list
  // Monday: the user alone in the room, Sam never joined → not printed as having happened
  assert.equal(r.left_out.length, 1);
  assert.equal(r.left_out[0].why, "Zoom shows Sam never joined your room then");
  // Zoom answered both, so the model was not asked to read anything
  assert.equal(readingAskedFor, null);
});

test("a UUID that starts with / or holds // is double-encoded in the path", async () => {
  const fake = fakeZoom(OCT20);
  await zoomFor(fake)({ kept: slots() });
  const twice = encodeURIComponent(encodeURIComponent(Y));
  assert.equal(zc.encodeUuid(Y), twice);
  assert.ok(fake.seen.some((s) => s.path === `/v2/past_meetings/${twice}`));
  assert.ok(fake.seen.some((s) => s.path === `/v2/past_meetings/${twice}/participants`));
  assert.equal(zc.encodeUuid(X), encodeURIComponent(X));   // a plain one is encoded once
  // the token went to Zoom only, once, and the account id rode in the body, not the URL
  const tokenCalls = fake.seen.filter((s) => s.method === "POST");
  assert.equal(tokenCalls.length, 1);
  assert.ok(!tokenCalls[0].url.includes(CREDS.cfg.accountId));
  assert.ok(fake.seen.filter((s) => s.method === "GET").every((s) => s.url.startsWith("https://api.zoom.us/v2/") && s.auth === "Bearer tok-1"));
});

test("Sam only in the waiting room, or nobody in the room at all, is not a call", async () => {
  const waiting = structuredClone(OCT20);
  waiting.participants[Y][2].status = "in_waiting_room";
  waiting.participants[X] = [waiting.participants[X][0]];
  const r1 = await zoomFor(fakeZoom(waiting))({ kept: slots([TUE]) });
  assert.equal(Object.values(r1.byKey)[0].found, false);
  assert.equal(Object.values(r1.byKey)[0].why, "Zoom shows Sam never joined your room then");
  const empty = { ...OCT20, instances: OCT20.instances.filter((i) => i.uuid === "old1") };
  const r2 = await zoomFor(fakeZoom(empty))({ kept: slots([TUE]) });
  assert.equal(Object.values(r2.byKey)[0].why, "Zoom shows no meeting in your room then");
});

test("someone code cannot place (a phone, a new name) or a stray few seconds: the calendar answers, nothing is dropped", async () => {
  const phone = structuredClone(OCT20);
  phone.participants[Y] = [phone.participants[Y][0], person("+1 415 555 0100", "2026-10-20T20:02:05Z", "2026-10-20T20:40:00Z")];
  const r1 = await zoomFor(fakeZoom(phone))({ kept: slots([TUE]) });
  assert.deepEqual(r1.byKey, {});
  const stray = structuredClone(OCT20);
  stray.participants[X] = [stray.participants[X][0]];
  stray.participants[Y][2] = person("samlee", "2026-10-20T20:02:05Z", "2026-10-20T20:02:35Z");
  const r2 = await zoomFor(fakeZoom(stray))({ kept: slots([TUE]) });
  assert.deepEqual(r2.byKey, {});
  // the host is recognised by the host's own user id even under another display name
  assert.equal(oc.matchZoom(slots([TUE]), { meeting_id: "1234567890", instances: [{ uuid: "h", host_id: HOST,
    start_ms: Date.parse("2026-10-20T20:00:00Z"), end_ms: Date.parse("2026-10-20T20:20:00Z"), participants_count: 1,
    participants: [person("MR iPad", "2026-10-20T20:00:00Z", "2026-10-20T20:20:00Z", { id: HOST })] }] })[oc.callKey(slots([TUE])[0])].found, false);
});

test("Sam by their email counts whatever their display name says", async () => {
  const byEmail = structuredClone(OCT20);
  byEmail.participants[Y][2] = { ...byEmail.participants[Y][2], name: "OM iPhone", user_email: "Sam@example.org" };
  const r = await zoomFor(fakeZoom(byEmail))({ kept: slots([TUE]) });
  const z = Object.values(r.byKey)[0];
  assert.equal(z.found, true);
  assert.equal(z.evidence.matched_as, "email");
  assert.equal(oc.participantMatch({ name: "Sam  Lee" }), "name");
  assert.equal(oc.participantMatch({ name: "Sam's assistant" }), null);
});

test("Zoom with a count but no list yet cannot say who joined: the calendar answers that slot", async () => {
  const lag = structuredClone(OCT20);
  lag.participants[Y] = [];
  lag.participants[X] = [];
  const r = await zoomFor(fakeZoom(lag))({ kept: slots([TUE]) });
  assert.deepEqual(r.byKey, {});
});

test("a 401 (token or read), a 404, a timeout, a free plan: null, one log line, the calendar ships", async () => {
  const cases = {
    "token 401": { override: { "POST https://zoom.us/oauth/token": () => resp(401, { reason: "Invalid client_id or client_secret", error: "invalid_client" }) } },
    "read 401": { override: { "GET https://api.zoom.us/v2/past_meetings/1234567890/instances": () => resp(401, { code: 124, message: "Invalid access token." }) } },
    "room 404": { override: { "GET https://api.zoom.us/v2/past_meetings/1234567890/instances": () => resp(404, { code: 3001, message: "Meeting does not exist: 1234567890." }) } },
    "free plan": { override: { [`GET https://api.zoom.us/v2/past_meetings/${enc(Y)}/participants`]:
      () => resp(400, { code: 200, message: `Only available for paid account: ${CREDS.cfg.accountId}.` }) } },
  };
  for (const [name, spec] of Object.entries(cases)) {
    const fake = fakeZoom({ ...OCT20, ...spec });
    const logs = [];
    const r = await oc.callsForDay({ date: "2026-10-20", tz: TZ, events: [TUE], flights: [],
      zoom: zoomFor(fake, { log: (s) => logs.push(s) }) });
    assert.equal(r.calls.length, 1, name);
    assert.equal(r.calls[0].source, "calendar", name);
    assert.equal(r.calls[0].status, "scheduled", name);
    assert.equal(logs.length, 1, name);
    assert.ok(r.zoom.startsWith("failed: "), name);
    for (const s of SECRETS) assert.ok(!logs[0].includes(s) && !r.zoom.includes(s), `${name}: a secret reached the log`);
  }
  // a timeout
  const hang = { fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort",
    () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) };
  const logs = [];
  const r = await oc.zoomCalls({ kept: slots([TUE]), creds: CREDS, now: NOW, log: (s) => logs.push(s),
    client: zc.createZoomClient({ cfg: CREDS.cfg, fetchImpl: hang.fetchImpl, timeoutMs: 20 }) });
  assert.equal(r.byKey, null);
  assert.equal(r.status, "failed: timeout");
  assert.equal(logs.length, 1);
});

test("Zoom's own error text is scrubbed of the three values before anyone sees it", async () => {
  const fake = fakeZoom({ ...OCT20, override: { "GET https://api.zoom.us/v2/past_meetings/1234567890/instances":
    () => resp(400, { code: 200, message: `Only available for paid account: ${CREDS.cfg.accountId}. client ${CREDS.cfg.clientId}` }) } });
  const client = zc.createZoomClient({ cfg: CREDS.cfg, fetchImpl: fake.fetchImpl });
  await assert.rejects(client.pastInstances("1234567890"), (e) => {
    assert.equal(e.kind, "paid_plan_required");
    assert.equal(e.code, 200);
    for (const s of SECRETS) assert.ok(!e.message.includes(s) && !e.detail.includes(s) && !String(e.stack).includes(s));
    assert.ok(e.detail.includes("Only available for paid account: ***"));
    return true;
  });
});

test("no credentials file: no answer, no request, the calendar ships; a file others can read is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zoom-s2s-"));
  const file = path.join(dir, "zoom-s2s.json");
  const none = zc.loadCredentials({ file, env: {} });
  assert.deepEqual(none, { cfg: null, source: null, problem: null });
  let fetched = 0;
  const r = await oc.zoomCalls({ kept: slots([TUE]), creds: none, now: NOW, log: () => {},
    client: zc.createZoomClient({ cfg: CREDS.cfg, fetchImpl: async () => { fetched++; return resp(200, {}); } }) });
  assert.deepEqual(r, { byKey: null, status: "not configured" });
  assert.equal(fetched, 0);
  const cal = await oc.callsForDay({ date: "2026-10-20", tz: TZ, events: [TUE], flights: [],
    zoom: (a) => oc.zoomCalls({ ...a, creds: none }) });
  assert.equal(cal.calls[0].source, "calendar");
  assert.equal(cal.zoom, "not configured");

  zc.writeCredentials(CREDS.cfg, file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(zc.loadCredentials({ file, env: {} }), { ...CREDS, source: "file" });
  fs.chmodSync(file, 0o644);
  const loose = zc.loadCredentials({ file, env: {} });
  assert.equal(loose.cfg, null);
  assert.ok(loose.problem.includes("chmod 600"));
  fs.writeFileSync(file, `{"account_id": "${CREDS.cfg.accountId}", oops`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const bad = zc.loadCredentials({ file, env: {} });
  assert.ok(bad.problem.endsWith("is not valid JSON"));
  for (const s of SECRETS) assert.ok(!bad.problem.includes(s));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the token is cached until it expires, then fetched again", async () => {
  const fake = fakeZoom(OCT20);
  let t = 0;
  const client = zc.createZoomClient({ cfg: CREDS.cfg, fetchImpl: fake.fetchImpl, now: () => t });
  await client.pastInstances("1234567890");
  await client.pastMeeting(X);
  assert.equal(fake.seen.filter((s) => s.method === "POST").length, 1);
  t = 3600 * 1000;
  await client.pastMeeting(X);
  assert.equal(fake.seen.filter((s) => s.method === "POST").length, 2);
  assert.deepEqual(client.scopes(), zc.REQUIRED_SCOPES);
});

test("which room: the event's Zoom link, the user's room when it carries none, nothing for another service", () => {
  assert.equal(oc.zoomMeetingIdOf({ location: ROOM }), "1234567890");
  assert.equal(oc.zoomMeetingIdOf({ location: "us02web.zoom.us/j/5551234567" }), "5551234567");
  assert.equal(oc.zoomMeetingIdOf({}), oc.ROOM_ID);
  assert.equal(oc.zoomMeetingIdOf({ hangoutLink: "https://meet.google.com/abc-defg-hij" }), null);
  assert.equal(oc.zoomMeetingIdOf({ location: "https://evil.example/j/1234567890" }), null);
  assert.equal(slots([TUE])[0].zoom_meeting_id, "1234567890");
});

test("a room empty for 30 days is not trusted, and a slot that ended under 2h ago is not asked about", async () => {
  const r = await zoomFor(fakeZoom({ ...OCT20, instances: [] }))({ kept: slots([TUE]) });
  assert.equal(r.byKey, null);
  const fresh = fakeZoom(OCT20);
  const r2 = await oc.zoomCalls({ kept: slots([TUE]), creds: CREDS, now: Date.parse("2026-10-20T21:00:00Z"), log: () => {},
    client: zc.createZoomClient({ cfg: CREDS.cfg, fetchImpl: fresh.fetchImpl }) });
  assert.equal(r2.byKey, null);
  assert.equal(fresh.seen.length, 0);
});

test("a session that runs across both slots belongs to the one it overlaps most", () => {
  const a = { start_ms: Date.parse("2026-10-20T20:00:00Z"), end_ms: Date.parse("2026-10-20T20:30:00Z"), start: "a" };
  const b = { start_ms: Date.parse("2026-10-20T20:45:00Z"), end_ms: Date.parse("2026-10-20T21:15:00Z"), start: "b" };
  a.start = new Date(a.start_ms).toISOString(); b.start = new Date(b.start_ms).toISOString();
  const inst = { uuid: "u", start_ms: Date.parse("2026-10-20T20:05:00Z"), end_ms: Date.parse("2026-10-20T20:40:00Z"),
    participants: [person("samlee", "2026-10-20T20:05:00Z", "2026-10-20T20:40:00Z")] };
  const out = oc.matchZoom([a, b], { meeting_id: "1234567890", instances: [inst] });
  assert.equal(out[oc.callKey(a)].found, true);
  assert.equal(out[oc.callKey(b)].found, false);
  assert.equal(out[oc.callKey(b)].why, "Zoom shows the call with Sam at its other calendar time");
});

// ---- the calendar rung, the reading the model is shown, and the settle step ----

const MOVED = gogEvent("t34_20261019T200000Z", "2026-10-20T00:00:00+03:00", "2026-10-20T00:30:00+03:00",
  { originalStartTime: { dateTime: "2026-10-19T23:00:00+03:00" } });

test("a moved instance is read at its new time; a call straddling midnight belongs to the day it began", () => {
  const c = oc.calendarCandidates([MOVED, TUE], { date: "2026-10-20", tz: TZ });
  assert.equal(c.length, 2);
  assert.equal(c[0].start, "2026-10-19T21:00:00.000Z");
  assert.equal(c[0].moved_from, "2026-10-19T20:00:00.000Z");
  const late = gogEvent("t34_late", "2026-10-20T23:45:00+03:00", "2026-10-21T00:15:00+03:00");
  assert.equal(oc.calendarCandidates([late], { date: "2026-10-20", tz: TZ }).length, 1);
  assert.equal(oc.calendarCandidates([late], { date: "2026-10-21", tz: TZ }).length, 0);
});

test("an in-person event naming the counterpart is not a call: only the series or a video link counts", () => {
  const dinner = { id: "d1", summary: "Dinner with Sam", location: "A restaurant, Main St",
    start: { dateTime: "2026-10-20T20:00:00+03:00" }, end: { dateTime: "2026-10-20T21:00:00+03:00" } };
  const board = { id: "b1", summary: "Board meeting", location: "The office", attendees: [{ email: "sam@example.org" }],
    start: { dateTime: "2026-10-20T15:00:00+03:00" }, end: { dateTime: "2026-10-20T16:00:00+03:00" } };
  const meet = { id: "m1", summary: "Sam sync", hangoutLink: "https://meet.google.com/abc",
    start: { dateTime: "2026-10-20T12:00:00+03:00" }, end: { dateTime: "2026-10-20T12:30:00+03:00" } };
  const series = { id: "t34_20261020T090000Z", recurringEventId: "t34_R1", summary: "Weekly sync",
    start: { dateTime: "2026-10-20T09:00:00+03:00" }, end: { dateTime: "2026-10-20T09:30:00+03:00" } };
  const got = oc.calendarCandidates([dinner, board, meet, series], { date: "2026-10-20", tz: TZ, knownId: "t34_R1" });
  assert.deepEqual(got.map((c) => c.event_id), ["t34_20261020T090000Z", "m1"]);
});

test("a cancelled, declined or in-flight instance is left out by code, with why", () => {
  const cancelled = gogEvent("a", "2026-10-20T23:00:00+03:00", "2026-10-20T23:30:00+03:00", { status: "cancelled" });
  const declined = gogEvent("b", "2026-10-20T12:00:00+03:00", "2026-10-20T12:30:00+03:00",
    { attendees: [{ email: "owner@example.org", self: true, responseStatus: "declined" }] });
  const flying = gogEvent("c", "2026-10-20T16:00:00+03:00", "2026-10-20T16:30:00+03:00");
  const flights = [{ metro: "transit", place_label: "AAA→BBB", arrive_at: "2026-10-20T12:30:00Z", depart_at: "2026-10-20T23:00:00Z" }];
  const { kept, left_out } = oc.screenCandidates(oc.calendarCandidates([cancelled, declined, flying], { date: "2026-10-20", tz: TZ }), { flights });
  assert.equal(kept.length, 0);
  assert.deepEqual(left_out.map((c) => c.why).sort(), [
    "cancelled on the calendar", "you declined it on the calendar", "you were on a flight then (AAA→BBB)"]);
});

test("the reading: both clocks in words, each call's own notes heading, quotes checked against what was shown", () => {
  const home = "Europe/London";
  const c = oc.calendarCandidates([MOVED, TUE], { date: "2026-10-20", tz: TZ });
  assert.equal(MC.callWhen(c[0], TZ, home),
    "Tuesday, Oct 20, 12:00am to 12:30am local time (Monday, Oct 19, 10:00pm to 10:30pm London time)");
  const st = MC.readingState(c, { tz: TZ, home, notes: "", words: [] });
  assert.deepEqual(st.calls.map((x) => x.notes_heading), ["### 2026-10-19", "### 2026-10-20"]);
  const notes = "## To Discuss (Upcoming)\n- [ ] x\n\n## Discussed\n\n### 2026-07-17\n- No call today, Sam was travelling.\n\n### 2026-07-16\n- Offer discussed.\n";
  assert.equal(MC.notesForDates(notes, ["2026-07-17"]), "### 2026-07-17\n- No call today, Sam was travelling.");
  const state = { calls: [{ id: "c0", when: "Friday" }], notes: MC.notesForDates(notes, ["2026-07-17"]), user_words: [] };
  assert.equal(MC.validateReading({ calls: [{ id: "c0", verdict: "not_held", quote: "No call today" }] }, state), null);
  // lang-regex-ok: asserts on our own validator's error string
  assert.match(MC.validateReading({ calls: [{ id: "c0", verdict: "not_held", quote: "Sam was sick" }] }, state), /not in what it was shown/);
  // lang-regex-ok: asserts on our own validator's error string
  assert.match(MC.validateReading({ calls: [] }, state), /no answer for c0/);
  assert.deepEqual(MC.userWords({ corrections: [{ evidence: "we skipped it" }], places: [{ evidence: "Cafe" }] }), ["we skipped it", "Cafe"]);
});

test("settle: no reading → scheduled; not_held → left out; held → held; a missing reading file is null", () => {
  const cands = oc.calendarCandidates([MOVED, TUE], { date: "2026-10-20", tz: TZ });
  assert.deepEqual(MC.settleCalls(cands, null, { who: "Sam" }).calls.map((c) => [c.who, c.status]), [["Sam", "scheduled"], ["Sam", "scheduled"]]);
  const reading = { read_by: "sonnet", verdicts: { [MC.callKey(cands[0])]: { verdict: "not_held" }, [MC.callKey(cands[1])]: { verdict: "held" } } };
  const r = MC.settleCalls(cands, reading);
  assert.deepEqual(r.calls.map((c) => c.status), ["held"]);
  assert.equal(r.left_out[0].why, "your notes or your own words say it did not happen");
  assert.equal(MC.readReading(M, "2026-10-20", cands, "/nonexistent/calls.json"), null);
  assert.ok(MC.readingPath(M, "2026-10-20", "/tmp").endsWith("/meeting-coach-calls-2026-10-20.json"));
});
