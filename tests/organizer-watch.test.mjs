// organizer-watch.test.mjs — organizer event → watcher row, the area filter,
// the ping text, and the watch config (bin/organizer-watch).
// Run: node --test tests/organizer-watch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toRow, message, inArea, watches } from "../bin/organizer-watch";

const W = { label: "Talks Downtown", title_prefix: "Talk Series - ", region: "ST", localities: ["harbor city", "east borough"], emoji: "🎤" };

const ev = (o = {}) => ({
  id: 123, name: { text: "Talk Series - The Science of Sleep" },
  start: { local: "2026-10-20T19:00:00", formatted_time: "7:00 PM" },
  venue: { name: "The Cellar Room", address: { city: "Harbor City", region: "ST", localized_address_display: "1 Example Way, Harbor City, ST 00000" } },
  price_range: "$41 - $55", ticket_availability: { has_available_tickets: true, is_sold_out: true },
  url: "https://tickets.example.com/e/123", ...o,
});

test("row: prefix stripped, area detected, availability from has_available_tickets", () => {
  const r = toRow(ev(), W);
  assert.equal(r.title, "The Science of Sleep");
  assert.equal(r.date, "2026-10-20");
  assert.equal(r.in_area, true);
  assert.equal(r.sold_out, false, "is_sold_out is ignored — it reports false positives");
  assert.equal(toRow(ev({ ticket_availability: { has_available_tickets: false } }), W).sold_out, true);
  assert.equal(toRow(ev({ venue: { name: "X", address: { city: "Far Town", region: "OT" } } }), W).in_area, false);
  assert.equal(toRow(ev({ venue: { name: "X", address: { city: "East Borough", region: "ST" } } }), W).in_area, true);
});

test("area: no region/localities configured means everywhere", () => {
  assert.equal(inArea({ city: "Anywhere", region: "ZZ" }, {}), true);
  assert.equal(inArea({ city: "Harbor City", region: "OT" }, { region: "ST" }), false);
});

test("message: soonest five, URL on its own line", () => {
  const rows = Array.from({ length: 6 }, (_, i) => toRow(ev({ id: i, start: { local: `2026-10-2${i}T19:00:00`, formatted_time: "7:00 PM" } }), W));
  const m = message(rows, W);
  assert.match(m, /^🎤 Talks Downtown: 6 new shows announced/);
  assert.equal(m.split("\n").filter((l) => l.startsWith("https://")).length, 5);
  assert.match(message(rows.slice(0, 1), { label: "X", noun: "talk" }), /^X: 1 new talk announced/);  // lang-regex-ok: checks the code-composed ping text, not the user's words
});

test("watches: config over a private watches_file; none configured = off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-"));
  const f = path.join(dir, "w.json");
  fs.writeFileSync(f, JSON.stringify({ watches: { a: { url: "https://x.example/o/1" }, b: { url: "https://x.example/o/2" } } }));
  const all = watches({ watches_file: f, watches: { b: { url: "https://x.example/o/3" } } });
  assert.deepEqual(Object.keys(all).sort(), ["a", "b"]);
  assert.equal(all.b.url, "https://x.example/o/3");
  assert.deepEqual(watches({ watches: {}, watches_file: path.join(dir, "missing.json") }), {});
});
