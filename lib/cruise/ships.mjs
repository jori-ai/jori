// Ship-name → built_year resolver, fed by data/cruise-ships.json.
// Lookup is exact first, then case-insensitive substring (because lines render
// ship names slightly inconsistently — "MSC Magnifica" vs "Msc Magnifica").
// If a name doesn't resolve, return null and the filter drops the sailing
// (built_year > 2000 is a hard rule; no guessing).

// With no catalog file every name is unresolved, so the filter drops all.
import { readCatalog } from "./config.mjs";

let CATALOG = null;

async function loadCatalog() {
  if (CATALOG) return CATALOG;
  const json = (await readCatalog("cruise-ships.json")) || {};
  const flat = new Map();
  for (const [line, ships] of Object.entries(json.ships || {})) {
    for (const ship of ships) {
      if (!ship?.name) continue;
      flat.set(`${line}::${ship.name.toLowerCase()}`, {
        line,
        name: ship.name,
        built_year: ship.built_year ?? null,
      });
    }
  }
  CATALOG = flat;
  return CATALOG;
}

export async function lookupShip(line, shipName) {
  if (!line || !shipName) return null;
  const cat = await loadCatalog();
  const key = `${line}::${shipName.toLowerCase().trim()}`;
  if (cat.has(key)) return cat.get(key);
  // case-insensitive substring fallback within the same line
  const needle = shipName.toLowerCase().trim();
  for (const [k, v] of cat.entries()) {
    if (!k.startsWith(`${line}::`)) continue;
    if (k.includes(needle) || needle.includes(v.name.toLowerCase())) return v;
  }
  return null;
}
