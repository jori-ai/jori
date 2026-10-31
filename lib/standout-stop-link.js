"use strict";
// A card charge's stop, when the bank spells the business one way and the stop
// another. selectStandouts (daily-summary-transactions.js) matches a merchant to
// a stop by shared Latin words, so an in-store charge spelled one way never met
// the stop the user called by another spelling (and had titled in Hebrew the
// night before), and the summary listed it apart from the meal it paid for. Whether
// two spellings, or two scripts, name one business is language (Rule #0b), so a
// model reads it: Sonnet, then Opus when Sonnet's answer fails the schema or the
// call fails, on the Max session. Bank rows are Jori-model-only: never Jev,
// never a connector, and only the merchant's name goes out, never an amount. No
// local rung: a 1B model fills a pick-one schema without reading. Only an in-store charge no stop matched is asked
// about, against stops that have a name. Fail-open: an error leaves the charge
// where it was. Answers are cached per day, so a re-prep asks nothing new.
// JORI_STANDOUT_LINK=0 disables it.
//
// A stop's name alone was not enough when the user knows a place by a short name and
// the bank prints its full one: the model read the two as different businesses,
// and the charge was listed apart from the meal it paid for. So each stop also
// carries the businesses right beside the user's photos there (the phone's own reading
// of nearby places, placesBesidePhotos), which can show a short name's full form.
// They only name the stop's business; a charge at a neighbour is not its match.
// The same goes for the charge's side: the bank's cleaned-up merchant name can
// drop the part of the name a stop shares, which its own statement line still
// has, so that line goes with it (statementLine: its digits removed, so no
// reference number or amount leaves the machine).

const fs = require("node:fs");
const path = require("node:path");
const { judge } = require("./max-judge.js");
const { MODELS } = require("./models.cjs");

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["stop_id"],
  properties: { stop_id: { type: ["string", "null"] } },
};
const SYSTEM = "You match a card charge to the place it was made, using only the names given.";

function askable(standouts) {
  return (standouts || []).filter((t) => t && !t.stop_id && t.payment_channel === "in store" && t.merchant);
}

function namedStops(stops, near = {}) {
  return (stops || [])
    .filter((s) => s && s.id && s.place && s.place.name && !s.is_movement && !s.user_non_stop)
    .map((s) => ({ id: s.id, name: s.place.name, time: `${s.start}-${s.end}`, near: (near && near[s.id]) || [] }));
}

// The businesses within NEAR_M of the user's photos at each stop, nearest first, at most
// NEAR_MAX: { stop_id: [name, ...] }. `rows` are the day's photos as
// { uuid, device_venue: { pois: [{ name, distance_m }] } }; a photo with no
// reading adds nothing, and a stop with none is left out.
const NEAR_M = 25;
const NEAR_MAX = 6;
function placesBesidePhotos(stops, rows) {
  const venue = new Map((rows || []).filter((r) => r && r.uuid).map((r) => [r.uuid, r.device_venue]));
  const out = {};
  for (const s of stops || []) {
    if (!s || !s.id) continue;
    const nearest = new Map();
    for (const p of s.photos || []) {
      const v = p && venue.get(p.uuid);
      for (const x of (v && Array.isArray(v.pois) ? v.pois : [])) {
        const d = x && x.distance_m != null ? Number(x.distance_m) : NaN;
        if (!x || !x.name || !Number.isFinite(d) || d > NEAR_M) continue;
        if (!nearest.has(x.name) || d < nearest.get(x.name)) nearest.set(x.name, d);
      }
    }
    const names = [...nearest.entries()].sort((a, b) => a[1] - b[1]).slice(0, NEAR_MAX).map(([n]) => n);
    if (names.length) out[s.id] = names;
  }
  return out;
}

// The statement line for a charge when it says more than its merchant name:
// digits dropped, spacing folded, at most 60 characters; null when it adds nothing.
function statementLine(t, lines) {
  const raw = t && t.transaction_id && lines ? lines[t.transaction_id] : null;
  if (typeof raw !== "string") return null;
  const line = raw.replace(/[0-9]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60); // lang-regex-ok: strips reference digits and spacing from a bank statement descriptor; no meaning is read
  if (!line || line.toLowerCase() === String(t.merchant || "").trim().toLowerCase()) return null;
  return line;
}

function prompt(merchant, stops, statement = null) {
  return [
    `A card charge was made in person at a business the bank calls "${merchant}"${statement ? ` (its statement line reads "${statement}")` : ""}.`,
    "These are the places the user stopped that day (id, the name the user knows it by, local time, and where the user took photos there, the businesses right beside them):",
    ...stops.map((s) => `- ${s.id}: ${s.name} (${s.time})${s.near && s.near.length ? `; beside the user's photos: ${s.near.join(", ")}` : ""}`),
    "Is one of them the same business as the charge? A name may be spelled differently, transliterated, shortened, or written in another script (Hebrew, for example). The businesses beside the user's photos can show the full name of a place the user knows by a short one; they are not themselves places the user stopped at.",
    'Answer {"stop_id": "<id>"} only when the charge and that stop clearly name the same business; otherwise {"stop_id": null}.',
  ].join("\n");
}

async function askLadder(text, ids, { judgeFn = judge } = {}) {
  for (const model of [MODELS.sonnet, MODELS.opus]) {
    try {
      const out = await judgeFn({ model, system: SYSTEM, prompt: text, schema: SCHEMA, effort: "low", timeoutMs: 120000 });
      const id = out ? out.stop_id : undefined;
      if (id === null || ids.includes(id)) return { stop_id: id, model };
    } catch (e) {
      if (e && e.fatal) return null;
    }
  }
  return null;
}

async function linkStandoutsToStops(data, stops, { date = null, ask = askLadder, cacheFile = null, near = {}, statements = null } = {}) {
  const linked = [];
  if (process.env.JORI_STANDOUT_LINK === "0" || !data || !Array.isArray(data.standouts)) return linked;
  const todo = askable(data.standouts);
  const named = namedStops(stops, near);
  if (!todo.length || !named.length) return linked;
  const ids = named.map((s) => s.id);
  const file = cacheFile || (date ? path.join("/tmp", `ds-standout-links-${date}.json`) : null);
  let cache = {};
  try { if (file && fs.existsSync(file)) cache = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { cache = {}; }
  let dirty = false;
  for (const t of todo) {
    const statement = statementLine(t, statements);
    const key = JSON.stringify([statement ? [t.merchant, statement] : t.merchant, named.map((s) => (s.near.length ? [s.id, s.name, s.near] : [s.id, s.name]))]);
    let ans = cache[key];
    if (ans === undefined) {
      ans = await ask(prompt(t.merchant, named, statement), ids);
      if (ans) { cache[key] = ans; dirty = true; }
    }
    if (!ans || !ans.stop_id || !ids.includes(ans.stop_id)) continue;
    t.stop_id = ans.stop_id;
    t.stop_link = "model";
    if (data.byStopId && typeof data.byStopId === "object") (data.byStopId[t.stop_id] = data.byStopId[t.stop_id] || []).push(t);
    linked.push({ merchant: t.merchant, stop_id: t.stop_id, model: ans.model || null });
  }
  if (dirty && file) { try { fs.writeFileSync(file, JSON.stringify(cache)); } catch { /* the cache never fails a prep */ } }
  return linked;
}

module.exports = { linkStandoutsToStops, askLadder, prompt, askable, namedStops, placesBesidePhotos, statementLine, SCHEMA };
