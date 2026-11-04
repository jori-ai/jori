// tools-mcp/modules/resy.mjs — Resy reservations (bin/resy).
// Optional tools served by agent/tools-mcp/index.mjs (loadExtTools):
// `after` keeps them at their place in the served tool list.
export const after = "places_nearby";

export function tools({ BIN, run }) {
  return [
    // ── Resy ──
    {
      name: "resy_search",
      description: "Search for restaurants on Resy",
      schema: { type: "object", properties: { query: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, party_size: { type: "number" } }, required: ["query"] },
      run: (a) => run("node", [`${BIN}/resy`, "search", a.query, ...(a.date ? ["--date", a.date] : []), ...(a.party_size ? ["--party", String(a.party_size)] : [])]),
    },
    {
      name: "resy_snipe",
      description: "Set up a reservation snipe: books the first matching slot the moment a Resy restaurant releases its tables. `venue` is the numeric Resy venue id (resy_search prints it as \"(ID: n)\") or a saved alias, not a restaurant name.",
      schema: { type: "object", properties: { venue: { type: "string", description: "Numeric Resy venue id or alias" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "Preferred time(s) HH:MM, comma-separated priority list e.g. '19:30,19:45'" }, party_size: { type: "number" }, drop: { type: "string", description: "When reservations release, HH:MM in the installation's time zone (default 00:00)" } }, required: ["venue", "date", "time"] },
      run: (a) => run("node", [`${BIN}/resy`, "snipe", String(a.venue), "--date", a.date, "--time", a.time, ...(a.party_size ? ["--party", String(a.party_size)] : []), ...(a.drop ? ["--drop", a.drop] : [])]),
    },
    {
      name: "resy_list",
      description: "List active Resy snipes",
      schema: { type: "object", properties: {} },
      run: () => run("node", [`${BIN}/resy`, "snipes"]),
    },
  ];
}
