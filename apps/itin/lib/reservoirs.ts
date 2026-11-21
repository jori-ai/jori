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
import { resolveStays, ribbonItems, landingArea } from "./trip-stays.mjs";

export type RibbonItem = {
  key: string;
  area: string;
  label: string;
  start: string | null;
  end: string | null;
  hasGuide: boolean;
  past: boolean;
};

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

/** A ribbon item's dates: "12/5-12/13", "1/14-" when open-ended. */
export function formatItemRange(it: { start: string | null; end: string | null }): string | null {
  if (!it.start) return null;
  if (it.end == null) return `${formatRange({ start: it.start })}-`;
  return formatRange({ start: it.start, end: it.end });
}

/** The area to open by default: the stay under way today (on a changeover
 *  day, the one being arrived into), else the next one, else the most recent —
 *  preferring stays that have a guide. Dates come from the travel timeline (see
 *  listRibbon), "today" from the site's display zone (SITE_TZ). */
export async function defaultArea(): Promise<string | null> {
  const { items, today } = await listRibbon();
  return landingArea(items, today);
}

/** Today's date (YYYY-MM-DD) in the site's display zone. */
export function siteToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TZ }).format(new Date());
}

export type TimelineSegment = {
  metro: string;
  source: string | null;
  arrive_at: string;
  depart_at: string | null;
};

/** The travel timeline (travel_segments) — the actual dates of travel. Read
 *  live on every page so a re-booked leg shows at once, not after the nightly
 *  date sync. Allowlisted users only (RLS, system/migrations/0192). Empty when
 *  unreadable, so the ribbon falls back to each guide's stored dates. */
export async function listTimeline(): Promise<TimelineSegment[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("travel_segments")
    .select("metro,source,arrive_at,depart_at")
    .order("arrive_at", { ascending: true });
  return (data as TimelineSegment[]) ?? [];
}

/** The location ribbon: every stay on the timeline (each matched to its guide)
 *  plus the guides the timeline doesn't cover, in date order. */
export async function listRibbon(): Promise<{ items: RibbonItem[]; today: string }> {
  const [segments, guides] = await Promise.all([listTimeline(), listReservoirs()]);
  const today = siteToday();
  const stays = resolveStays(segments, { tz: SITE_TZ });
  return { items: ribbonItems(stays, guides, today) as RibbonItem[], today };
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
