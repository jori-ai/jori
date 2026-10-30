// jev-location-confirm.test.mjs — the Jev-primary tail of location-confirm-resolve
// (lib/location-confirm-jev.mjs). Global fetch is stubbed; config, question
// and shadow-log paths point at temp fixtures; no alerts.
//
// Run: node --test tests/jev-location-confirm.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-loc-"));
process.env.JEV_CONFIG_FILE = path.join(tmp, "jev-config.json");
// The kernel's question definitions (an installation may override them in data/jev-questions).
process.env.JEV_QUESTIONS_DIR = path.join(HERE, "../agent/config/jev-questions");
process.env.JEV_SHADOW_DIR = path.join(tmp, "shadow");
process.env.JEV_NO_ALERT = "1";
process.env.TYPESAFE_API_KEY = "test-key";
// The on-device privacy screen is exercised by its own test below; elsewhere it's off.
process.env.JEV_PRIVATE_SCREEN = "off";
fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({
  shadow_days: 7, shadow_until: new Date(Date.now() + 864e5).toISOString(), default_threshold: 0.85, sites: {},
}));

const { resolveTail, hasMedicalCandidate } = await import("../lib/location-confirm-jev.mjs");

let jevCalls = [];
let jevAnswer = null;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, init) => {
    // Ollama (the on-device privacy screen) is unreachable in tests.
    if (String(url).includes("/api/")) throw new Error("ECONNREFUSED (test: no ollama)");
    jevCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ model: "jev-latest", answers: jevAnswer, providerMetadata: { gateway: { cost: "0.00001" } } }), { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { jevCalls = []; });

const cands = [
  { name: "Cafe Luna", primary_type: "cafe", address: "1 Main St" },
  { name: "Book Nook", primary_type: "book_store", address: "3 Main St" },
];
const now = Date.now();
const win = { startMs: now - 60 * 60e3, endMs: now - 10 * 60e3 };
const msgs = [{ role: "user", body: "Lunch at Numidia.", at: new Date(now - 30 * 60e3).toISOString() }];
const choice = (pick, p) => ({ venue: { type: "choice", choice: pick, probabilities: { [pick]: p, [pick === "ask" ? "c1" : "ask"]: 1 - p } } });
function shadowRows() {
  const dir = process.env.JEV_SHADOW_DIR;
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
}

test("confident Jev candidate pick is acted on; candidates become choice options", async () => {
  jevAnswer = choice("c2", 0.97);
  const r = await resolveTail({ cands, cal: [], msgs: [], dwellWindow: win, wiki: [], askId: "a1", centroid: { lat: 1, lon: 2 }, extractVenueFrom: async () => null });
  assert.equal(r.decision, "auto_confirm");
  assert.equal(r.venue, "Book Nook");
  assert.equal(r.source, "jev:candidate");
  const crit = jevCalls[0].questions.venue.criteria;
  assert.ok(crit.c1.startsWith("Cafe Luna") && crit.c2.startsWith("Book Nook") && crit.ask && crit.named_other);
  // Legacy (no window messages → ask) disagrees → logged.
  const row = shadowRows().find((x) => x.id === "a1");
  assert.equal(row.used, "jev");
  assert.equal(row.agree, false);
});

test("below the 0.9 threshold the legacy tail decides (ask)", async () => {
  jevAnswer = choice("c1", 0.8);
  const r = await resolveTail({ cands, cal: [], msgs: [], dwellWindow: win, wiki: [], askId: "a2", centroid: { lat: 1, lon: 2 }, extractVenueFrom: async () => null });
  assert.equal(r.decision, "ask");
  assert.equal(shadowRows().find((x) => x.id === "a2").reason, "jev-low-confidence");
});

test("named_other reuses ONE Gemma extraction and agrees with the legacy non-candidate confirm", async () => {
  jevAnswer = choice("named_other", 0.95);
  let extractions = 0;
  const r = await resolveTail({ cands, cal: [], msgs, dwellWindow: win, wiki: [], askId: "a3", centroid: { lat: 1, lon: 2 },
    extractVenueFrom: async () => { extractions++; return "Numidia"; } });
  assert.equal(r.decision, "auto_confirm");
  assert.equal(r.venue, "Numidia");
  assert.equal(r.source, "jev:named_other");
  assert.equal(extractions, 1);
  assert.equal(shadowRows().find((x) => x.id === "a3").agree, true);
});

// 2026-10-20: gemma3:1b answered with the prompt's own slot text, and it was saved
// as the name of the visit to a family home.
const SLOT_ECHO = "<exact venue name as he wrote it, or empty string if none>";
test("an extraction that echoes the prompt's slot is no venue, on both paths", async () => {
  jevAnswer = choice("named_other", 0.95);
  const viaJev = await resolveTail({ cands, cal: [], msgs, dwellWindow: win, wiki: [], askId: "a-slot-1", centroid: { lat: 1, lon: 2 },
    extractVenueFrom: async () => SLOT_ECHO });
  assert.equal(viaJev.decision, "ask");
  assert.equal(viaJev.source, "jev:named_other");
  jevAnswer = choice("c1", 0.5);
  const viaLegacy = await resolveTail({ cands, cal: [], msgs, dwellWindow: win, wiki: [], askId: "a-slot-2", centroid: { lat: 1, lon: 2 },
    extractVenueFrom: async () => ` ${SLOT_ECHO} ` });
  assert.equal(viaLegacy.decision, "ask");
  assert.doesNotMatch(JSON.stringify(viaLegacy), /exact venue name/);
});

test("Jev ask is acted on without calling the extractor on the primary path", async () => {
  jevAnswer = choice("ask", 0.99);
  const r = await resolveTail({ cands, cal: [], msgs: [], dwellWindow: win, wiki: [], askId: "a4", centroid: { lat: 1, lon: 2 }, extractVenueFrom: async () => "X" });
  assert.equal(r.decision, "ask");
  assert.equal(r.source, "jev");
  assert.equal(shadowRows().find((x) => x.id === "a4").agree, true);
});

test("a medical candidate keeps the ask off Jev entirely (health rule)", async () => {
  assert.equal(hasMedicalCandidate([{ name: "Dr X", primary_type: "doctor" }]), true);
  assert.equal(hasMedicalCandidate([{ name: "Y", types: ["point_of_interest", "pharmacy"] }]), true);
  assert.equal(hasMedicalCandidate(cands), false);
  jevAnswer = choice("c1", 0.99);
  const r = await resolveTail({ cands: [...cands, { name: "City Clinic", primary_type: "medical_clinic" }], cal: [], msgs, dwellWindow: win,
    wiki: [], askId: "a5", centroid: { lat: 1, lon: 2 }, extractVenueFrom: async () => "Numidia" });
  assert.equal(jevCalls.length, 0);
  assert.equal(r.source, "local:message_explicit");
  const row = shadowRows().find((x) => x.id === "a5");
  assert.equal(row.reason, "health-excluded");
  assert.doesNotMatch(JSON.stringify(row), /Numidia/);
});

test("privacy screen fails closed: calendar evidence never reaches Jev when the screen can't clear it", async () => {
  process.env.JEV_PRIVATE_SCREEN = "";
  try {
    jevAnswer = choice("c1", 0.99);
    const r = await resolveTail({ cands, cal: [{ summary: "Cardiology follow-up", start: new Date(now - 50 * 60e3).toISOString() }],
      msgs: [], dwellWindow: win, wiki: [], askId: "a-priv", centroid: { lat: 1, lon: 2 }, extractVenueFrom: async () => null });
    assert.equal(r.decision, "ask");
    assert.equal(jevCalls.length, 0, "Jev not called");
    const row = shadowRows().find((x) => x.id === "a-priv");
    assert.match(row.reason, /^sensitive-excluded/);
    assert.equal(row.input, "[withheld]");
  } finally { process.env.JEV_PRIVATE_SCREEN = "off"; }
});
