// chat-people.test.mjs — handle geometry, the attributedBody decoder, matching
// people to Contacts, the ledger over fixture chat.db / AddressBook / WhatsApp
// inbox files, staleness, and the wiki ## Texts block.
// Run: node --test tests/chat-people.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-people-"));
process.env.CHAT_PEOPLE_DB = path.join(dir, "cp.db");
process.env.CHAT_PEOPLE_CHAT_DB = path.join(dir, "chat.db");
process.env.CHAT_PEOPLE_ADDRESS_BOOK = path.join(dir, "AddressBook");
process.env.CHAT_PEOPLE_WA_INBOX = path.join(dir, "wa.jsonl");

const { createRequire } = await import("node:module");
const cp = createRequire(import.meta.url)(path.resolve("lib/chat-people.js"));

after(() => {
  cp.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// A typedstream body the way macOS writes it: ... NSString, 5 bytes, length, text.
function body(text, { wide = false } = {}) {
  const t = Buffer.from(text, "utf8");
  const len = t.length < 0x80 && !wide ? Buffer.from([t.length]) : (() => {
    const b = Buffer.alloc(3);
    b[0] = 0x81;
    b.writeUInt16LE(t.length, 1);
    return b;
  })();
  return Buffer.concat([Buffer.from([0x04, 0x0b]), Buffer.from("streamtyped"), Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]), Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), len, t, Buffer.from([0x86, 0x84])]);
}

test("handleKey equates spellings of one number and lowercases emails", () => {
  assert.equal(cp.handleKey("+972 54-123-4567"), cp.handleKey("054 123 4567"));
  assert.equal(cp.handleKey("+1 (408) 555-0101"), cp.handleKey("4085550101"));
  assert.equal(cp.handleKey("Jane.Doe@Example.COM"), "jane.doe@example.com");
  assert.equal(cp.handleKey("12345"), null);
  assert.equal(cp.handleKey(null), null);
});

test("normName ignores case, accents, punctuation and spacing", () => {
  assert.equal(cp.normName("  José  O'Brien-Smith "), cp.normName("jose o brien smith"));
  assert.equal(cp.normName("דנה  לוי"), cp.normName("דנה לוי"));
  assert.notEqual(cp.normName("Guy Cohen"), cp.normName("Guy Peretz"));
});

test("typedstreamText reads short, wide and emoji bodies and refuses truncated ones", () => {
  assert.equal(cp.typedstreamText(body("See you at 5")), "See you at 5");
  const long = "x".repeat(300);
  assert.equal(cp.typedstreamText(body(long, { wide: true })), long);
  assert.equal(cp.typedstreamText(body("שלום 👋")), "שלום 👋");
  const cut = body("hello world").subarray(0, body("hello world").length - 12);
  assert.equal(cp.typedstreamText(cut), "");
  assert.equal(cp.typedstreamText(Buffer.from("no class name here")), "");
  assert.equal(cp.typedstreamText(null), "");
});

test("messageText prefers text, falls back to the body, drops attachment placeholders", () => {
  assert.equal(cp.messageText("plain", body("ignored")), "plain");
  assert.equal(cp.messageText(null, body("from body")), "from body");
  assert.equal(cp.messageText(null, body(String.fromCharCode(0xfffc))), "");
  assert.equal(cp.messageText("  two   spaces\n", null), "two spaces");
});

const CARDS = [
  { id: "a:1", first: "Dana", last: "Levi", org: "", phones: ["+972 54-111-2222"], emails: ["dana@example.com"] },
  { id: "a:2", first: "Sam", last: "Park", org: "", phones: ["(408) 555-0101"], emails: [] },
  { id: "a:3", first: "Sam", last: "Park", org: "", phones: ["(650) 555-0199"], emails: [] },
  { id: "a:4", first: "", last: "", org: "Acme Plumbing", phones: ["(305) 555-0100"], emails: [] },
  { id: "a:5", first: "Lee", last: "Kim", org: "", phones: ["(212) 555-0142"], emails: [] },
  { id: "a:6", first: "Lee", last: "Kim", org: "", phones: ["(212) 555-0142"], emails: [] },
  { id: "a:7", first: "Me", last: "Self", org: "", phones: ["(917) 555-0000"], emails: [] },
];

test("resolveHandles: an email match is strong, a full-name match is medium, org-only cards never match", () => {
  const people = [
    { wiki_id: "user_dana_levi", name: "Dana Levi", emails: ["dana@example.com"] },
    { wiki_id: "user_sam_park", name: "Sam Park", emails: [] },
    { wiki_id: "user_acme", name: "Acme Plumbing", emails: [] },
  ];
  const { handles, conflicts } = cp.resolveHandles(people, CARDS);
  assert.deepEqual(handles.get("user_dana_levi").map((h) => h.via).sort(), ["email", "email"]);
  const sam = handles.get("user_sam_park");
  assert.equal(sam.length, 2, "both Sam Park cards belong to the one person");
  assert.ok(sam.every((h) => h.via === "name"));
  assert.equal(handles.has("user_acme"), false);
  assert.deepEqual(conflicts, []);
});

test("resolveHandles: a number claimed by two people is dropped for both; self is skipped", () => {
  const people = [
    { wiki_id: "user_lee_kim", name: "Lee Kim", emails: [] },
    { wiki_id: "user_lee_kim_2", name: "Lee Kim", emails: [] },
    { wiki_id: "user_me", name: "Me Self", emails: [] },
  ];
  const { handles, conflicts } = cp.resolveHandles(people, CARDS, { selfIds: new Set(["user_me"]) });
  assert.equal(handles.has("user_lee_kim"), false);
  assert.equal(handles.has("user_lee_kim_2"), false);
  assert.equal(conflicts.length, 1);
  assert.equal(handles.has("user_me"), false);
});

// ── Fixture sources ──

// Nanoseconds since 2001, deliberately past 2^53 like a real 2026 row.
const ns = (iso) => BigInt(Math.round((Date.parse(iso) / 1000 - 978307200) * 1e9));

function makeChatDb() {
  const d = new DatabaseSync(process.env.CHAT_PEOPLE_CHAT_DB);
  d.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, style INTEGER, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER, associated_message_type INTEGER, item_type INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  `);
  d.exec(`INSERT INTO handle VALUES (1, '+972541112222'), (2, '+14085550101'), (3, 'stranger@example.com'), (4, '+16505550199')`);
  d.exec(`INSERT INTO chat VALUES (10, 45, ''), (11, 45, ''), (12, 43, 'Family'), (13, 45, '')`); // lang-regex-ok: SQL fixture rows, no regex
  d.exec(`INSERT INTO chat_handle_join VALUES (10, 1), (11, 2), (12, 1), (12, 2), (12, 3), (13, 3), (13, 4)`);
  let id = 0;
  const ins = d.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const add = (chat, handle, out, when, text, { bodyText = null, assoc = 0, item = 0 } = {}) => {
    id++;
    ins.run(id, text, bodyText ? body(bodyText) : null, ns(when), out, handle, assoc, item);
    d.prepare("INSERT INTO chat_message_join VALUES (?, ?)").run(chat, id);
  };
  // Dana (handle 1), direct chat 10: 3 in via attributedBody, 2 out, a tapback and a group event that must not count.
  add(10, 1, 0, "2026-01-05T10:00:00Z", null, { bodyText: "hi from body" });
  add(10, 1, 0, "2026-02-05T10:00:00Z", null, { bodyText: "second" });
  add(10, 1, 0, "2026-03-05T10:00:00Z", "third plain");
  add(10, 0, 1, "2026-03-06T10:00:00Z", "reply one");
  add(10, 0, 1, "2026-03-07T10:00:00Z", null, { bodyText: "reply two" });
  add(10, 1, 0, "2026-03-08T10:00:00Z", null, { bodyText: "Liked something", assoc: 2000 });
  add(10, 1, 0, "2026-03-09T10:00:00Z", "renamed the conversation", { item: 2 });
  // Sam (handle 2), direct chat 11: one message only.
  add(11, 2, 0, "2026-04-01T10:00:00Z", "only one");
  // Group 12: Dana speaks 6 times, Sam 1, the stranger 2; the user once.
  for (let i = 0; i < 6; i++) add(12, 1, 0, `2026-05-0${i + 1}T10:00:00Z`, `group msg ${i}`);
  add(12, 2, 0, "2026-05-02T11:00:00Z", "sam group");
  add(12, 3, 0, "2026-05-02T12:00:00Z", "stranger");
  add(12, 0, 1, "2026-05-02T13:00:00Z", "mine");
  d.close();
}

function makeAddressBook() {
  const root = process.env.CHAT_PEOPLE_ADDRESS_BOOK;
  fs.mkdirSync(path.join(root, "Sources", "SRC"), { recursive: true });
  const d = new DatabaseSync(path.join(root, "Sources", "SRC", "AddressBook-v22.abcddb"));
  d.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
    INSERT INTO ZABCDRECORD VALUES (1, 'Dana', 'Levi', ''), (2, 'Sam', 'Park', ''), (3, '', '', 'Acme Plumbing');
    INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '+972 54-111-2222'), (2, 2, '(408) 555-0101'), (3, 3, '(305) 555-0100');
    INSERT INTO ZABCDEMAILADDRESS VALUES (1, 1, 'dana@example.com');
  `);
  d.close();
}

function makeInbox() {
  const row = (o) => JSON.stringify({ kind: "message", message_id: Math.random().toString(36).slice(2), type: "conversation", ...o });
  const lines = [
    row({ ts: "2026-06-01T10:00:00.000Z", chat_id: "972541112222@s.whatsapp.net", sender: "972541112222", text: "wa direct 1" }), // kernel-guard-ok: synthetic WhatsApp chat id (555-style test number)
    row({ ts: "2026-06-02T10:00:00.000Z", chat_id: "972541112222@s.whatsapp.net", sender: "972541112222", text: "wa direct 2", type: "extendedTextMessage" }), // kernel-guard-ok: synthetic WhatsApp chat id (555-style test number)
    row({ ts: "2026-06-03T10:00:00.000Z", chat_id: "972541112222@s.whatsapp.net", sender: "972541112222", text: "[reactionMessage]", type: "reactionMessage" }), // kernel-guard-ok: synthetic WhatsApp chat id (555-style test number)
    row({ ts: "2026-06-04T10:00:00.000Z", chat_id: "120363@g.us", is_group: true, sender: "972541112222", text: "wa group" }),
    row({ ts: "2026-06-05T10:00:00.000Z", chat_id: "120363@newsletter", sender: "972541112222", text: "channel post" }),
    JSON.stringify({ ts: "2026-06-06T10:00:00.000Z", kind: "sent", chat_id: "972541112222@s.whatsapp.net", text: "jori test" }), // kernel-guard-ok: synthetic WhatsApp chat id (555-style test number)
    "not json",
  ];
  fs.writeFileSync(process.env.CHAT_PEOPLE_WA_INBOX, lines.join("\n"));
}

const PEOPLE = [
  { wiki_id: "user_dana_levi", name: "Dana Levi", emails: ["dana@example.com"] },
  { wiki_id: "user_sam_park", name: "Sam Park", emails: [], locked: false },
];

test("sync counts real messages only, in both directions, with overflow-sized dates", () => {
  makeChatDb();
  makeAddressBook();
  makeInbox();
  const r = cp.sync({ people: PEOPLE, selfIds: new Set() });
  assert.equal(r.with_handles, 2);
  const rows = cp.db().prepare("SELECT * FROM stats WHERE wiki_id = 'user_dana_levi' ORDER BY channel, kind").all();
  const imDirect = rows.find((s) => s.channel === "imessage" && s.kind === "direct");
  assert.equal(imDirect.n_in, 3);
  assert.equal(imDirect.n_out, 2, "tapbacks and group events are not messages");
  assert.equal(new Date(imDirect.first_at).toISOString().slice(0, 10), "2026-01-05");
  assert.equal(new Date(imDirect.last_at).toISOString().slice(0, 10), "2026-03-07");
  const imGroup = rows.find((s) => s.channel === "imessage" && s.kind === "group");
  assert.equal(imGroup.n_in, 6, "only the person's own group messages");
  assert.equal(imGroup.chat_name, "Family");
  const wa = rows.filter((s) => s.channel === "whatsapp");
  assert.equal(wa.find((s) => s.kind === "direct").n_in, 2, "reactions, channels and Jori's own sends are not counted");
  assert.equal(wa.find((s) => s.kind === "group").n_in, 1);
  assert.ok(cp.getMeta("whatsapp_since"));
});

test("candidates apply the thresholds, order newest first and honour locked pages", () => {
  const all = cp.candidates();
  assert.deepEqual(all.map((c) => c.wiki_id), ["user_dana_levi"], "Sam has one text and one group message: below both thresholds");
  assert.equal(all[0].direct_messages, 7);
  assert.equal(all[0].stale, true);
  cp.db().prepare("UPDATE people SET locked = 1 WHERE wiki_id = 'user_dana_levi'").run();
  assert.deepEqual(cp.candidates(), []);
  cp.db().prepare("UPDATE people SET locked = 0 WHERE wiki_id = 'user_dana_levi'").run();
});

test("a summarised active texter is not due again until the cooldown and enough new messages", () => {
  cp.markSummarized("user_dana_levi");
  assert.equal(cp.candidates({ staleOnly: true }).length, 0);
  const later = Date.now() + (cp.RESUMMARY_DAYS + 1) * 864e5;
  assert.equal(cp.candidates({ staleOnly: true, now: later }).length, 0, "no new messages yet");
  cp.db().prepare("UPDATE links SET summarized_n = 0 WHERE wiki_id = 'user_dana_levi'").run();
  assert.equal(cp.candidates({ staleOnly: true, now: later }).length, 1, "cooldown over and 10+ new messages");
});

test("a rejected handle drops out of the ledger at the next sync", () => {
  cp.rejectHandle("user_dana_levi", "dana@example.com");
  cp.rejectHandle("user_dana_levi", cp.handleKey("+972541112222"));
  cp.sync({ people: PEOPLE, selfIds: new Set() });
  assert.equal(cp.db().prepare("SELECT COUNT(*) n FROM stats WHERE wiki_id = 'user_dana_levi'").get().n, 0);
  cp.db().prepare("DELETE FROM rejected").run();
  cp.sync({ people: PEOPLE, selfIds: new Set() });
  assert.ok(cp.db().prepare("SELECT COUNT(*) n FROM stats WHERE wiki_id = 'user_dana_levi'").get().n > 0);
});

test("personDigest reads a bounded sample live: decoded bodies, directions, years; no stored text", () => {
  const dg = cp.personDigest("user_dana_levi", { sample: 60 });
  assert.equal(dg.direct.imessage.messages, 5);
  assert.equal(dg.direct.imessage.from_user, 2);
  assert.equal(dg.direct.whatsapp.messages, 2);
  assert.deepEqual(dg.direct_by_year, { 2026: 7 });
  assert.equal(dg.groups.length, 2);
  const texts = dg.sample.map((m) => m.text);
  assert.ok(texts.includes("hi from body"), "attributedBody is decoded");
  assert.ok(texts.includes("reply two"));
  assert.equal(texts.includes("Liked something"), false, "tapbacks are not messages");
  assert.ok(dg.sample.some((m) => m.from === "user") && dg.sample.some((m) => m.from === "them"));
  assert.match(dg.coverage.whatsapp, /^since 2026-06-01 /);
  // The ledger holds no message text.
  const dump = JSON.stringify([...cp.db().prepare("SELECT * FROM stats").all(), ...cp.db().prepare("SELECT * FROM handles").all()]);
  assert.equal(dump.includes("hi from body"), false);
});

test("sampleMessages keeps the newest messages and spreads the rest, truncating long ones", () => {
  const msgs = Array.from({ length: 500 }, (_, i) => ({ at: i, channel: "imessage", from: "them", text: i === 0 ? "y".repeat(500) : `m${i}` }));
  const s = cp.sampleMessages(msgs, { limit: 60, recent: 20, chars: 100 });
  assert.equal(s.length, 60);
  assert.deepEqual(s.slice(-20).map((m) => m.text), msgs.slice(-20).map((m) => m.text));
  assert.equal(s[0].text.length, 101);
  assert.ok(s[0].text.endsWith("…"));
  assert.equal(cp.sampleMessages(msgs.slice(0, 5), { limit: 60 }).length, 5);
});

test("renderSection appends a ## Texts block once and replaces it in place afterwards", () => {
  const raw = "---\nname: Dana Levi\n---\n# Dana Levi\n\nA friend.\n\n## Email\n<!-- email-people:start -->\nx\n<!-- email-people:end -->\n";
  const facts = "_From iMessage and WhatsApp · iMessage 5 texts · updated 2026-10-27_";
  const once = cp.renderSection(raw, { facts, summary: "They plan dinners.\n" });
  assert.match(once, /## Texts\n<!-- chat-people:start -->\n_From iMessage/); // lang-regex-ok: checks the machine-written block markers, not words
  assert.ok(once.includes("<!-- email-people:end -->"), "the email block is untouched");
  const twice = cp.renderSection(once, { facts, summary: "They plan dinners and trips." });
  assert.equal(twice.split("chat-people:start").length, 2, "one block only");
  assert.ok(twice.includes("dinners and trips"));
  assert.equal(twice.includes("They plan dinners.\n"), false);
  assert.equal(cp.renderSection(twice, { facts, summary: "They plan dinners and trips." }), twice, "idempotent");
});

test("a summary containing $& or $1 is written verbatim", () => {
  const out = cp.renderSection("# P\n\n<!-- chat-people:start -->\nold\n<!-- chat-people:end -->\n", { facts: "_f_", summary: "Costs $& and $1 stay literal." });
  assert.ok(out.includes("Costs $& and $1 stay literal."));
});

test("factsLine states what each channel covers", () => {
  const stats = cp.db().prepare("SELECT * FROM stats WHERE wiki_id = 'user_dana_levi'").all();
  const line = cp.factsLine(stats, { whatsappSince: Date.parse("2026-05-25T00:00:00Z"), today: Date.parse("2026-10-27T00:00:00Z") });
  assert.match(line, /iMessage 5 texts \(2 from [^)]+\), first 2026-01-05, last 2026-03-07/);
  assert.match(line, /WhatsApp 2 texts received since 2026-05-25/);
  assert.match(line, /in 2 group chats/);
  assert.match(line, /updated 2026-10-27/);
});

test("sync leaves the ledger untouched when Contacts cannot be read", () => {
  const before = cp.db().prepare("SELECT COUNT(*) n FROM stats").get().n;
  assert.ok(before > 0);
  assert.throws(() => cp.sync({ people: PEOPLE, selfIds: new Set(), addressBook: path.join(dir, "nowhere") }), /AddressBook unreadable/);
  assert.equal(cp.db().prepare("SELECT COUNT(*) n FROM stats").get().n, before);
});
