import { createClient } from "@/lib/supabase/server";
import { SITE_TZ } from "@/lib/config";

// The area "reservoir" — the standing inventory of what's worth doing in a
// place — is published to the `trip_reservoirs` Supabase table by
// bin/trip-reservoir-publish (one row per area). Same RLS as
// trip_itineraries: the signed-in user's JWT carries through createClient(), so
// only allowlisted emails read, and (since 2026-07-17) only they can write the
// done/undone marks.
//
// The site renders from `structured`, NOT from the row's pre-rendered
// `area_html`. It has to: each entry needs its own interactive done/undone
// button, which a baked HTML blob can't carry. `area_html` is still written by
// saveReservoir and is what the wiki mirror and any static consumer use — if you
// change how entries look here, that renderer (lib/reservoir-render.js)
// does NOT follow automatically.

export type {
  ReservoirEntry,
  ReservoirCluster,
  ReservoirStructured,
} from "./reservoir-entry";
export { visible } from "./reservoir-entry";

import type { ReservoirStructured } from "./reservoir-entry";

export type DateRange = { start?: string; end?: string; from?: string; to?: string };

// Accept either {start,end} (canonical) or {from,to} (older build output) so a
// shape mismatch never silently blanks a tab's dates again (2026-07-18).
function rangeStart(r: DateRange | null | undefined): string | undefined { return r?.start || r?.from; }
function rangeEnd(r: DateRange | null | undefined): string | undefined { return r?.end || r?.to; }
export type ReservoirSummary = { area: string; label: string; date_range: DateRange | null };
export type Reservoir = ReservoirSummary & { structured: ReservoirStructured };

/** Sort by arrival date — the order the trip actually visits them. Undated
 *  areas fall to the end rather than jumping the queue. */
function byVisitOrder(a: ReservoirSummary, b: ReservoirSummary): number {
  const as = rangeStart(a.date_range);
  const bs = rangeStart(b.date_range);
  if (as && bs) return as < bs ? -1 : as > bs ? 1 : 0;
  if (as) return -1;
  if (bs) return 1;
  return a.label.localeCompare(b.label);
}

/** "7/12-7/19" — month/day, start to end. */
export function formatRange(r: DateRange | null | undefined): string | null {
  const start = rangeStart(r);
  if (!start) return null;
  const end = rangeEnd(r);
  const md = (iso: string) => {
    const [, m, d] = iso.split("-");
    return `${Number(m)}/${Number(d)}`;
  };
  return end && end !== start ? `${md(start)}-${md(end)}` : md(start);
}

/** The leg to open by default: the one whose dates contain today, else the
 *  nearest upcoming leg, else the most recent past leg, else the first.
 *
 *  `areas` is assumed sorted by visit order (ascending start) — the order
 *  listReservoirs returns — so the first future match is the closest one and
 *  the last dated entry is the most recent past.
 *
 *  "Today" is resolved in the site's display zone (SITE_TZ — the user's home
 *  zone, UTC when unset). Legs span many days, so a few hours of
 *  timezone skew at midnight never changes which leg is current; picking a
 *  destination-local zone would be more precise but it isn't stored per area. */
export function defaultArea(areas: ReservoirSummary[]): string | null {
  if (!areas.length) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TZ }).format(new Date());
  const dated = areas.filter((a) => rangeStart(a.date_range));

  // A leg's checkout day is the next leg's check-in day, so both can contain
  // today. Keep the LAST match (dated is ascending by start) so on a transition
  // day you land on the leg you're arriving into, not the one you're leaving.
  let current: ReservoirSummary | undefined;
  for (const a of dated) {
    const s = rangeStart(a.date_range)!;
    const e = rangeEnd(a.date_range) || s;
    if (s <= today && today <= e) current = a;
  }
  if (current) return current.area;

  const upcoming = dated.find((a) => rangeStart(a.date_range)! > today);
  if (upcoming) return upcoming.area;

  if (dated.length) return dated[dated.length - 1].area; // all past → most recent
  return areas[0].area; // nothing dated → first
}

export async function listReservoirs(): Promise<ReservoirSummary[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("trip_reservoirs").select("area,label,date_range");
  return ((data as ReservoirSummary[]) ?? []).sort(byVisitOrder);
}

export async function getReservoir(area: string): Promise<Reservoir | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("trip_reservoirs")
    .select("area,label,date_range,structured")
    .eq("area", area)
    .maybeSingle();
  return (data as Reservoir) ?? null;
}
