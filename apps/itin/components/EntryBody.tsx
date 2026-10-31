"use client";

import type { ReservoirEntry } from "@/lib/reservoir-entry";

// The content of one entry — name/dish, why, badges, address — shared by the
// list row and the map pin card. It lives in its own file precisely because
// this pipeline's recurring failure is the same content rendered in two places
// and quietly drifting apart (see the note atop lib/reservoirs.ts about the
// third copy, lib/reservoir-render.js).

export const SECTIONS: [string, string][] = [
  ["must_see", "Must-see"],
  ["optional", "Local gems"],
  ["food_specialties", "Food specialties"],
  ["unique_experiences", "Unique experiences"],
  ["time_sensitive", "Time-sensitive events"],
];

export function entryKey(e: ReservoirEntry): string {
  return e.id || e.name || e.dish || e.best_place || "";
}

/** The one-line title of an entry, whatever bucket it's in. */
export function entryTitle(e: ReservoirEntry): string {
  return e.dish || e.name || e.best_place || "";
}

export function NameLink({ name, uri }: { name?: string; uri?: string }) {
  if (!name) return null;
  return uri ? (
    <a href={uri} target="_blank" rel="noopener noreferrer">{name}</a>
  ) : (
    <>{name}</>
  );
}

/** Yellow star on must-sees. Rendered in the list AND on the map pin, so a
 *  must-see reads the same in both views. */
export function Star() {
  return <span className="res-star" title="Must-see" aria-label="Must-see">★</span>;
}

/** "◍ Old town · walk" / "◍ Valley · drive 22km" */
export function ClusterChip({ entry }: { entry: ReservoirEntry }) {
  const c = entry.cluster;
  if (!c) return null;
  const how = c.mode === "walk" ? "walk" : `drive ${c.km_from_center}km`;
  return (
    <span className={`res-cluster res-cluster-${c.mode}`} title={`${c.label} — ${how} from the base`}>
      ◍ {c.label} · {how}
    </span>
  );
}

/** The number that ties a list row to its map pin. */
export function SeqBadge({ seq }: { seq?: number }) {
  if (!seq) return null;
  return <span className="res-seq">{seq}</span>;
}

/** Bucket-specific head + extras. `compact` trims the address line for the
 *  map card, where space is tight and the pin already says where it is. */
export function EntryBody({
  bucket, entry, compact = false,
}: {
  bucket: string; entry: ReservoirEntry; compact?: boolean;
}) {
  const rating = entry.rating ? <span className="res-rating">★ {entry.rating}</span> : null;
  const mustSee = bucket === "must_see";

  let head: React.ReactNode;
  let extra: React.ReactNode = null;

  if (bucket === "food_specialties") {
    // Two shapes here (schema split 2026-07-21). A "dish" entry is a food, so
    // the food is the headline and the venue is where to eat it. A "table" is a
    // restaurant recommended for itself — its name IS the headline, and what
    // it's loved for goes underneath. Before the split both were crammed into
    // `dish`, which is why restaurants were titled with a menu blurb.
    const isTable = entry.kind === "table" || !entry.dish;
    head = (
      <div className="res-name">
        {isTable ? <><NameLink name={entry.best_place} uri={entry.mapsUri} /> {rating}</> : entry.dish}
      </div>
    );
    extra = (
      <>
        {isTable
          ? entry.known_for && <div className="res-sub">known for {entry.known_for}</div>
          : entry.best_place && (
              <div className="res-sub">
                best at <NameLink name={entry.best_place} uri={entry.mapsUri} /> {rating}
              </div>
            )}
        {entry.iconic_detour && <div><span className="res-badge">worth a detour</span></div>}
      </>
    );
  } else if (bucket === "time_sensitive") {
    head = <div className="res-name"><NameLink name={entry.name} uri={entry.mapsUri} /> {rating}</div>;
    const when = [entry.date, Array.isArray(entry.days) ? entry.days.join("/") : entry.days, entry.hours]
      .filter(Boolean).join(" · ");
    extra = (
      <>
        {when && <div className="res-when">📅 {when}</div>}
        {entry.source_url && (
          <div className="res-src">
            <a href={entry.source_url} target="_blank" rel="noopener noreferrer">source ↗</a>
          </div>
        )}
      </>
    );
  } else if (bucket === "unique_experiences") {
    head = <div className="res-name"><NameLink name={entry.name} uri={entry.mapsUri} /> {rating}</div>;
    extra = entry.window ? <div className="res-when">🕐 {entry.window}</div> : null;
  } else {
    head = (
      <div className="res-name">
        {mustSee && <Star />}
        <NameLink name={entry.name} uri={entry.mapsUri} /> {rating}{" "}
        {entry.dog_ok && <span className="res-badge res-dog">🐾 dog-friendly</span>}
      </div>
    );
    extra = entry.food_hook ? <div className="res-hook">🍴 {entry.food_hook}</div> : null;
  }

  return (
    <>
      {head}
      {entry.why && <div className="res-why">{entry.why}</div>}
      {extra}
      <ClusterChip entry={entry} />
      {!compact && entry.address && <div className="res-addr">📍 {entry.address}</div>}
    </>
  );
}
