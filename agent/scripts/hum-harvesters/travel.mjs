#!/usr/bin/env node
// Travel — imminent flights from data/flights.json.
import fs from "node:fs";
import { createRequire } from "node:module";
import { readStdinJson, emit, emitNull, stampRun } from "./_common.mjs";

const { situation: sit, context } = await readStdinJson(); void sit; void context;
const FLIGHTS = createRequire(import.meta.url)("../../../lib/root.cjs").installTools("data", "flights.json");

let flights = [];
try { flights = JSON.parse(fs.readFileSync(FLIGHTS, "utf8")); } catch {}
if (!Array.isArray(flights) || flights.length === 0) {
  stampRun("travel", false);
  emitNull("no flights data");
  process.exit(0);
}

const now = Date.now();
const upcoming = flights
  .map((f) => {
    const dep = new Date(f.depart || f.departure_time || f.scheduled || f.ts || 0).getTime();
    return { ...f, _dep: dep, _hoursUntil: (dep - now) / 3600000 };
  })
  .filter((f) => {
    if (!(f._hoursUntil > 0 && f._hoursUntil <= 48)) return false;
    // Canceled/refunded bookings stay in flights.json for audit (flights-scan.md
    // Step 4) but must never surface as an upcoming event — a canceled rental
    // stay once resurfaced as a phantom "0h departure" every tick.
    if (/cancel|refund/i.test(String(f.status || ""))) return false;
    return true;
  })
  .sort((a, b) => a._hoursUntil - b._hoursUntil);

if (upcoming.length === 0) {
  stampRun("travel", false);
  emitNull("no flights in next 48h");
  process.exit(0);
}

const top = upcoming[0];
const urgency = top._hoursUntil < 6 ? 0.8 : (top._hoursUntil < 24 ? 0.5 : 0.3);
stampRun("travel", true);
emit({
  topic: "travel",
  signal: `Flight ${top.number || top.flight || ""} to ${top.to || top.destination || "?"} in ${Math.round(top._hoursUntil)}h${top.status ? ` (${top.status})` : ""}`,
  urgency,
  freshness_min: 0,
  dedup_key: `travel:${top.number || ""}:${top.depart || ""}`,
  supporting_data: { top, count: upcoming.length },
});
