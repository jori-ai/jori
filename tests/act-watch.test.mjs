// act-watch.test.mjs — the act watch's Ticketmaster row, window, merge, email
// and hook rules, the hook-module loader and the config (bin/act-watch,
// lib/act-watch.mjs). Synthetic acts and venues.
//
// Run: node --test tests/act-watch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmRow, itemId, inWindow, mergeRows, fmtTime, groupRuns, renderEmail, hookText, cityDate, ticketsLine, loadKinds } from "../lib/act-watch.mjs";
import { actConfig } from "../bin/act-watch";

const ACT = { act: "touring-troupe", label: "Touring Troupe" };
const tmEv = (o = {}) => ({ id: "Z1", name: "Touring Troupe", url: "https://aff.example/c/1?u=https%3A%2F%2Ftickets.example%2Fevent%2FZ1",
  dates: { start: { localDate: "2027-01-03", localTime: "14:00:00" }, status: { code: "onsale" } },
  _embedded: { venues: [{ name: "Riverside Arena", city: { name: "Harbor City" }, state: { stateCode: "ST" } }] }, priceRanges: [{ min: 31.5 }], ...o });

test("TM row unwraps the affiliate link; merge keeps one item per act+venue+date", () => {
  const r = tmRow(tmEv(), ACT);
  assert.equal(r.url, "https://tickets.example/event/Z1");
  assert.equal(itemId(r), "touring-troupe|riverside-arena|2027-01-03");
  const twoShows = mergeRows([r, { ...tmRow(tmEv({ id: "Z2" }), ACT), time: "19:00:00" }]);
  assert.equal(twoShows.length, 1, "matinee + evening = one item");
  assert.equal(twoShows[0].price_min, 31.5);
  assert.equal(ticketsLine(twoShows[0]), "Tickets: Ticketmaster · from $32");
});

test("region + horizon window", () => {
  const rows = [{ date: "2027-05-28", state: "ST", venue: "A" }, { date: "2027-07-09", state: "ST", venue: "B" }, { date: "2027-07-09", state: "OT", venue: "C" }];
  assert.deepEqual(inWindow(rows, { states: ["ST"], today: "2026-10-16", horizonDays: 400 }).map((r) => r.venue), ["A", "B"]);
  assert.deepEqual(inWindow(rows, { states: ["ST"], today: "2026-10-16", horizonDays: 200 }), [], "past the horizon");
  assert.deepEqual(inWindow(rows, { states: ["ST"], today: "2027-06-01", horizonDays: 400 }).map((r) => r.venue), ["B"], "past dates dropped");
  assert.equal(inWindow(rows, { today: "2026-10-16", horizonDays: 400 }).length, 3, "no states = any region");
});

test("times read like a person wrote them", () => {
  assert.equal(fmtTime("14:00:00"), "2:00 PM");
  assert.equal(fmtTime("00:30"), "12:30 AM");
  assert.equal(fmtTime("12:00:00"), "12:00 PM");
  assert.equal(fmtTime("7:30pm local"), "7:30pm local", "site strings pass through");
  assert.equal(fmtTime(null), null);
});

test("email: a banner first, one block per act+venue; hook names the lead", () => {
  const a = tmRow(tmEv(), ACT);
  const b = { act: "league", act_label: "The League", who: "Reds vs Blues", teams: ["Reds", "Blues"], venue: "Park Field", city: "Harbor City", state: "ST", date: "2027-02-01", time: null, tickets: "Tickets: lottery only", url: "https://league.example/s" };
  const groups = groupRuns(mergeRows([a, b]));
  const banner = { id: "league-lottery|2027", title: "League lottery is open.", text: "Tickets are sold only through it.", link_text: "Join", url: "https://league.example/l", hook: "League lottery is open" };
  const html = renderEmail({ groups, banner, escapeHtml: (s) => String(s ?? "") });
  assert.ok(html.indexOf("League lottery is open.") < html.indexOf("Touring Troupe"));
  assert.ok(html.includes("Reds vs Blues") && html.includes("Tickets: lottery only"));
  assert.equal(hookText(groups, banner), "League lottery is open, plus Riverside Arena dates, details in email");
  assert.equal(hookText(groups, null), "Touring Troupe at Riverside Arena and 1 more, details in email");
  assert.equal(cityDate("Harbor City, ST", "2027-01-03"), "harborcity|2027-01-03");
});

test("hook modules: kinds load from a directory; a broken one is skipped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-ext-"));
  fs.writeFileSync(path.join(dir, "a.mjs"), "export const kinds = { pageA: async () => ({ rows: [] }) };");
  fs.writeFileSync(path.join(dir, "b.mjs"), "throw new Error('broken');");
  const logs = [];
  const kinds = await loadKinds({ dir, log: (m) => logs.push(m) });
  assert.deepEqual(Object.keys(kinds), ["pageA"]);
  assert.equal(logs.length, 1);
  assert.deepEqual(await loadKinds({ dir: path.join(dir, "missing") }), {});
});

test("config: local keys over the private acts_file; nothing configured = no sources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-cfg-"));
  const f = path.join(dir, "acts.json");
  fs.writeFileSync(f, JSON.stringify({ tm: { attractions: [ACT] }, metro: "home", subject: "Acts" }));
  const c = actConfig({ acts_file: f, subject: "Shows" });
  assert.equal(c.metro, "home");
  assert.equal(c.subject, "Shows");
  assert.equal(c.tm.attractions.length, 1);
  const off = actConfig({ acts_file: null });
  assert.equal(off.tm, null);
  assert.deepEqual(off.sources, []);
});
