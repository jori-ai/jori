"use strict";
// companions.js — who can be "with" the user in the location log, and under
// which name.
//
// Two lists, both private to the installation (absent in a fresh install, so
// every tag is kept as written and nobody is a known companion):
//   agent/local/config/companion-names.json
//     self     the user's own names: never a companion (the day is the user's
//              own story, the user is in every event); instance().owner_name
//              always counts too
//     aliases  an Apple Photos face-tag / free-text name -> the canonical name
//              stored in location_history.companions[] (one name per person)
//   data/known-companions.json  { names: [...] }
//     the people the assistant already knows, the only names a typed
//     companion annotation may add
//
// Read by the day resolver, the stop finder, the photo tools, companion
// presence and the daily-summary review. The Python twin is lib/companions.py.

const fs = require("node:fs");
const { instance, localConfig } = require("./instance.cjs");
const { installTools } = require("./root.cjs");

/** { self: [names], aliases: {tag: canonical} }, read per call. */
function companionNames() {
  const cfg = localConfig("companion-names", { self: [], aliases: {} });
  const self = [...new Set([...(Array.isArray(cfg.self) ? cfg.self : []), instance().owner_name].filter(Boolean))];
  const aliases = cfg.aliases && typeof cfg.aliases === "object" ? cfg.aliases : {};
  return { self, aliases };
}

/** The canonical companion name for a tag, or null for the user themself. */
function canonicalName(name, names = companionNames()) {
  if (!name || names.self.includes(name)) return null;
  return names.aliases[name] || name;
}

/**
 * One entry per person, never the user, in first-seen order. Entries may be
 * strings or objects with `name` (the object is kept, its name canonicalised).
 */
function canonicalCompanions(list, names = companionNames()) {
  const out = [], seen = new Set();
  for (const c of list || []) {
    const raw = typeof c === "string" ? c : c && c.name;
    const name = canonicalName(raw, names);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(typeof c === "string" ? name : { ...c, name });
  }
  return out;
}

const knownCompanionsFile = () => installTools("data", "known-companions.json");

/** The names in data/known-companions.json ([] when absent or unreadable). */
function knownCompanions(file = knownCompanionsFile()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(d) ? d : Array.isArray(d.names) ? d.names : [];
  } catch {
    return [];
  }
}

module.exports = { companionNames, canonicalName, canonicalCompanions, knownCompanions, knownCompanionsFile };
