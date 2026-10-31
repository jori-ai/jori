// tools-mcp/modules/watchlist.mjs — where to watch a show or movie (bin/watchlist where).
// Served by agent/tools-mcp/index.mjs (loadExtTools). `after` keeps the tool at its place
// in the served tool list (`tools_after` in agent/local/config/watchlist.json overrides it).
// Needs TMDB_API_KEY in .env; without it the CLI answers that TMDB is not configured.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { localConfig, instance } = require("../../../lib/instance.cjs");
const cfg = localConfig("watchlist", { tools_after: "resy_list", home_region: "US" });

export const after = cfg.tools_after;

export function tools({ BIN, run }) {
  const home = String(cfg.home_region || "US").toUpperCase();
  const owner = instance().owner_name;
  return [
    {
      name: "watch_where",
      description: `Where can ${owner} actually watch a show or movie: every way to get it (stream on a subscription, free, free with ads, rent, buy) in the home region (${home}), plus the LOCAL country automatically when the travel timeline puts them abroad. Any title — on the watchlist or not. Source: TMDB watch-providers (JustWatch data), cached 7 days per title. Use this instead of stating a platform from memory. \`region\` overrides the countries (ISO codes, e.g. "GB" or "${home},GB").`,
      schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Show or movie name, or an IMDb id (tt…)" },
          region: { type: "string", description: `Optional ISO country code(s), comma-separated. Default: ${home} + current country when abroad.` },
          type: { type: "string", enum: ["show", "movie"], description: "Optional, disambiguates a title that is not on the watchlist" },
        },
        required: ["title"],
      },
      run: (a) => run("node", [`${BIN}/watchlist`, "where", a.title,
        ...(a.region ? ["--region", a.region] : []), ...(a.type ? ["--type", a.type] : [])]),
    },
  ];
}
