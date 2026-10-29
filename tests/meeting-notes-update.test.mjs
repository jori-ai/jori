// meeting-notes-update.test.mjs — Zoom's record of a recurring meeting's call, as
// text (lib/zoom-content.mjs), folded into the meeting's notes
// (lib/meeting-notes-update.mjs). A model reads the call and answers with a
// structured edit; code checks it and applies it by heading, so history is
// never rewritten. Synthetic notes and names.
//
// Run: node --test tests/meeting-notes-update.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const zc = await import(path.join(ROOT, "lib/zoom-content.mjs"));
const nu = await import(path.join(ROOT, "lib/meeting-notes-update.mjs"));

test("a VTT transcript keeps only the spoken lines", () => {
  const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nAnn Owner: How did the Acme call go?\n\n2\n00:00:05.000 --> 00:00:09.000\nsamlee: They want one vendor.\n";
  assert.equal(zc.vttToText(vtt), "Ann Owner: How did the Acme call go?\nsamlee: They want one vendor.");
});

test("AI Companion's summary is joined as Zoom wrote it", () => {
  const body = { summary_title: "Weekly sync", summary_overview: "Fundraise and product.",
    summary_details: [{ label: "Fundraise", summary: "Two investor meetings booked." }, null],
    next_steps: ["Sam to send the deck"] };
  assert.equal(zc.summaryToText(body),
    "Weekly sync\n\nFundraise and product.\n\nFundraise: Two investor meetings booked.\n\nNext steps:\n- Sam to send the deck");
  assert.equal(zc.summaryToText(null), "");
});

test("callContent: transcript first, else the summary, and a 3001 is 'none'", async () => {
  const client = { token: async () => ({ token: "t", base: "https://api.zoom.us" }) };
  const seen = [];
  const res = (status, body, text) => ({ ok: status < 300, status, json: async () => body, text: async () => text });
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith("/recordings")) return res(404, { code: 3301 });
    if (url.endsWith("/meeting_summary")) return url.includes("A") ? res(404, { code: 3001 }) : res(200, { summary_overview: "Product." });
    throw new Error(url);
  };
  assert.deepEqual(await zc.callContent(client, ["A", "B"], { fetchImpl }), { kind: "summary", text: "Product.", uuid: "B" });
  assert.equal(await zc.callContent(client, ["A"], { fetchImpl }), null);
  // A UUID with "//" is double-encoded in the path.
  await zc.callContent(client, ["a//b"], { fetchImpl });
  assert.ok(seen.some((u) => u.includes("/meetings/a%252F%252Fb/recordings")), seen.join("\n"));
});

const NOTES = `# Sam Meeting Notes

## Running Context (Full History)

A living summary.

### People

**Robin** — Sales ops. [Jul 14] Ramp-up done.

### Deals & Business Topics

**Acme** — [Sep 22] Single vendor for device management.

## To Discuss (Upcoming)
- [ ] Acme deal — follow up on progress (discussed Sep 22).
- [ ] Robin — follow up on title/equity decision (discussed Jul 8)

## Discussed

### 2026-10-20
- Team, fundraise and product discussed.

### 2026-10-09
- Customer ordering website.
`;

const EDIT = {
  discussed: ["Acme wants a pilot in November.", "Fundraise: two investor meetings booked."],
  closed_items: ["Acme deal — follow up on progress (discussed Sep 22)."],
  follow_ups: ["Acme pilot — check the November start date."],
  recap: ["Acme: pilot in November", "Fundraise: two investor meetings"],
  labels: { "Acme pilot — check the November start date.": "Acme pilot start date", "Not an item": "x",
    "Robin — follow up on title/equity decision (discussed Jul 8)": "Robin title/equity\nsecond line" },
  context: [
    { section: "Deals & Business Topics", name: "Acme", text: "Pilot agreed for November." },
    { section: "People", name: "Lee", text: "Leads inbound recruiting." },
    { section: "Fundraise", name: "Seed round", text: "Two investor meetings booked." },
  ],
};

test("the model's edit is checked against the file before anything is written", () => {
  assert.equal(nu.validateEdit(EDIT, NOTES), null);
  assert.match(nu.validateEdit({ ...EDIT, closed_items: ["Acme deal"] }, NOTES), /not a To Discuss line/);
  assert.match(nu.validateEdit({ ...EDIT, discussed: [] }, NOTES), /discussed is empty/);
  assert.match(nu.validateEdit({ ...EDIT, follow_ups: ["two\nlines"] }, NOTES), /multi-line/);
  assert.match(nu.validateEdit({ ...EDIT, context: [{ section: "People", name: "**X**", text: "y" }] }, NOTES), /markdown/);
  assert.match(nu.validateEdit({ discussed: ["x"] }, NOTES), /closed_items is not an array/);
  assert.match(nu.validateEdit({ ...EDIT, recap: [] }, NOTES), /recap is not 1 to 6/);
  assert.match(nu.validateEdit({ ...EDIT, recap: ["x".repeat(81)] }, NOTES), /long bullet/);
});

test("labels: only short one-line labels for items open before or added by the call; the rest dropped, not fatal", () => {
  assert.deepEqual(nu.cleanLabels(EDIT, NOTES), { "Acme pilot — check the November start date.": "Acme pilot start date" });
  assert.deepEqual(nu.cleanLabels({ ...EDIT, labels: ["x"] }, NOTES), {});
  assert.deepEqual(nu.cleanLabels({ ...EDIT, labels: undefined }, NOTES), {});
});

test("priority: kept to items open after the call or added by it, each once; closed and unknown keys dropped", () => {
  const noam = "Robin — follow up on title/equity decision (discussed Jul 8)", pilot = "Acme pilot — check the November start date.";
  assert.deepEqual(nu.cleanPriority({ ...EDIT, priority: [pilot, "Not an item", EDIT.closed_items[0], noam, pilot, 3] }, NOTES), [pilot, noam]);
  assert.deepEqual(nu.cleanPriority({ ...EDIT, priority: "x" }, NOTES), []);
});

test("applyEdit: the date's section grows, a closed item moves under it, follow-ups join the list, context only grows", () => {
  const out = nu.applyEdit(NOTES, "2026-10-21", EDIT);
  const want = `# Sam Meeting Notes

## Running Context (Full History)

A living summary.

### People

**Robin** — Sales ops. [Jul 14] Ramp-up done.

**Lee** — [Oct 21] Leads inbound recruiting.

### Deals & Business Topics

**Acme** — [Sep 22] Single vendor for device management. [Oct 21] Pilot agreed for November.

### Fundraise

**Seed round** — [Oct 21] Two investor meetings booked.

## To Discuss (Upcoming)
- [ ] Robin — follow up on title/equity decision (discussed Jul 8)
- [ ] Acme pilot — check the November start date.

## Discussed

### 2026-10-21
- Acme wants a pilot in November.
- Fundraise: two investor meetings booked.
- [x] Acme deal — follow up on progress (discussed Sep 22).

### 2026-10-20
- Team, fundraise and product discussed.

### 2026-10-09
- Customer ordering website.
`;
  assert.equal(out, want);
  // Every line of the old file except the closed item is still there.
  const kept = new Set(out.split("\n"));
  for (const l of NOTES.split("\n")) {
    if (l.startsWith("- [ ] Acme deal") || l.startsWith("**Acme**")) continue;
    assert.ok(kept.has(l), l);
  }
});

test("applyEdit on a date that already has notes appends to it", () => {
  const out = nu.applyEdit(NOTES, "2026-10-20", { discussed: ["Product is the missing piece."], closed_items: [], follow_ups: [], recap: ["Product"], context: [] });
  assert.ok(out.includes("### 2026-10-20\n- Team, fundraise and product discussed.\n- Product is the missing piece.\n\n### 2026-10-09"), out);
});

test("the prompt shows the open items and the context names to copy", () => {
  const p = nu.editPrompt({ date: "2026-10-21", when: "4:09pm-5:17pm, 68 min", source: "summary", content: "Product.", notesText: NOTES });
  assert.ok(p.includes("- [ ] Robin — follow up on title/equity decision (discussed Jul 8)"));
  assert.ok(p.includes("People: Robin") && p.includes("Deals & Business Topics: Acme"));
  assert.ok(p.endsWith("Zoom summary:\nProduct."));
  assert.equal(nu.dayTag("2026-10-21"), "Oct 21");
});

test("setItemDone: ticks a To Discuss line in place and back; anything else is refused", () => {
  const notes = "## To Discuss (Upcoming)\n- [ ] Alpha — x\n- [ ] Beta\n\n## Discussed\n- [ ] Alpha — x\n";
  const ticked = nu.setItemDone(notes, "Alpha — x", true);
  assert.equal(ticked, notes.replace("- [ ] Alpha — x\n- [ ] Beta", "- [x] Alpha — x\n- [ ] Beta"));
  assert.equal(nu.setItemDone(ticked, "Alpha — x", true), ticked);
  assert.equal(nu.setItemDone(ticked, "Alpha — x", false), notes);
  assert.equal(nu.setItemDone(notes, "Alpha", true), null);
  assert.ok(!nu.openItems(ticked).includes("Alpha — x"));
});
