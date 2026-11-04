// Port matcher — given a sailing's departure port (name + optional code/coords),
// find the cruise-ports.json entry that owns it, then expose its city_aliases
// for matching against the travel-plan windows.
//
// Match order:
//   1. Code match against the port's `codes` list (each line uses its own
//      code dialect — two lines can spell one port two ways, so we list them all).
//   2. Exact-name match against `port` or `name_aliases`.
//   3. Token-overlap match: every distinctive token (>=4 chars, non-generic)
//      in the cruise's port name must appear in our port's name_aliases.
//   4. Geo proximity (great-circle <= 25 mi) if both sides have lat/lon.
//
// Substring "Port".includes("Port") matches were intentionally REMOVED because
// they cause "Orlando (Port Canaveral)" → "Port Everglades" cascades that
// then port-window-match incorrectly. Better to drop a sailing than alias-match
// it to the wrong city.
//
// Returns the port record (with city_aliases) or null.

// The catalog is this installation's data/cruise-ports.json; with none, no
// port matches and the watch finds nothing reachable.
import { readCatalog } from "./config.mjs";

let PORTS = null;

async function loadPorts() {
  if (PORTS) return PORTS;
  const json = await readCatalog("cruise-ports.json");
  PORTS = json?.ports || [];
  return PORTS;
}

function haversineMi(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.7613; // Earth radius in miles
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const GENERIC_TOKENS = new Set([
  "port", "cruise", "terminal", "the", "of", "de", "del", "la", "le", "el",
]);

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[(),.\-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t));
}

export async function matchPort({ name, code, lat = null, lon = null }) {
  const ports = await loadPorts();
  // 1. Code match (each port has a `codes` list of line-specific codes).
  if (code) {
    const c = String(code).toUpperCase();
    for (const p of ports) {
      const codes = p.codes || (p.code ? [p.code] : []);
      if (codes.map((x) => x.toUpperCase()).includes(c)) return p;
    }
  }
  // 2. Exact name match (against `port` or `name_aliases`).
  const needle = (name || "").toLowerCase().trim();
  if (needle) {
    for (const p of ports) {
      if (p.port.toLowerCase() === needle) return p;
      if ((p.name_aliases || []).some((a) => a.toLowerCase() === needle)) return p;
    }
    // 3. Token-overlap match — every distinctive token in the cruise's name
    //    must appear in our port's name+aliases token bag.
    const cruiseTokens = tokenize(needle);
    if (cruiseTokens.length > 0) {
      for (const p of ports) {
        const portBag = new Set([
          ...tokenize(p.port),
          ...((p.name_aliases || []).flatMap(tokenize)),
        ]);
        if (portBag.size === 0) continue;
        const allMatch = cruiseTokens.every((t) => portBag.has(t));
        if (allMatch) return p;
      }
    }
  }
  // 4. Geo proximity self-id (tight 25mi radius).
  if (typeof lat === "number" && typeof lon === "number") {
    let best = null;
    let bestDist = Infinity;
    for (const p of ports) {
      const d = haversineMi([lat, lon], [p.lat, p.lon]);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    if (best && bestDist <= 25) return best;
  }
  return null;
}

// Given a port match and the plan, return the matching plan window or null.
// A plan window has shape { city, start, end } where city is a string and
// start/end are YYYY-MM-DD inclusive.
export function findPlanWindow(port, planWindows, departDate) {
  if (!port || !planWindows?.length || !departDate) return null;
  const d = String(departDate);
  for (const window of planWindows) {
    if (!window?.start || !window?.end || !window?.city) continue;
    if (d < window.start || d > window.end) continue;
    if (port.city_aliases?.includes(window.city)) return window;
    // Fuzzy alias check: substring match
    const cityLower = window.city.toLowerCase();
    if (port.city_aliases?.some((a) => a.toLowerCase() === cityLower)) return window;
    if (port.city_aliases?.some((a) => a.toLowerCase().includes(cityLower) || cityLower.includes(a.toLowerCase()))) {
      return window;
    }
  }
  return null;
}

export { haversineMi };
