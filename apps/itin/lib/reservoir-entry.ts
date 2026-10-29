// The shape of a reservoir entry, and the helpers that operate on one.
//
// This is deliberately SEPARATE from lib/reservoirs.ts: that module imports the
// server-only Supabase client (next/headers), so a client component importing a
// value from it drags the server client into the browser bundle and the build
// fails. Types alone are erased and would have been fine; `visible` is a real
// runtime value, and that is what broke it. Anything the client needs at
// runtime goes here.

export type ReservoirEntry = {
  id?: string;
  name?: string;
  // food_specialties are a dish, not a place: `dish` + `best_place`, no `name`.
  // A food entry is either a DISH (a food, eaten at `best_place`) or a TABLE
  // (a restaurant worth eating at for itself). `kind` says which; a table has
  // no `dish` and carries its style in `known_for`.
  kind?: "dish" | "table";
  dish?: string;
  known_for?: string;
  best_place?: string;
  why?: string;
  food_hook?: string;
  address?: string;
  mapsUri?: string;
  photo_url?: string;
  rating?: number | string | null;
  dog_ok?: boolean;
  window?: string;
  hours?: string;
  date?: string;
  days?: string[] | string;
  source_url?: string;
  iconic_detour?: boolean;
  // Coordinates have always been stamped on every verified entry by
  // trip-reservoir-build; they were just missing from this type. Optional
  // because an unverified unique_experience with no fixed location is pushed
  // without them on purpose — those get no map pin.
  lat?: number;
  lon?: number;
  // Assigned by pass 3 (lib/reservoir-cluster.js) over the SAME section
  // order this file renders, so the list number, the map pin number and the
  // wiki renderer can't drift into three different numberings.
  seq?: number;
  cluster?: { id: string; label: string; mode: "walk" | "drive"; km_from_center: number } | null;
  // Set by pass 2 on the losing half of a duplicate. Never rendered.
  dup_of?: string;
  dup_reason?: string;
  // Two entries at one venue (a dish AND the sight) share this key so the map
  // draws one pin instead of two on identical coordinates.
  same_venue_as?: string;
  state?: "open" | "done" | "skipped" | "duplicate";
  skip_reason?: string;
  felt?: string;
  // `manual: true` = set by hand on the site; the nightly sweep won't override it.
  manual?: boolean;
  done_at?: string;
  done_date?: string | null;
  done_evidence?: string;
  done_source?: string;
};

export type ReservoirCluster = {
  id: string;
  label: string;
  mode: "walk" | "drive";
  size: number;
  km_from_center: number;
  lat: number;
  lon: number;
};

export type ReservoirStructured = {
  area: string;
  label: string;
  // The area centre — the map's initial view when no entry is selected.
  lat?: number;
  lon?: number;
  date_range?: { start: string; end: string } | null;
  buckets: Record<string, ReservoirEntry[]>;
  dont_miss?: string[];
  clusters?: ReservoirCluster[];
};

/** Entries the UI should render. Pass 2 keeps duplicates in the data (so a
 *  rebuild can still carry their done marks forward, and a wrong merge is
 *  recoverable) but they must never reach the list or the map. */
export function visible(entries: ReservoirEntry[] | undefined): ReservoirEntry[] {
  return (entries ?? []).filter((e) => e && e.state !== "duplicate");
}
