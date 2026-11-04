// meeting-call-render.test.mjs — a recurring meeting's Zoom answer, as the
// daily summary prints it (lib/meeting-call.mjs → lib/daily-summary-render.js).
//
// When Zoom answers, the call line carries Zoom's times and "ran N min", with no
// "calendar times" caveat; the slot Zoom matched leaves the unmatched-events
// list, while a slot the counterpart never joined stays there; the manifest
// records the source. The Zoom provider itself is in meeting-call-zoom.test.mjs.
// Synthetic people, room and ids; nothing touches the network.
//
// Run: node --test tests/meeting-call-render.test.mjs

import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

globalThis.fetch = () => { throw new Error("a test touched the network"); };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const zc = await import(path.join(ROOT, "lib/zoom-client.mjs"));
const MC = await import(path.join(ROOT, "lib/meeting-call.mjs"));
const { meetings } = await import(path.join(ROOT, "lib/meetings.mjs"));
const render = require(path.join(ROOT, "lib/daily-summary-render.js"));
const { eventsNotMatched } = render._internal;

const M = meetings({ config: { meetings: [{ id: "coach", name: "Sam", calendar_match: ["sam"],
  zoom: { room_id: "1234567890", participant: { emails: ["sam@example.org"], names: ["samlee", "sam lee", "sam"] } } }] } })[0];
const oc = { zoomCalls: (a = {}) => MC.zoomCalls({ m: M, ...a }), callsForDay: (o = {}) => MC.callsForDay({ m: M, knownId: null, ...o }) };

const TZ = "Europe/Athens"; // UTC+3 on the fixture day
const ROOM = "https://us02web.zoom.us/j/1234567890?pwd=abc";
const NOW = Date.parse("2026-10-21T08:00:00Z");
const CREDS = { cfg: { accountId: "ACCTabcdefghijklmnop12", clientId: "CLIENTxyz0123456789ab", clientSecret: "SECRET0123456789abcdef0123456789" }, // gitleaks:allow
                source: "file", problem: null };

function gogEvent(id, start, end) {
  return { id, recurringEventId: "t34_R20261002T200000", status: "confirmed", summary: "Sam <> Ann",
    location: ROOM, start: { dateTime: start }, end: { dateTime: end }, organizer: { email: "sam@example.org" },
    attendees: [{ email: "owner@example.org", self: true, responseStatus: "accepted" }] };
}
const MON = gogEvent("t34_20261019T200000Z", "2026-10-20T00:00:00+03:00", "2026-10-20T00:30:00+03:00");
const TUE = gogEvent("t34_20261020T200000Z", "2026-10-20T23:00:00+03:00", "2026-10-20T23:30:00+03:00");

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const TOKEN = { access_token: "tok-1", token_type: "bearer", expires_in: 3599, api_url: "https://api.zoom.us",
  scope: "meeting:read:list_past_instances:admin meeting:read:past_meeting:admin meeting:read:list_past_participants:admin" };
function fakeZoom({ instances = [], details = {}, participants = {} }) {
  return { fetchImpl: async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    const key = `${method} ${u.origin}${u.pathname}`;
    if (key === "POST https://zoom.us/oauth/token") return resp(200, TOKEN);
    if (key === "GET https://api.zoom.us/v2/past_meetings/1234567890/instances") return resp(200, { meetings: instances });
    for (const [uuid, d] of Object.entries(details)) {
      if (u.pathname === `/v2/past_meetings/${zc.encodeUuid(uuid)}`) return resp(200, d);
      if (u.pathname === `/v2/past_meetings/${zc.encodeUuid(uuid)}/participants`) {
        return resp(200, { page_count: 1, page_size: 300, total_records: (participants[uuid] || []).length,
          next_page_token: "", participants: participants[uuid] || [] });
      }
    }
    return resp(404, { code: 3001, message: "Meeting does not exist." });
  } };
}
const person = (name, join, leave, extra = {}) => ({ id: "", user_id: "16778240", name, user_email: "", join_time: join,
  leave_time: leave, duration: Math.round((Date.parse(leave) - Date.parse(join)) / 1000), status: "in_meeting", ...extra });
const HOST = "x1yCzABCDEfg23HiJKl4mN";
const detail = (uuid, start, end, count) => ({ id: 1234567890, uuid, type: 4, topic: "Ann Owner's Personal Meeting Room",
  start_time: start, end_time: end, duration: Math.round((Date.parse(end) - Date.parse(start)) / 60000), host_id: HOST,
  participants_count: count, total_minutes: 60, user_name: "Ann Owner", user_email: "owner@example.org", source: "Zoom" });
const owner = (join, leave) => person("Ann Owner", join, leave, { id: HOST, user_email: "owner@example.org", internal_user: true });

// Monday's slot: the user alone in the room. Tuesday: a session with Dana, then Sam.
const W = "kQ3x1TBdRdy0mF2zR8xQ9A==", X = "Vg8IdgluR5WDeWIkpJlElQ==", Y = "/AbC//xyzT0p+9q==";
const DAY = {
  instances: [{ uuid: X, start_time: "2026-10-20T19:30:00Z" }, { uuid: W, start_time: "2026-10-19T21:00:00Z" }, { uuid: Y, start_time: "2026-10-20T20:01:30Z" }],
  details: { [W]: detail(W, "2026-10-19T21:00:00Z", "2026-10-19T21:31:00Z", 1),
    [X]: detail(X, "2026-10-20T19:30:00Z", "2026-10-20T19:58:00Z", 2), [Y]: detail(Y, "2026-10-20T20:01:30Z", "2026-10-20T20:40:10Z", 2) },
  participants: {
    [W]: [owner("2026-10-19T21:00:00Z", "2026-10-19T21:31:00Z")],
    [X]: [owner("2026-10-20T19:30:00Z", "2026-10-20T19:58:00Z"), person("Dana Levi", "2026-10-20T19:31:00Z", "2026-10-20T19:58:00Z")],
    [Y]: [owner("2026-10-20T20:01:30Z", "2026-10-20T20:40:10Z"), person("samlee", "2026-10-20T20:02:05Z", "2026-10-20T20:40:00Z")],
  },
};
const zoom = (a) => oc.zoomCalls({ ...a, creds: CREDS, now: NOW, log: () => {},
  client: zc.createZoomClient({ cfg: CREDS.cfg, fetchImpl: fakeZoom(DAY).fetchImpl }) });

function dayOf(calls, left_out = []) {
  const stop = (id, s, e, title) => ({ id, start: s, end: e, start_ts_ms: Date.parse(`2026-10-20T${s}:00+03:00`),
    end_ts_ms: Date.parse(`2026-10-20T${e}:00+03:00`), duration_min: 60, place: { name: title, source: "confirmed_stop" },
    companions: [], provenance: { title, certainty: "known", title_kind: "venue", tier: "CONFIRMED" } });
  return { date: "2026-10-20", tz: TZ, tzs: [TZ], stops: [stop("s-p1", "00:09", "08:50", "The Rental Flat"),
    stop("s-p4", "22:16", "23:59", "The Rental Flat")], calls, calls_left_out: left_out, photos: [],
    unmatched_calendar_events: [
      { summary: "Sam <> Ann", start: "2026-10-20T00:00:00+03:00", end: "2026-10-20T00:30:00+03:00", location: ROOM, physical: false },
      { summary: "Sam <> Ann", start: "2026-10-20T23:00:00+03:00", end: "2026-10-20T23:30:00+03:00", location: ROOM, physical: false }],
    path: { spine: [] } };
}

test("the email line reads 'ran 38 min' at Zoom's times, with no calendar caveat", async () => {
  const r = await oc.callsForDay({ date: "2026-10-20", tz: TZ, events: [MON, TUE], flights: [], zoom, ensureReading: () => null });
  assert.equal(r.zoom, "answered");
  const day = dayOf(r.calls, r.left_out);
  const html = render.assemble(render.buildSkeleton(day, {}), {});
  assert.ok(html.includes("<b>11:02pm-11:40pm</b> Call with Sam · ran 38 min</li>"), html);
  assert.equal(render._internal.callParts(day, { ...r.calls[0], minutes: 69 }).len, "ran 1h 9m");
  assert.ok(!html.includes("calendar times"));
  assert.equal(html.split('class="call"').length - 1, 1);
  // Tuesday's event is that line now; Monday's (Sam never came) stays an unmatched event.
  assert.deepEqual(eventsNotMatched(day).map((e) => e.start), ["2026-10-20T00:00:00+03:00"]);
  const m = render.buildManifest(day, {});
  assert.equal(m.calls[0].source, "zoom");
  assert.ok(m.calls[0].line.includes("ran 38 min"));
});
