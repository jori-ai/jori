#!/usr/bin/env node
// Family — upcoming birthdays (T-7/T-2/T-0) of the people this installation
// lists in agent/local/config/hum-family.json { birthdays: [{ who, mmdd }] }
// ("MM-DD"). No list → the lane stays quiet.
import { createRequire } from "node:module";
import { readStdinJson, emit, emitNull, stampRun, localConfig } from "./_common.mjs";

const require = createRequire(import.meta.url);
const { birthdayWindowHits } = require("../../../lib/hum-family-dates.js");

const { situation: sit, context } = await readStdinJson(); void sit; void context;
// Structured config, not parsed from memory each tick (memory files are prose).
const BIRTHDAYS = (localConfig("hum-family", { birthdays: [] }).birthdays || [])
  .filter((b) => b && typeof b.who === "string" && /^\d\d-\d\d$/.test(String(b.mmdd || ""))); // lang-regex-ok: MM-DD date shape

// Date math anchored through gdate.js (via hum-family-dates.js) instead of
// hand-rolled `new Date()` — see that file's header for why.
const hits = birthdayWindowHits(BIRTHDAYS);

if (hits.length === 0) { stampRun("family", false); emitNull("no birthday window"); process.exit(0); }

const top = hits[0];
const urgency = top.days === 0 ? 0.9 : (top.days === 2 ? 0.65 : 0.4);
stampRun("family", true);
emit({
  topic: "family",
  signal: top.days === 0
    ? `${top.who}'s birthday is today`
    : `${top.who}'s birthday in ${top.days} day${top.days === 1 ? "" : "s"}`,
  urgency,
  freshness_min: 0,
  dedup_key: `family:${top.who}:${top.mmdd}:T-${top.days}`,
  supporting_data: { top, all: hits },
});
