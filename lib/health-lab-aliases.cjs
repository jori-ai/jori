"use strict";
// health-lab-aliases — natural-language lab names ("ldl", "a1c") → the FHIR
// codings an Observation may carry for them, for the health MCP's
// health_clinical_named tool.
//
// Two layers, appended per alias:
//   1. the kernel's LOINC map, agent/health-mcp/loinc-aliases.json;
//   2. agent/local/config/health.json `lab_code_aliases` — codes a lab reports
//      under its own coding system ({ "<alias>": [{system, code}, …] }), which
//      only this installation's records use. An alias may exist only here.
// A fresh install has layer 1 alone.

const fs = require("node:fs");
const path = require("node:path");
const { TOOLS_DIR } = require("./root.cjs");
const { localConfig } = require("./instance.cjs");

const KERNEL_MAP = path.join(TOOLS_DIR, "agent", "health-mcp", "loinc-aliases.json");

function readKernelMap(file = KERNEL_MAP) {
  return JSON.parse(fs.readFileSync(file, "utf8")).aliases || {};
}

// PURE. Merge the two layers; keys lowercased, duplicate codings dropped.
function mergeAliases(base = {}, extra = {}) {
  const out = {};
  const add = (k, codes) => {
    const key = String(k).trim().toLowerCase();
    if (!key || !Array.isArray(codes)) return;
    const list = out[key] || (out[key] = []);
    for (const c of codes) {
      if (!c || !c.system || !c.code) continue;
      if (!list.some((x) => x.system === c.system && x.code === c.code)) list.push({ system: c.system, code: c.code });
    }
  };
  for (const [k, v] of Object.entries(base)) add(k, v);
  for (const [k, v] of Object.entries(extra || {})) add(k, v);
  return out;
}

function labAliases({ file = KERNEL_MAP } = {}) {
  const { lab_code_aliases } = localConfig("health", { lab_code_aliases: {} });
  return mergeAliases(readKernelMap(file), lab_code_aliases);
}

// Aliases close to an unmapped name, for the "did you mean" reply.
function suggest(aliases, name, max = 10) {
  const key = String(name || "").trim().toLowerCase();
  const near = Object.keys(aliases).filter((k) => k.includes(key) || key.includes(k)).slice(0, max);
  return near.length ? near : Object.keys(aliases).slice(0, 20);
}

module.exports = { KERNEL_MAP, readKernelMap, mergeAliases, labAliases, suggest };
