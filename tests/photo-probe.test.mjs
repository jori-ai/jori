// photo-probe.test.mjs — the server's request to the phone for a stop's photos
// (2026-10-08): reuse of an existing probe, the wait timeout, and fail-open
// when nothing can wake the phone.

import test from "node:test";
import assert from "node:assert/strict";
// A stub Supabase base, so the module never needs (or reaches) a configured one.
process.env.SUPABASE_URL = "http://127.0.0.1:9";
const { reusable, requestProbe, waitProbe, probeForWindow, SAME_WINDOW_MS } = await import("../lib/photo-probe.mjs");

const END = Date.parse("2026-10-08T12:29:37Z");
const START = Date.parse("2026-10-08T11:24:05Z");

test("reusable: pending for the same window, done only if answered after the window", () => {
  const we = new Date(END).toISOString();
  assert.equal(reusable({ status: "pending", window_end: we }, END), true);
  assert.equal(reusable({ status: "pending", window_end: new Date(END + SAME_WINDOW_MS + 1000).toISOString() }, END), false);
  assert.equal(reusable({ status: "done", window_end: we, answered_at: new Date(END + 60000).toISOString() }, END), true);
  assert.equal(reusable({ status: "done", window_end: we, answered_at: new Date(END - 60000).toISOString() }, END), false,
    "answered before the window ended — photos taken after the answer were never seen");
  assert.equal(reusable({ status: "error", window_end: we }, END), false);
  assert.equal(reusable({ status: "expired", window_end: we }, END), false);
});

// A tiny in-memory photo_probes table behind a fake fetch.
function fakeDb(initial = []) {
  const rows = initial.map((r) => ({ ...r }));
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    calls.push({ method, path: u.pathname + u.search });
    const json = (b) => ({ ok: true, json: async () => b, text: async () => JSON.stringify(b) });
    if (method === "PATCH") return json(null);
    if (method === "POST") {
      const b = JSON.parse(init.body);
      const row = { id: `p${rows.length + 1}`, status: "pending", requested_at: new Date(END + 120000).toISOString(), ...b };
      rows.push(row);
      return json([row]);
    }
    const id = u.searchParams.get("id");
    if (id) return json(rows.filter((r) => `eq.${r.id}` === id));
    const vid = u.searchParams.get("visit_id");
    return json(rows.filter((r) => `eq.${r.visit_id}` === vid));
  };
  return { rows, calls, fetch };
}

test("requestProbe reuses a pending probe for the same visit and window, without a push", async () => {
  const db = fakeDb([{ id: "old", visit_id: "v1", status: "pending", window_end: new Date(END).toISOString(), requested_at: "2026-10-08T12:40:00Z" }]);
  let pushed = 0;
  const r = await requestProbe({ visitId: "v1", start: START, end: END },
    { fetch: db.fetch, key: "k", push: async () => { pushed++; return { delivered: true }; } });
  assert.equal(r.reused, true);
  assert.equal(r.id, "old");
  assert.equal(pushed, 0);
});

test("requestProbe inserts and pushes when nothing reusable exists", async () => {
  const db = fakeDb([{ id: "stale", visit_id: "v1", status: "done", window_end: new Date(END).toISOString(), answered_at: new Date(END - 600000).toISOString() }]);
  const pushes = [];
  const r = await requestProbe({ visitId: "v1", start: START, end: END },
    { fetch: db.fetch, key: "k", push: async (data) => { pushes.push(data); return { delivered: true, ok: 1, sent: 1 }; } });
  assert.equal(r.reused, false);
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0], { kind: "photo_probe", probe_id: r.id });
});

test("waitProbe gives up at the timeout and returns the still-pending row", async () => {
  const db = fakeDb([{ id: "p", visit_id: "v", status: "pending", window_end: new Date(END).toISOString(), requested_at: new Date(END).toISOString() }]);
  let t = 0;
  const row = await waitProbe("p", { timeoutMs: 10000 },
    { fetch: db.fetch, key: "k", now: () => t, sleep: async (ms) => { t += ms; } });
  assert.equal(row.status, "pending");
  assert.ok(t >= 10000 && t < 13000, `waited ${t} ms`);
});

test("waitProbe returns as soon as the phone answers", async () => {
  const db = fakeDb([{ id: "p", visit_id: "v", status: "pending", window_end: new Date(END).toISOString(), requested_at: new Date(END).toISOString() }]);
  let t = 0;
  const row = await waitProbe("p", { timeoutMs: 45000 }, {
    fetch: db.fetch, key: "k", now: () => t,
    sleep: async (ms) => { t += ms; if (t >= 6000) Object.assign(db.rows[0], { status: "done", photo_count: 2, answered_at: new Date(END + 300000).toISOString() }); },
  });
  assert.equal(row.status, "done");
  assert.equal(row.photo_count, 2);
  assert.ok(t <= 9000);
});

test("probeForWindow is 'unavailable' (don't wait) when the push reached no device", async () => {
  const db = fakeDb();
  let slept = 0;
  const r = await probeForWindow({ visitId: "v9", start: START, end: END, waitMs: 45000 },
    { fetch: db.fetch, key: "k", push: async () => ({ delivered: false, reason: "no iOS device tokens" }), sleep: async () => { slept++; } });
  assert.equal(r.status, "unavailable");
  assert.equal(slept, 0);
  assert.equal(db.rows.length, 1, "the row stays for the app to answer later");
});

test("probeForWindow is 'unavailable' when the database can't be reached", async () => {
  const r = await probeForWindow({ visitId: "v", start: START, end: END },
    { fetch: async () => ({ ok: false, status: 503, text: async () => "down" }), key: "k" });
  assert.equal(r.status, "unavailable");
  assert.match(r.reason, /503/);
});
