/**
 * The URL contract between the weekly cruise-watch email and this site.
 *
 * The email stopped being a list on 2026-08-31 and became an alert on price
 * movement, with the full corpus living here. That only works if the email can
 * point AT something: a card saying "Celebrity Reflection dropped 19%" is a
 * dead end unless clicking it lands on that sailing rather than on the front
 * page, where a $440/night cabin cap and a travel-plan filter may well hide it.
 *
 * Every parameter is optional and additive; an unknown one is ignored, so an
 * old email keeps working after this file changes. Values are matched against
 * the same canonical forms the site itself uses (normalized ports, extractor
 * line keys), because those are what the email's own data carries.
 *
 * Built by bin/cruise-link so a playbook never hand-encodes a sailing id
 * — they contain a colon (`celebrity:RF4BH330_2026-12-07`) and must be escaped.
 */

export const DEEP_LINK_PARAMS = {
  /** One sailing by id. Overrides every filter — see parseDeepLink. */
  sailing: "sailing",
  /** Bucket views, matching the email's three alert sections. */
  drops: "drops",
  atl: "atl",
  plan: "plan",
  /** Ordinary filters, so a link can open "Celebrity out of Barcelona in December". */
  line: "line",
  port: "port",
  region: "region",
  month: "month",
  year: "year",
  ship: "ship",
  q: "q",
  sort: "sort",
  /** Ceiling on the CABIN's nightly rate (two people); `any` lifts the default
   *  cap. The unit briefly went per-person on 2026-09-01 and came back the same
   *  day; no email was generated in between, so no link in the wild carries a
   *  per-person value. */
  maxNight: "maxnight",
} as const;

export type DeepLink = {
  /** When set, the site shows exactly this sailing and nothing else. */
  focusSailing: string | null;
  drops: boolean;
  atl: boolean;
  /** Tri-state: true/false override the default, null leaves it alone. */
  plan: boolean | null;
  lines: string[];
  ports: string[];
  regions: string[];
  months: number[];
  years: number[];
  q: string | null;
  sort: string | null;
  /** number = cap, null = leave default, "any" = no cap at all. */
  maxCabinPerNight: number | null | "any";
  /** True when the URL asked for anything at all. */
  any: boolean;
};

type Raw = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Comma-separated list → trimmed values. `a,b` and repeated params both work. */
function many(v: string | string[] | undefined): string[] {
  const parts = Array.isArray(v) ? v : v ? [v] : [];
  return parts
    .flatMap((p) => p.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

function truthy(v: string | string[] | undefined): boolean {
  const s = one(v);
  return s === "1" || s === "true" || s === "";
}

export function parseDeepLink(sp: Raw): DeepLink {
  const P = DEEP_LINK_PARAMS;
  const months = many(sp[P.month])
    .map((m) => Number(m))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 12)
    .map((n) => n - 1); // the URL speaks 1–12; the UI indexes 0–11
  const years = many(sp[P.year])
    .map((y) => Number(y))
    .filter((n) => Number.isFinite(n) && n > 2000 && n < 2100);

  const rawMax = one(sp[P.maxNight]);
  const maxCabinPerNight: number | null | "any" =
    rawMax === null ? null : rawMax === "any" ? "any" : Number.isFinite(Number(rawMax)) ? Number(rawMax) : null;

  const planRaw = one(sp[P.plan]);
  const plan = planRaw === null ? null : planRaw === "0" || planRaw === "false" ? false : true;

  const out: DeepLink = {
    focusSailing: one(sp[P.sailing]),
    drops: truthy(sp[P.drops]),
    atl: truthy(sp[P.atl]),
    plan,
    lines: many(sp[P.line]),
    ports: many(sp[P.port]),
    regions: many(sp[P.region]),
    months,
    years,
    q: one(sp[P.q]) ?? (one(sp[P.ship]) || null),
    sort: one(sp[P.sort]),
    maxCabinPerNight,
    any: false,
  };
  out.any =
    !!out.focusSailing || out.drops || out.atl || out.plan !== null ||
    out.lines.length > 0 || out.ports.length > 0 || out.regions.length > 0 ||
    out.months.length > 0 || out.years.length > 0 ||
    !!out.q || !!out.sort || out.maxCabinPerNight !== null;
  return out;
}
