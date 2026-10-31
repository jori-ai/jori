// stop-evidence.test.mjs — between the image content, the GPS and what the user
// said about it, the location should have been certain (a 14:24 lunch the user
// was asked about an hour after telling us). Synthetic coordinates and names.
// Run: node --test tests/stop-evidence.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.JORI_ATTACHMENTS_BUCKET = "test-attachments"; // the bucket name is an instance setting (lib/instance.cjs)

// A synthetic installation, set before the module reads the owner's name.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "stop-evidence-"));
fs.writeFileSync(path.join(LOCAL, "instance.json"), JSON.stringify({ owner_name: "Alex" }));
process.env.JORI_LOCAL_DIR = LOCAL;
const {
  readJpegExif, exifTimeMs, exifFix, attachmentUrl, buildCandidates, hasDirectEvidence,
  acceptLegacy, interpretJev, decideVenue, evidenceVerdict, buildState, askSonnet,
} = await import("../lib/stop-evidence.mjs");

// Synthetic coordinates: metres east/north of an obviously fake origin, so the
// fixtures keep the real traces' geometry without pinning a real place.
const ORIGIN = [12.3456, -65.4321];
const M_PER_DEG = 6371000 * Math.PI / 180;
const fakePt = (e, n) => { const lat = ORIGIN[0] + n / M_PER_DEG; return [lat, ORIGIN[1] + e / (M_PER_DEG * Math.cos(lat * Math.PI / 180))]; };
const fakeAt = (e, n) => { const [lat, lon] = fakePt(e, n); return { lat, lon }; };
const fakeRow = (e, n) => { const [latitude, longitude] = fakePt(e, n); return { latitude, longitude }; };

// Where he sat (stop-passage longest_rest_at) and the visit row's centroid, 101 m off.
const REST = { ...fakeAt(0, 0) };
const CENTROID = { ...fakeAt(-96.69, -28.71) };
const START = Date.parse("2026-10-08T11:24:05Z"), END = Date.parse("2026-10-08T12:29:37Z");
const TZ = "Asia/Jerusalem";

// --- a minimal little-endian EXIF JPEG: IFD0 → ExifIFD (DateTimeOriginal, OffsetTimeOriginal) + GPS IFD.
function jpegWithExif({ lat, lon, dt, offset }) {
  const entries = (n) => 2 + n * 12 + 4;
  const ifd0At = 8, exifAt = ifd0At + entries(2), gpsAt = exifAt + entries(offset ? 2 : 1);
  let dataAt = gpsAt + entries(4);
  const t = Buffer.alloc(dataAt + 200);
  t.write("II", 0, "latin1"); t.writeUInt16LE(42, 2); t.writeUInt32LE(ifd0At, 4);
  const entry = (at, i, tag, type, count, val) => {
    const e = at + 2 + i * 12;
    t.writeUInt16LE(tag, e); t.writeUInt16LE(type, e + 2); t.writeUInt32LE(count, e + 4);
    if (typeof val === "number") t.writeUInt32LE(val, e + 8); else val(e + 8);
  };
  const putAscii = (s) => { const at = dataAt; t.write(s + "\0", at, "latin1"); dataAt += s.length + 1; return at; };
  const putRat = (vals) => { const at = dataAt; vals.forEach(([n, d], i) => { t.writeUInt32LE(n, at + i * 8); t.writeUInt32LE(d, at + i * 8 + 4); }); dataAt += vals.length * 8; return at; };
  const dms = (x) => { const d = Math.floor(x), mf = (x - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60 * 10000); return [[d, 1], [m, 1], [s, 10000]]; };
  t.writeUInt16LE(2, ifd0At);
  entry(ifd0At, 0, 0x8769, 4, 1, exifAt);
  entry(ifd0At, 1, 0x8825, 4, 1, gpsAt);
  t.writeUInt16LE(offset ? 2 : 1, exifAt);
  entry(exifAt, 0, 0x9003, 2, dt.length + 1, putAscii(dt));
  if (offset) entry(exifAt, 1, 0x9011, 2, offset.length + 1, putAscii(offset));
  t.writeUInt16LE(4, gpsAt);
  entry(gpsAt, 0, 1, 2, 2, (o) => t.write(lat >= 0 ? "N\0" : "S\0", o, "latin1"));
  entry(gpsAt, 1, 2, 5, 3, putRat(dms(Math.abs(lat))));
  entry(gpsAt, 2, 3, 2, 2, (o) => t.write(lon >= 0 ? "E\0" : "W\0", o, "latin1"));
  entry(gpsAt, 3, 4, 5, 3, putRat(dms(Math.abs(lon))));
  const tiff = t.subarray(0, dataAt);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]);
}

test("EXIF: reads GPS and capture time from the photo the user shared", () => {
  const buf = jpegWithExif({ ...fakeAt(1.11, 11.2), dt: "2026:10:08 14:47:55", offset: "+03:00" });
  const ex = readJpegExif(buf);
  assert.ok(Math.abs(ex.lat - fakePt(1.11, 11.2)[0]) < 1e-5 && Math.abs(ex.lon - fakePt(1.11, 11.2)[1]) < 1e-5);
  assert.equal(exifTimeMs(ex, TZ), Date.parse("2026-10-08T11:47:55Z"));
});

test("EXIF: no offset tag → the wall time is read in the day's timezone", () => {
  const ex = readJpegExif(jpegWithExif({ ...fakeAt(0, 0), dt: "2026:10:08 14:47:55" }));
  assert.equal(exifTimeMs(ex, TZ), Date.parse("2026-10-08T11:47:55Z"));
});

test("EXIF: a stripped re-encode (the share-sheet bug) yields no fix, and nothing throws", () => {
  assert.equal(readJpegExif(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(readJpegExif(Buffer.from("not a jpeg")), null);
  assert.equal(exifFix({ exif: null, sentAt: START, rest: REST, start: START, end: END, tz: TZ }), null);
});

test("a sent photo is a camera fix only near where he rested and inside the window", () => {
  const at = { ...fakeAt(1.11, 11.2), datetime_original: "2026:10:08 14:47:55", offset: "+03:00" };
  const fix = exifFix({ exif: at, sentAt: Date.parse("2026-10-08T12:00:57Z"), rest: REST, start: START, end: END, tz: TZ });
  assert.ok(fix && fix.distance_m < 20 && fix.time_from === "exif");
  // 300 m away → not this stop.
  assert.equal(exifFix({ exif: { ...at, lat: fakePt(1.11, 297.5)[0] }, sentAt: START, rest: REST, start: START, end: END, tz: TZ }), null);
  // Taken the day before → not this stop, even at the same spot.
  assert.equal(exifFix({ exif: { ...at, datetime_original: "2026:10:07 14:47:55" }, sentAt: START, rest: REST, start: START, end: END, tz: TZ }), null);
});

test("attachment links are recognised by their storage path, nothing else", () => {
  assert.ok(attachmentUrl("https://example-project.supabase.co/storage/v1/object/public/test-attachments/8079728F/photo.jpg"));
  assert.equal(attachmentUrl("Having lunch here today"), null);
  assert.equal(attachmentUrl("https://example.com/photo.jpg"), null);
  assert.equal(attachmentUrl("https://example-project.supabase.co/storage/v1/object/public/test-attachments/x/doc.pdf"), null);
});

test("candidates are measured from the REST, so the restaurant 20 m from him is in and ranked first", () => {
  const google = [
    { name: "צמרת - מפות ומפיות", primary_type: "store", ...fakeAt(-95.97, -27.16) },          // 3 m from the centroid, ~95 m from him
    { name: "גריל הפינה", primary_type: "restaurant", ...fakeAt(-20.64, -2.21), reviews: 3264 },
  ];
  const c = buildCandidates({ rest: REST, google, photoPoints: [{ ...fakeAt(1.11, 11.2) }] });
  assert.equal(c[0].name, "גריל הפינה");
  assert.ok(c[0].from_rest_m <= 25);
  assert.ok(!c.some((x) => x.name.startsWith("צמרת")), "the shop by the centroid is outside 60 m of where he sat");
  // From the centroid the same list would have offered the shop and not the restaurant's 80 m.
  const fromCentroid = buildCandidates({ rest: CENTROID, google });
  assert.equal(fromCentroid[0].name.startsWith("צמרת"), true);
});

test("Apple POIs join the list and dedupe against Google's listing of the same place", () => {
  const google = [{ name: "Corner Grill restaurant", primary_type: "restaurant", ...fakeAt(-20.64, -2.21) }];
  const c = buildCandidates({ rest: REST, google, applePois: [
    { name: "Corner Grill", category: "restaurant", ...fakeAt(-19.62, -1.59) },
    { name: "Panorama Center", category: "mall", ...fakeAt(3, 8.42) },
  ] });
  assert.equal(c.length, 2);
  assert.deepEqual(c.find((x) => x.name.startsWith("Corner")).sources.sort(), ["apple", "google"]);
});

test("no word of his and no photo → no decision at all", () => {
  assert.equal(hasDirectEvidence({ transcript: [{ who: "Jori", text: "P1 email" }], photos: [] }), false);
  assert.equal(hasDirectEvidence({ transcript: [{ who: "Alex", text: "hi" }], photos: [] }), true);
  assert.equal(hasDirectEvidence({ transcript: [], photos: [{}] }), true);
});

const CANDS = [{ id: "c0", name: "גריל הפינה", sources: ["google"] }, { id: "c1", name: "METRO CITY", sources: ["google"] }];

test("fallback answers settle only when grounded and confident", () => {
  assert.equal(acceptLegacy({ venue: "Corner Grill", listed_id: "c0", named_by: "jori_accepted", confidence: 0.95 }, CANDS).name, "גריל הפינה");
  assert.equal(acceptLegacy({ venue: "Corner Grill", listed_id: null, named_by: "jori_accepted", confidence: 0.95 }, CANDS).name, "Corner Grill");
  assert.equal(acceptLegacy({ venue: "Corner Grill", listed_id: "c0", named_by: "jori_accepted", confidence: 0.6 }, CANDS), null);
  assert.equal(acceptLegacy({ venue: "Somewhere", listed_id: "c0", named_by: "phone_guess", confidence: 0.99 }, CANDS), null, "a phone guess alone never settles");
  assert.equal(acceptLegacy({ venue: "Café X", listed_id: null, named_by: "photo_sign", confidence: 0.95 }, CANDS), null, "an unlisted name needs his words");
  assert.equal(acceptLegacy({ venue: null, named_by: "none", confidence: 0.9 }, CANDS), null);
});

test("Jev picks map to venues; unlisted and none never name the stop", () => {
  const conf = (a) => a.confidence;
  assert.equal(interpretJev({ venue: { choice: "c0", confidence: 0.93 } }, CANDS, conf).value.name, "גריל הפינה");
  assert.equal(interpretJev({ venue: { choice: "unlisted", confidence: 0.99 } }, CANDS, conf).value, null);
  assert.equal(interpretJev({ venue: { choice: "none", confidence: 0.9 } }, CANDS, conf).value.name, null);
});

// A decide() stub that mimics jev-shadow: Jev's value if confident, else legacy().
const stubDecide = (jevAnswer, threshold = 0.85) => async (o) => {
  const it = jevAnswer ? o.interpret({ venue: jevAnswer }) : { value: null, confidence: 0 };
  if (it.confidence >= threshold) return { value: it.value, used: "jev" };
  return { value: await o.legacy(), used: "legacy" };
};

test("decideVenue: a confident Jev pick settles; 'unlisted' falls through to the speller", async () => {
  const state = { chat: [] };
  const a = await decideVenue({ state, candidates: CANDS, decideImpl: stubDecide({ choice: "c0", confidence: 0.92 }), legacyImpl: async () => null });
  assert.equal(a.name, "גריל הפינה");
  const b = await decideVenue({ state, candidates: CANDS, decideImpl: stubDecide({ choice: "unlisted", confidence: 0.95 }),
    legacyImpl: async () => ({ venue: "Corner Grill", listed_id: null, named_by: "jori_accepted", confidence: 0.94, basis: "he said yes" }) });
  assert.equal(b.name, "Corner Grill");
  const c = await decideVenue({ state, candidates: CANDS, decideImpl: stubDecide({ choice: "none", confidence: 0.95 }), legacyImpl: async () => null });
  assert.equal(c, null);
});

// 2026-10-08 13:30Z: six fallback calls died in ~4 s, resolved null, and were
// logged as six Jev disagreements Jev had actually got right. A dead call must
// reject (jev-shadow then logs shadow.error); only a real answer resolves.
test("askSonnet: a dead call rejects; a real 'nothing names it' answer still resolves", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-evidence-"));
  const fake = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return p; };
  await assert.rejects(askSonnet({ chat: [] }, { bin: fake("dead", "echo 'Not logged in'; exit 1") }), /sonnet fallback: exit 1 — Not logged in/);
  await assert.rejects(askSonnet({ chat: [] }, { bin: fake("prose", "echo 'I cannot tell.'") }), /no JSON in the reply/);
  await assert.rejects(askSonnet({ chat: [] }, { bin: path.join(dir, "missing") }), /sonnet fallback: ENOENT/);
  const ans = await askSonnet({ chat: [] }, { bin: fake("none", `echo '{"venue":null,"listed_id":null,"named_by":"none","confidence":0.9,"basis":"nothing says"}'`) });
  assert.equal(ans.named_by, "none");
  assert.equal(acceptLegacy(ans, CANDS), null);
});

test("evidenceVerdict end to end on the 2026-10-08 lunch (stubbed DB, map, model)", async () => {
  const photoBuf = jpegWithExif({ ...fakeAt(-28.01, 15.76), dt: "2026:10:08 14:32:23", offset: "+03:00" });
  const sb = async (q) => {
    if (q.startsWith("jori_messages")) return [
      { role: "user", content: "https://example-project.supabase.co/storage/v1/object/public/test-attachments/8079/photo.jpg", created_at: "2026-10-08T12:00:57Z" },
      { role: "user", content: "Having lunch here today", created_at: "2026-10-08T12:00:58Z" },
      { role: "assistant", content: "That looks like Corner Grill (גריל הפינה), the grill on the corner.", created_at: "2026-10-08T12:01:01Z" },
      { role: "user", content: "Yes! It's great. Food is delicious and portions are gigantic", created_at: "2026-10-08T12:02:16Z" },
    ];
    if (q.startsWith("photos")) return [
      { uuid: "a", taken_at: "2026-10-08T11:47:55Z", ...fakeRow(1.11, 11.2), self_captured: true, labels: ["food", "meal", "plate"], detected_text: [] },
    ];
    return [];
  };
  const near = () => [{ name: "גריל הפינה", primary_type: "restaurant", ...fakeAt(-20.64, -2.21) },
                      { name: "METRO CITY", primary_type: "clothing_store", ...fakeAt(-9.98, -18.4) }];
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => photoBuf });
  let seen = null;
  const decideImpl = async (o) => { seen = o.state; return { value: o.interpret({ venue: { choice: "c0", confidence: 0.94 } }).value }; };
  const r = await evidenceVerdict({ sb, start: START, end: END, tz: TZ, rest: REST, fallback: CENTROID, near, decideImpl, fetchImpl });
  assert.equal(r.settled, true);
  assert.equal(r.venue.name, "גריל הפינה");
  assert.equal(r.summary.photos_sent_as_fixes, 1);
  assert.ok(seen.chat.some((m) => m.sent_a_photo && m.sent_a_photo.startsWith("taken")));
  assert.ok(seen.photos_he_took[0].shows.includes("food"));
  assert.equal(seen.places_nearby[0].name, "גריל הפינה");
});

test("buildState carries the phone's ordered sign lines and its guess as a witness", () => {
  const s = buildState({ start: START, end: END, tz: TZ, rest: REST, transcript: [], candidates: [],
    photos: [{ t: START + 60000, from_rest_m: 8, labels: ["sign"], detected_text: ["b", "a"], ocr_lines: ["PINAT", "HASHLOSHA"],
      device_venue: { name: "Corner Grill", confidence: 0.9, basis: "sign" } }] });
  assert.deepEqual(s.photos_he_took[0].sign_text_lines, ["PINAT", "HASHLOSHA"]);
  assert.equal(s.photos_he_took[0].sign_words_unordered, undefined);
  assert.equal(s.photos_he_took[0].phone_guess.venue, "Corner Grill");
});

// Looking at the pictures (2026-10-08): only a listed place, only at 0.85+.
test("acceptLook settles only on a listed place at high confidence", async () => {
  const { acceptLook } = await import("../lib/stop-evidence.mjs");
  const cands = [{ id: "c0", name: "Corner Grill", from_rest_m: 21 }];
  assert.equal(acceptLook({ listed_id: "c0", confidence: 0.9, basis: "skewers in a display case" }, cands).name, "Corner Grill");
  assert.equal(acceptLook({ listed_id: "c0", confidence: 0.7 }, cands), null);
  assert.equal(acceptLook({ listed_id: "c9", confidence: 0.95 }, cands), null);
  assert.equal(acceptLook({ listed_id: null, confidence: 0.95 }, cands), null);
});

// The audit counts a stop as asked only when a question about it reached chat
// (si-20261027-12). 2026-10-22 had five ask-gate passes and one question; the
// old audit re-checked all five and reported two places, neither ever
// asked. Shapes below are the real gate-log and jori_messages rows, trimmed.
const V = (p) => `${p}-0000-4000-8000-000000000000`; // a visit row id from its short form
const gate = (visit_id, ts, start, end, ask = true) =>
  ({ ts, visit_id, mode: "ask", ask, window: { start, end }, check: "left" });
const card = (created_at, kind, ref, subject = null, role = "assistant") =>
  ({ role, created_at, metadata: { choices: JSON.stringify({ v: 1, id: "x", kind, ref, ...(subject ? { subject } : {}) }) } });

test("audit: only stops a question reached chat about are 'asked'", async () => {
  const { askedStops, stopQuestions } = await import("../bin/stop-evidence");
  const gateRows = [
    gate(V("2b935436"), "2026-10-22T07:45:07.812Z", "2026-10-22T06:23:53.000Z", "2026-10-22T07:20:00.000Z"),
    gate(V("7fcbedeb"), "2026-10-22T07:45:45.440Z", "2026-10-22T06:19:08.000Z", "2026-10-22T07:37:00.000Z"),
    gate(V("629951f2"), "2026-10-22T11:30:09.714Z", "2026-10-22T10:32:03.000Z", "2026-10-22T11:10:00.000Z"),
    gate(V("2ee5e438"), "2026-10-22T15:30:09.225Z", "2026-10-22T15:01:23.000Z", "2026-10-22T15:20:00.000Z"),
    gate(V("3e3a423f"), "2026-10-22T19:00:27.563Z", "2026-10-22T15:47:42.000Z", "2026-10-22T18:40:00.000Z"),
    // a later pass on the same stop moves its window; the latest ask:true window wins
    gate(V("7fcbedeb"), "2026-10-22T07:50:00.000Z", "2026-10-22T06:19:08.000Z", "2026-10-22T07:38:00.000Z"),
    gate(V("7fcbedeb"), "2026-10-22T07:55:00.000Z", "2026-10-22T06:00:00.000Z", "2026-10-22T09:00:00.000Z", false),
  ];
  const messages = [
    card("2026-10-22T08:01:11.566964+00:00", "location_stop", V("7fcbedeb")),
    card("2026-10-22T08:20:00+00:00", "location_stop", V("7fcbedeb")),             // a re-send: the first one counts
    card("2026-10-22T13:39:59.29945+00:00", "decision", "cost:q-allowance"),     // not a stop question
    card("2026-10-22T14:00:00+00:00", "location_stop", V("629951f2"), null, "user"), // not from Jori
    card("2026-10-21T21:30:00+00:00", "location_ask", V("aaaa1111"),                // 00:30 on the 22nd in Jerusalem
      { start: "2026-10-21T19:00:00Z", end: "2026-10-21T20:00:00Z" }),
    card("2026-10-21T20:30:00+00:00", "location_stop", V("bbbb2222")),             // 23:30 on the 21st: another day
    { role: "assistant", created_at: "2026-10-22T09:00:00Z", metadata: { choices: "{not json" } },
    { id: "dsf-row", role: "assistant", created_at: "2026-10-22T10:00:00Z", metadata: { question_id: "dsf:1" } }, // not hum's
  ];
  const { asked, unlinked } = askedStops(gateRows, messages, "2026-10-22", "Asia/Jerusalem");
  assert.deepEqual([...asked.keys()].sort(), [V("7fcbedeb"), V("aaaa1111")]);
  assert.deepEqual(asked.get(V("7fcbedeb")), { start: "2026-10-22T06:19:08.000Z", end: "2026-10-22T07:38:00.000Z",
    asked_at: "2026-10-22T08:01:11.566964+00:00" }, "gate window, first question time as the evidence cut-off");
  assert.deepEqual(asked.get(V("aaaa1111")), { start: "2026-10-21T19:00:00Z", end: "2026-10-21T20:00:00Z",
    asked_at: "2026-10-21T21:30:00+00:00" }, "no gate row: the card's own window");
  assert.equal(asked.has(V("629951f2")), false, "a gate pass that never became a question is not 'asked'");
  assert.deepEqual(unlinked, []);
  assert.equal(stopQuestions(messages, "2026-10-21", "Asia/Jerusalem").asked.has(V("bbbb2222")), true);
  assert.equal(askedStops(gateRows, [], "2026-10-22", "Asia/Jerusalem").asked.size, 0, "gate passes alone ask nothing");
  const noWindow = askedStops([], [card("2026-10-22T08:00:00Z", "location_ask", V("cccc3333"))], "2026-10-22", "Asia/Jerusalem").asked;
  assert.deepEqual(noWindow.get(V("cccc3333")), { asked_at: "2026-10-22T08:00:00Z", start: null, end: null });
});

// hum-ask sends its questions with NO card (2026-10-18 13:48Z, an afternoon visit),
// so the card rule alone silently stopped counting every hum stop question. Since
// 2026-10-27 the row carries finding_key; the ledger says it landed as a question.
test("audit: a cardless hum-ask stop question counts by finding_key; one sent before the stamp is 'unlinked'", async () => {
  const { askedStops, landedQuestions } = await import("../bin/stop-evidence");
  const VISIT = "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
  const hum = (id, created_at, question_id, extra = {}) => ({ id, role: "assistant", created_at,
    metadata: { question_id, question_until: "2026-10-18T21:00:36.233Z", question_state: "answered", ...extra } });
  const ledger = [
    { ev: "asked", id: "q-stamped", at: "2026-10-18T13:48:05.540Z", lane: "location_context", msg_id: "row-stamped" },
    { ev: "asked", id: "q-old", at: "2026-10-18T07:39:02.000Z", lane: "location_context", msg_id: "row-old" },
    { ev: "asked", id: "q-idea", at: "2026-10-18T10:30:43.000Z", lane: "ideas", msg_id: "row-idea" },
    { ev: "asked", id: "q-edge", at: "2026-10-18T11:00:00.000Z", lane: "location_context", msg_id: "row-edge" },
    { ev: "asked", id: "q-lc", at: "2026-10-18T12:31:38.000Z", lane: "location_context", msg_id: "row-lc" },
  ];
  const landed = landedQuestions(ledger);
  assert.deepEqual(landed.get("row-stamped"), { question_id: "q-stamped", lane: "location_context" });
  const messages = [
    hum("row-stamped", "2026-10-18T13:48:05.46595+00:00", "q-stamped", { finding_key: `location_ask:${VISIT}` }),
    hum("row-old", "2026-10-18T07:39:02.1+00:00", "q-old"),                                   // before the stamp: no key
    hum("row-idea", "2026-10-18T10:30:43+00:00", "q-idea", { finding_key: "idea-20261017-x" }), // not about a stop
    hum("row-edge", "2026-10-18T11:00:00+00:00", "q-edge", { finding_key: "location_context:edge:arrived:e1" }), // live arrival, not a stop-passage ask
    // the location-confirm flow's synthetic id names no visit row: reported, never re-run with no window
    hum("row-lc", "2026-10-18T12:31:38+00:00", "q-lc", { finding_key: "location_ask:lc-20261025-1410-32.052-34.757" }),
    // the resolve-first gate answered it and sent an FYI instead: same metadata, never recorded as asked
    hum("row-fyi", "2026-10-18T15:00:00+00:00", "q-fyi", { finding_key: "location_ask:fyi-visit" }),
  ];
  const gateRows = [gate(VISIT, "2026-10-18T13:45:07.980Z", "2026-10-18T11:51:05.000Z", "2026-10-18T13:20:38.000Z")];
  const { asked, unlinked } = askedStops(gateRows, messages, "2026-10-18", "Asia/Jerusalem", landed);
  assert.deepEqual([...asked.keys()], [VISIT]);
  assert.deepEqual(asked.get(VISIT), { start: "2026-10-18T11:51:05.000Z", end: "2026-10-18T13:20:38.000Z",
    asked_at: "2026-10-18T13:48:05.46595+00:00" });
  assert.deepEqual(unlinked, [{ question_id: "q-old", message_id: "row-old", lane: "location_context", asked_at: "2026-10-18T07:39:02.1+00:00", ref: null },
    { question_id: "q-lc", message_id: "row-lc", lane: "location_context", asked_at: "2026-10-18T12:31:38+00:00", ref: "lc-20261025-1410-32.052-34.757" }],
    "reported, not silently zero, and not audited as a stop with no window");
  // Without the ledger nothing hum-ask sent can be told from an FYI, so none of it counts.
  assert.equal(askedStops(gateRows, messages, "2026-10-18", "Asia/Jerusalem").asked.size, 0);
});
