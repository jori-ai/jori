import { createClient } from "@/lib/supabase/server";
import { SITE_TZ } from "@/lib/config";
import {
  SAILING_COLUMNS,
  SUPABASE_PAGE,
  SailingEncoder,
  type SailingIndex,
} from "@/lib/sailing-row";

// The server-side half of the cruise corpus behind the cruise site.
//
// `cruise_sailings` is written by the weekly cruise-watch orchestrator: every
// sailing all six lines return, not just the ~60 that pass the travel-plan
// filter. Since 2026-08-31 the email carries only significant price MOVEMENT
// (see lib/cruise/alerts.mjs); the whole list lives here, and filtering
// it is the site's entire job.
//
// Reads run with the signed-in user's JWT (never the service-role key), so the
// "cruise_sailings read for recipients" RLS policy is what actually authorizes
// them — lib/auth.ts is belt-and-braces on top.
//
// The wire encoding lives in lib/sailing-row.ts alongside its decoder, because
// the layout is positional and the two must never drift.

// Cap the corpus we hand the browser. Nothing is near it today (~6,800 rows)
// but the table only grows, and a page that silently gets slower every month is
// worse than one that says it truncated.
const MAX_ROWS = 12000;




/**
 * Every future sailing that has a balcony price, encoded for the client.
 *
 * Past sailings and unpriced inventory are excluded at the source: you cannot
 * book either, and together they are ~1,500 rows of pure weight. (Virgin
 * publishes most of its calendar unpriced — 503 of its 519 rows have no fare.)
 */
/**
 * The corpus behind the site: EVERY priced future sailing in our database.
 *
 * There is deliberately no freshness exclusion here any more. A 6-hour
 * per-sweep cutoff was added on 2026-09-01 to hide rows the lines had stopped
 * returning, and it was wrong twice over: the site runs on its own database,
 * where removing a cruise takes a cancellation by the line — a sailing should
 * not just disappear because the most recent scrape missed it.
 *
 * The evidence agrees: a line's search set churns between
 * runs. Celebrity Ascent 2027-04-19 was returned at 03:58, missing at 15:46,
 * and bookable the whole time at the same $2,419 — the cutoff would have hidden
 * a live sailing the user had starred. The row never leaves the table; only a
 * cancellation removes a cruise from the world.
 *
 * Age is now DISCLOSED instead of acted on: each row carries `lastSeen`, and a
 * card whose price has not been re-observed recently says so. Showing a price
 * with its date is honest; hiding the sailing is not.
 */
export async function getSailingIndex(): Promise<SailingIndex> {
  const supabase = await createClient();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TZ }).format(new Date());

  const enc = new SailingEncoder();
  let truncated = false;

  // One photo per SHIP (79 rows), fetched once and handed to the encoder before
  // any sailing is added. Cards used to show the sailing's own
  // `hero_image_url`, which is the line's ITINERARY art — a Caribbean sailing
  // got a stock shot of Santorini — useless as a picture of the cruise.
  // Populated by bin/cruise-ship-photos.
  const photos = new Map<string, string>();
  {
    const { data } = await supabase
      .from("cruise_ship_photos")
      .select("ship_name,photo_url")
      .not("photo_url", "is", null);
    for (const r of (data ?? []) as { ship_name: string; photo_url: string }[]) {
      if (r.ship_name && r.photo_url) photos.set(r.ship_name.toLowerCase(), r.photo_url);
    }
  }
  enc.setShipPhotos(photos);

  // Cruise Critic member ratings, also per ship. The one quality signal the
  // lines' own APIs will never carry. Populated by bin/cruise-ship-ratings.
  const ratings = new Map<string, [number, number | null]>();
  {
    const { data } = await supabase
      .from("cruise_ship_ratings")
      .select("ship_name,rating,review_count")
      .not("rating", "is", null);
    for (const r of (data ?? []) as { ship_name: string; rating: number; review_count: number | null }[]) {
      if (r.ship_name && r.rating != null) {
        ratings.set(r.ship_name.toLowerCase(), [Number(r.rating), r.review_count ?? null]);
      }
    }
  }
  enc.setShipRatings(ratings);

  // Only inventory the lines are still returning — see STALE_HOURS.

  // PostgREST hard-caps a response at 1000 rows, so page until short.
  for (let offset = 0; offset < MAX_ROWS; offset += SUPABASE_PAGE) {
    const { data, error } = await supabase
      .from("cruise_sailings")
      .select(SAILING_COLUMNS.join(","))
      .gte("depart_date", today)
      .not("lowest_balcony_per_person_usd", "is", null)
      .order("depart_date", { ascending: true })
      .order("sailing_id", { ascending: true })
      .range(offset, offset + SUPABASE_PAGE - 1);

    if (error) break;
    // supabase-js types a string-literal select as GenericStringError[]; the
    // runtime value is rows, so go through unknown rather than fight it.
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const r of page) enc.add(r);

    if (page.length < SUPABASE_PAGE) break;
    if (enc.rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
  }

  return enc.finish(truncated);
}


/**
 * The sailing ids this user has starred. Read with their own JWT, so RLS on
 * `cruise_favorites` returns their list and nobody else's.
 */
export async function getFavorites(): Promise<string[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("cruise_favorites").select("sailing_id");
  if (error) return [];
  return ((data ?? []) as { sailing_id: string }[]).map((r) => r.sailing_id);
}
