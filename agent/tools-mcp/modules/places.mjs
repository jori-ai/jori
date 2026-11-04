// tools-mcp/modules/places.mjs — Nearby places via Google Places (bin/places).
// Optional tools served by agent/tools-mcp/index.mjs (loadExtTools):
// `after` keeps them at their place in the served tool list.
export const after = "notes_edit";

export function tools({ BIN, run }) {
  return [
    // ── Places ──
    {
      name: "places_nearby",
      description: "Search for nearby places using Google Places API. Pass lat/lon if known (e.g. from get_location), otherwise uses the installation's configured locator (agent/local/config/places.json locate_cmd). Output may also include a 'Your saved places nearby' section — Google Maps places the user tagged (Favorites/Want-to-go/Starred), imported via places-saved-import, that fall within range of the location (independent of the query). Surface those prominently when present; they're spots the user already wants to visit. Needs GOOGLE_PLACES_API_KEY; without it the tool says Places is not set up.",
      schema: { type: "object", properties: { query: { type: "string", description: "e.g. 'sushi', 'coffee shop', 'gas station'" }, lat: { type: "number", description: "Latitude (optional — from get_location)" }, lon: { type: "number", description: "Longitude (optional — from get_location)" },
        lean: { type: "boolean", description: "Names, types and positions only — the cheap tier. Use for 'is business X at this spot' checks." },
        detail: { type: "boolean", description: "Add reviews and Google's overview line — the expensive tier ($0.04 a call), capped per day (lib/places-tier-policy.json mcp-rich). Only when the user asks what a place is like." } }, required: ["query"] },
      // Tier = price (lib/places-tier-policy.json): default standard
      // (ratings, hours), lean (names only), detail → rich under the mcp-rich lane.
      run: (a) => {
        const tier = a.detail ? ["--tier", "rich", "--lane", "mcp-rich"] : a.lean ? ["--lean", "--lane", "mcp"] : ["--lane", "mcp"];
        return a.lat && a.lon
          ? run(`${BIN}/places`, ["at", `${a.lat},${a.lon}`, a.query, ...tier])
          : run(`${BIN}/places`, ["nearby", a.query, ...tier]);
      },
    },
  ];
}
