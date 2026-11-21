// work-records.test.mjs — one-off work records (lib/work-records.mjs).
// Run: node --test tests/work-records.test.mjs
// Isolated fixture wiki DB; Google Docs are read through an injected stub.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-records-"));
fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
process.env.MEMORY_INDEX_DIR = path.join(dir, "memory");
process.env.MEMORY_INDEX_DB = path.join(dir, "memory-index.db");
process.env.MEMORY_DB_AUTHORITATIVE = "1";
process.env.JORI_TZ = "Etc/GMT+5";

const W = await import(path.resolve("lib/work-records.mjs"));
const { createRequire } = await import("node:module");
const ws = createRequire(import.meta.url)(path.resolve("lib/wiki-store.js"));

test("ids, slugs and doc ids", () => {
  assert.equal(W.pageIdFor("2026-11-17", "Kitchen 2A/2B: contractor options!"), "work_2026-11-17_kitchen_2a_2b_contractor_options");
  assert.equal(W.docIdFromUrl("https://docs.google.com/document/d/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/edit"), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(W.docIdFromUrl("https://example.com/x"), null);
  assert.throws(() => W.pageIdFor("Nov 17", "x"));
});

test("htmlToText keeps the words and the links", () => {
  const t = W.htmlToText('<p>Pick <b>Rabkin</b> &amp; MJ</p><ul><li>one</li></ul><a href="https://x.y">doc</a>');
  assert.match(t, /Pick Rabkin & MJ/);
  assert.match(t, /• one/);
  assert.match(t, /doc \(https:\/\/x\.y\)/);
});

test("a record holds the substance, is found by search, and takes dated updates", () => {
  assert.throws(() => W.recordWork({ title: "x" }), /bottom line/);
  const r = W.recordWork({
    title: "Contractor options compared", date: "2026-11-17", by: "Chief of Staff",
    project: "project_kitchen", bottom_line: "Alpha at $1,200 or Beta at $1,500.",
    summary: "Alpha or Beta; Gamma only once they answer about the letter.",
    links: ["https://docs.google.com/document/d/abcdefghijklmnopqrstuvwxyz/edit"],
    deliverable: "Full table of eight offers. Epsilon is the wildcard.", as_of: "end of Mon Nov 16",
  });
  assert.equal(r.created, true);
  const p = ws.getPage(r.id);
  assert.equal(p.type, "work");
  assert.match(p.body_md, /Epsilon is the wildcard/);
  assert.match(p.body_md, /\[\[project_kitchen\]\]/);
  assert.match(p.body_md, /As of:\*\* end of Mon Nov 16/);
  assert.equal(W.findWork("contractor wildcard")[0].id, r.id);
  // A second add of the same work does not overwrite it.
  assert.equal(W.recordWork({ title: "Contractor options compared", date: "2026-11-17", bottom_line: "y" }).skipped, "exists");
  W.addUpdate(r.id, "Epsilon's quote came in at $1,750 after this was written.", { date: "2026-11-18", by: "chat" });
  W.addUpdate(r.id, "The user picked Delta.", { date: "2026-11-19" });
  const after = ws.getPage(r.id).body_md;
  assert.doesNotMatch(after, /None yet/);
  assert.ok(after.includes("**2026-11-18** (chat): Epsilon's quote"));
  assert.match(after, /\*\*2026-11-19\*\*: The user picked Delta/);
  // Replacing keeps the updates.
  W.recordWork({ title: "Contractor options compared", date: "2026-11-17", project: "project_kitchen", bottom_line: "Rewritten." }, { replace: true });
  assert.match(ws.getPage(r.id).body_md, /The user picked Delta/);
  const list = W.listWork({ project: "project_kitchen" });
  assert.equal(list.length, 1);
  assert.equal(list[0].date, "2026-11-17");
});

test("sync-project-work records each finished result once, with the doc's text", () => {
  const tasks = path.join(dir, "tasks.json");
  fs.writeFileSync(tasks, JSON.stringify({ tasks: {
    "pt-1": { id: "pt-1", project: "project_bikes", title: "Compare two bikes (Bikes)", jori: { state: "review", result: { kind: "doc", link: "https://docs.google.com/document/d/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/edit", summary: "One is lighter. The other is stronger.", failed: false, at: "2026-11-14T03:00:00Z" } } },
    "pt-2": { id: "pt-2", project: "project_x", title: "Check a battery", jori: { state: "review", result: { kind: "note", link: null, summary: "Battery reads 100%.", failed: false, at: "2026-11-13T13:10:00Z" } } },
    "pt-3": { id: "pt-3", project: "project_x", title: "Failed one", jori: { state: "failed", result: { kind: null, summary: "ran out", failed: true } } },
    "pt-4": { id: "pt-4", project: "project_x", title: "Not started", jori: { state: "queued" } },
  } }));
  const readDoc = () => ({ text: "Side by side: A 291 lb, B 403 lb.", error: null });
  const r1 = W.syncProjectWork({ tasksPath: tasks, readDoc });
  assert.deepEqual(r1.recorded.map((x) => x.task).sort(), ["pt-1", "pt-2"]);
  const scoot = r1.recorded.find((x) => x.task === "pt-1").id;
  assert.equal(scoot, "work_2026-11-13_compare_two_bikes"); // 03:00Z is the 13th at UTC-5
  assert.match(ws.getPage(scoot).body_md, /A 291 lb/);
  const r2 = W.syncProjectWork({ tasksPath: tasks, readDoc });
  assert.equal(r2.recorded.length, 0);
  assert.equal(r2.skipped.length, 2);
});

test("an unreadable doc is said so, not hidden", () => {
  const tasks = path.join(dir, "tasks2.json");
  fs.writeFileSync(tasks, JSON.stringify({ tasks: { "pt-9": { id: "pt-9", project: "project_y", title: "Draft a plan", jori: { state: "review", result: { kind: "doc", link: "https://docs.google.com/document/d/zzzzzzzzzzzzzzzzzzzzzzzz/edit", summary: "A plan.", failed: false, at: "2026-11-15T15:00:00Z" } } } } }));
  const r = W.syncProjectWork({ tasksPath: tasks, readDoc: () => ({ text: null, error: "403" }) });
  assert.match(ws.getPage(r.recorded[0].id).body_md, /could not be read when this was recorded \(403\)/);
});

test("how to change it: set on add, kept on replace, set and replaced later", () => {
  const r = W.recordWork({ title: "Probe sheet", bottom_line: "Four probes.", by: "Claude Code (laptop)", date: "2026-11-20",
    how_to_change: "Repo ~/Dev/x, path sheets/; run sheets/build.sh. Lands as a draft PR." });
  let p = ws.getPage(r.id);
  assert.match(p.raw_md, /## Bottom line\n\nFour probes\.\n\n## How to change it\n\nRepo ~\/Dev\/x/);
  assert.equal(W.howToChangeOf(p.body_md), "Repo ~/Dev/x, path sheets/; run sheets/build.sh. Lands as a draft PR.");
  W.addUpdate(r.id, "sent to the engineer", { date: "2026-11-21" });
  W.recordWork({ title: "Probe sheet", bottom_line: "Four probes, 18 in.", by: "Claude Code (laptop)", date: "2026-11-20" }, { replace: true });
  p = ws.getPage(r.id);
  assert.match(p.body_md, /## How to change it\n\nRepo ~\/Dev\/x/, "a replace without the field keeps the section");
  assert.match(p.body_md, /sent to the engineer/, "and the updates");
  W.setHowToChange(r.id, "Repo ~/Dev/y; run make.");
  p = ws.getPage(r.id);
  assert.equal(W.howToChangeOf(p.body_md), "Repo ~/Dev/y; run make.");
  assert.equal((p.raw_md.match(/## How to change it/g) || []).length, 1);
  assert.match(p.raw_md, /## Deliverable \(as delivered\)/);
  const old = W.recordWork({ title: "Old one", bottom_line: "No section yet.", by: "chat", date: "2026-11-01" });
  W.setHowToChange(old.id, "Drive doc; edit it.");
  p = ws.getPage(old.id);
  assert.match(p.raw_md, /No section yet\.\n\n## How to change it\n\nDrive doc; edit it\.\n\n## Deliverable/);
  assert.throws(() => W.setHowToChange("work_nope", "x"));
});
