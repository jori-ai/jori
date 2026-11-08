// day-messages: the daily summary's message source over the
// synthetic chat.db from imessage-db.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fixture } from "./imessage-db.test.mjs";

const require = createRequire(import.meta.url);
const dm = require("../lib/day-messages.js");

test("day-messages: iMessage rows for the window, structural caps", () => {
  const db = fixture();
  const w = { startMs: Date.parse("2026-10-26T00:00:00Z"), endMs: Date.parse("2026-10-27T00:00:00Z") };
  const rows = dm.imessageRows(w, { chatDb: db });
  assert.deepEqual(rows.map((r) => r.text), ["Should I bring ice cream?", "Might as well", "Dinner at 8 tonight", "[image]"].filter((t) => dm.hasWords(t)));
  const many = Array.from({ length: 30 }, (_, i) => ({ channel: "whatsapp", ms: i, chat_id: "g", chat: "G", is_group: true, from_me: false, who: "x", text: `m${i}` }));
  const { kept, dropped } = dm.bound(many);
  assert.equal(kept.length, dm.GROUP_PASSIVE_MAX);
  assert.equal(dropped, 30 - dm.GROUP_PASSIVE_MAX);
  assert.equal(kept.at(-1).text, "m29");
  db.close();
});

test("day-messages: lookbackLinks keeps linked messages from the hours before the window, with titles", () => {
  const w = { startMs: Date.parse("2026-11-07T05:00:00Z"), endMs: Date.parse("2026-11-08T05:00:00Z") };
  const at = (iso) => Date.parse(iso);
  const rows = [
    { channel: "imessage", ms: at("2026-11-07T01:22:23Z"), chat_id: "c1", chat: "Sam Example", is_group: false, from_me: false, who: "Sam Example",
      text: "[file: AA1E.pluginPayloadAttachment] [file: CB73.pluginPayloadAttachment] https://dumplings.example/" },
    { channel: "imessage", ms: at("2026-11-07T00:10:00Z"), chat_id: "c1", chat: "Sam Example", is_group: false, from_me: false, who: "Sam Example", text: "no link in this one" },
    { channel: "imessage", ms: at("2026-11-05T01:00:00Z"), chat_id: "c1", chat: "Sam Example", is_group: false, from_me: false, who: "Sam Example", text: "https://too-old.example/" },
    { channel: "imessage", ms: at("2026-11-07T12:00:00Z"), chat_id: "c1", chat: "Sam Example", is_group: false, from_me: false, who: "Sam Example", text: "https://inside-the-day.example/" },
  ];
  const inRange = (r, win) => r.filter((x) => x.ms >= win.startMs && x.ms < win.endMs);
  const asked = [];
  const { facts, errors } = dm.lookbackLinks(w, { imessage: (win) => inRange(rows, win), whatsapp: () => [], slack: () => { throw new Error("slack log missing"); } },
    { titleOf: (u) => { asked.push(u); return "Example Dumplings | Dimsum | 1 Main Street"; } });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, "lookback_link");
  assert.equal(facts[0].text, "https://dumplings.example/");
  assert.deepEqual(facts[0].links, [{ url: "https://dumplings.example/", title: "Example Dumplings | Dimsum | 1 Main Street" }]);
  assert.deepEqual(asked, ["https://dumplings.example/"]);
  assert.match(errors.slack, /slack log missing/);
});

test("day-messages: lookbackLinks keeps the newest max messages, oldest first, and a dead title is empty", () => {
  const w = { startMs: Date.parse("2026-11-07T05:00:00Z"), endMs: Date.parse("2026-11-08T05:00:00Z") };
  const rows = Array.from({ length: 5 }, (_, i) => ({ channel: "whatsapp", ms: Date.parse("2026-11-06T20:00:00Z") + i * 60000, chat_id: "g", chat: "G", is_group: true,
    from_me: false, who: "x", text: `look https://example.test/${i}` }));
  const { facts } = dm.lookbackLinks(w, { imessage: () => [], whatsapp: () => rows, slack: () => [] }, { max: 2, titleOf: () => "" });
  assert.deepEqual(facts.map((f) => f.links[0].url), ["https://example.test/3", "https://example.test/4"]);
  assert.equal(facts[0].links[0].title, "");
});

test("day-messages: lookbackLinks drops Slack channels, caps one chat, and reads a Slack <url|label> as the url", () => {
  const w = { startMs: Date.parse("2026-11-07T05:00:00Z"), endMs: Date.parse("2026-11-08T05:00:00Z") };
  const t0 = Date.parse("2026-11-06T20:00:00Z");
  const slack = [
    { channel: "slack", ms: t0, chat_id: "C1", chat: "#alerts", is_group: true, from_me: false, who: "Sentry", text: "<https://sentry.example/a|alert>" },
    { channel: "slack", ms: t0 + 1000, chat_id: "D1", chat: "Pat Example", is_group: false, from_me: false, who: "Pat Example", text: "see <https://demo.example/x|the demo>" },
  ];
  const wa = Array.from({ length: 6 }, (_, i) => ({ channel: "whatsapp", ms: t0 + 2000 + i, chat_id: "g", chat: "G", is_group: true, from_me: false, who: "x", text: `https://spam.example/${i}` }));
  const { facts } = dm.lookbackLinks(w, { imessage: () => [], whatsapp: () => wa, slack: () => slack }, { titleOf: () => "" });
  assert.equal(facts.some((f) => f.chat === "#alerts"), false);
  assert.deepEqual(facts.find((f) => f.chat === "Pat Example").links.map((l) => l.url), ["https://demo.example/x"]);
  assert.equal(facts.filter((f) => f.chat === "G").length, dm.LOOKBACK_PER_CHAT);
});
