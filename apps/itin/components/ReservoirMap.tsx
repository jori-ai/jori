"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as LMap, Marker as LMarker } from "leaflet";
// Leaflet's own stylesheet — tile positioning breaks without it. Safe to import
// here: this component is dynamically loaded with ssr:false.
import "leaflet/dist/leaflet.css";
import type { ReservoirEntry } from "@/lib/reservoir-entry";
import { EntryBody, entryKey, entryTitle } from "./EntryBody";

// The area map. Raw Leaflet driven from an effect rather than react-leaflet —
// one dependency instead of two, and no React-19 peer-range friction for what
// is ultimately "put markers on tiles".
//
// Selection is CLICK-driven, never hover. What a click
// does depends on the layout, because the two layouts have different room:
//   • wide (two panes): tapping a pin selects it and the LIST pane — sitting
//     right there — scrolls to that entry and highlights it. No floating card:
//     the full entry is already on screen, so a card would only cover the map.
//   • narrow (one column): the list is far below the map, so tapping a pin
//     opens a bottom sheet with the entry, plus a "Show in list" jump.
// Either way the sheet/selection is reused React (EntryBody), so the map and
// the list can't drift apart.

export type Pin = {
  key: string;
  seq: number;
  lat: number;
  lon: number;
  bucket: string;
  entry: ReservoirEntry;
  /** Other entries at this same venue — a dish AND the sight it's inside. */
  also: { bucket: string; entry: ReservoirEntry }[];
};

const FOOD_BUCKETS = new Set(["food_specialties"]);

/** Build one pin per VENUE. Entries sharing `same_venue_as` (pass 2 links a
 *  dish to the sight it sits inside) collapse into a single pin, or the map
 *  stacks two markers on identical coordinates and the top one hides the
 *  other.
 *
 *  SKIPPED entries get no pin. Skip means "not somewhere
 *  we want to go", so it is noise on a map whose job is to show where to go —
 *  and it crowds out the pins that matter and widens the fitted view. It stays
 *  in the LIST, struck through, because that is where un-skipping happens; the
 *  moment it is un-skipped its pin comes back. Done entries DO keep their pin
 *  (greyed): a place you've been is still part of where you are. */
export function pinsFrom(
  groups: { bucket: string; entries: ReservoirEntry[] }[],
): Pin[] {
  const byVenue = new Map<string, Pin>();
  const out: Pin[] = [];
  for (const { bucket, entries } of groups) {
    for (const entry of entries) {
      if (entry.state === "skipped") continue;
      if (entry.lat == null || entry.lon == null) continue;
      if (!entry.seq) continue;
      const venue = entry.same_venue_as;
      if (venue && byVenue.has(venue)) {
        byVenue.get(venue)!.also.push({ bucket, entry });
        continue;
      }
      const pin: Pin = {
        key: entryKey(entry), seq: entry.seq, lat: entry.lat, lon: entry.lon,
        bucket, entry, also: [],
      };
      if (venue) byVenue.set(venue, pin);
      out.push(pin);
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function iconHtml(pin: Pin): string {
  const food = FOOD_BUCKETS.has(pin.bucket);
  const must = pin.bucket === "must_see";
  const done = pin.entry.state === "done";
  const cls = [
    "res-pin",
    food ? "res-pin-food" : "res-pin-sight",
    must ? "res-pin-must" : "",
    done ? "res-pin-done" : "",
  ].filter(Boolean).join(" ");
  // The star sits OUTSIDE the numbered disc so it never obscures the number —
  // the number is the whole point of the pin.
  return `<span class="${cls}"><span class="res-pin-n">${pin.seq}</span>${
    must ? '<span class="res-pin-star">★</span>' : ""
  }</span>`;
}

export default function ReservoirMap({
  pins, center, activeKey, sheetKey, onPinClick, onCloseSheet, onShowInList,
}: {
  pins: Pin[];
  center: { lat: number; lon: number } | null;
  /** Highlighted in both directions — set by a pin tap OR a list-row tap. */
  activeKey: string | null;
  /** Non-null only on the narrow layout: the entry the bottom sheet shows. */
  sheetKey: string | null;
  onPinClick: (key: string) => void;
  onCloseSheet: () => void;
  onShowInList: (key: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LMap | null>(null);
  const markersRef = useRef<Map<string, LMarker>>(new Map());
  const [ready, setReady] = useState(false);

  const active = pins.find((p) => p.key === activeKey) || null;
  const sheet = pins.find((p) => p.key === sheetKey) || null;

  // Markers are rebuilt asynchronously (Leaflet is a dynamic import), so the
  // build has to know the current selection at the moment it finishes rather
  // than the value captured when the effect was scheduled.
  const activeRef = useRef(activeKey);
  activeRef.current = activeKey;
  /** key -> place name, for the callout on the selected pin. */
  const titlesRef = useRef<Map<string, string>>(new Map());
  const clickRef = useRef(onPinClick);
  clickRef.current = onPinClick;

  // Framing state. `boundsRef` is every pin, so the view can be re-fitted at
  // any time; `userMovedRef` records that the reader took over (they dragged or
  // zoomed), after which we stop re-framing under them; `programmaticRef` marks
  // our own fitBounds so it isn't mistaken for that.
  const boundsRef = useRef<[number, number][]>([]);
  const userMovedRef = useRef(false);
  const programmaticRef = useRef(false);

  /** Frame every pin. The guide's whole promise is "here is the area" — a view
   *  that cuts pins off is showing a different area than the list below it. */
  const fitAll = useCallback(async () => {
    const map = mapRef.current;
    if (!map || boundsRef.current.length === 0) return;
    const L = (await import("leaflet")).default;
    programmaticRef.current = true;
    // Re-measure FIRST, always. Leaflet caches the container size from
    // construction, and the pane is still settling then (the sticky two-pane
    // grid lays out after the map is built, and the dynamic-import placeholder
    // it replaces is a different box). Fitting against that stale, wider size
    // computes a zoom one step too coarse — the pins end up in a clump in the
    // corner, which is exactly what this looked like. The ResizeObserver
    // couldn't rescue it either: its first callback fires before the marker
    // effect has filled boundsRef, so it returned early and never re-fired.
    map.invalidateSize();
    map.fitBounds(L.latLngBounds(boundsRef.current), {
      // Even padding in PIXELS, not a ratio: the two panes make the map wide
      // and short, and .pad() scales with each side, so a ratio over-pads the
      // long axis and lets the short one clip.
      padding: [28, 28],
      maxZoom: 15,
      animate: false,
    });
    programmaticRef.current = false;
  }, []);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !hostRef.current || mapRef.current) return;
      const map = L.map(hostRef.current, {
        center: [center?.lat ?? 0, center?.lon ?? 0],
        zoom: 13,
        scrollWheelZoom: false, // never hijack the page scroll on the way past
        attributionControl: true,
        // Fractional zoom. With Leaflet's default zoomSnap:1, fitBounds can
        // only pick a whole zoom level, so it takes the largest one that still
        // CONTAINS the pins — and since each level is 2x, "contains" can mean
        // the pins fill barely half the pane while the rest is empty country.
        // That is what "the tags aren't zoomed to the map" was: the fit was
        // running correctly and still looked wrong. zoomSnap:0 lets it land on
        // the exact zoom that frames them.
        zoomSnap: 0,
        // The +/- buttons stay on whole steps; only the fit is fractional.
        zoomDelta: 1,
      });
      // OSM's own tiles, keyless. CARTO's free basemaps started serving an
      // "API KEY REQUIRED" watermark on every tile (2026-10), which blanked the map.
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);
      // Once the reader has framed the map themselves, stop re-framing it for
      // them. `zoomstart` also fires for our own fitBounds, hence the guard.
      map.on("dragstart", () => { userMovedRef.current = true; });
      map.on("zoomstart", () => { if (!programmaticRef.current) userMovedRef.current = true; });
      mapRef.current = map;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // center is only the INITIAL view; re-running on it would fight the user's panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The map pane changes size when the layout crosses the two-pane breakpoint
  // (and it is height:100% of a sticky pane, so it also moves with the window).
  // Leaflet caches the container size, so without this the tiles render for the
  // old box and the pins land in the wrong place — and a resize keeps the old
  // centre/zoom, which on a newly taller-and-narrower pane cuts pins off, so
  // re-fit as well. That is also what makes the FIRST fit reliable: the pane is
  // laid out after the map is constructed, so the initial fitBounds is computed
  // against a stale box and this is the pass that corrects it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready) return;
    const ro = new ResizeObserver(() => {
      mapRef.current?.invalidateSize();
      if (!userMovedRef.current) fitAll();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [ready, fitAll]);

  // (Re)build markers whenever the pin set changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled) return;
      for (const m of markersRef.current.values()) m.remove();
      markersRef.current.clear();
      for (const pin of pins) {
        const marker = L.marker([pin.lat, pin.lon], {
          icon: L.divIcon({ html: iconHtml(pin), className: "res-pin-wrap", iconSize: [28, 28], iconAnchor: [14, 14] }),
          keyboard: false,
          title: entryTitle(pin.entry),
        }).addTo(map);
        marker.on("click", () => clickRef.current(pin.key));
        markersRef.current.set(pin.key, marker);
      }
      titlesRef.current = new Map(pins.map((p) => [p.key, entryTitle(p.entry)]));
      // The selection survives a rebuild (a Done/Skip click re-renders the
      // pins), so re-apply it to the fresh marker elements.
      applySelection(markersRef.current, titlesRef.current, activeRef.current);
      // Frame everything, so an area whose places sprawl 50km doesn't open
      // zoomed into an empty field — and so a pin never sits outside the view
      // of the list it belongs to.
      boundsRef.current = pins.map((p) => [p.lat, p.lon] as [number, number]);
      if (!userMovedRef.current) await fitAll();
    })();
    return () => { cancelled = true; };
  }, [pins, ready, fitAll]);

  // Highlight the selected pin — the map half of the two-way link.
  useEffect(() => {
    applySelection(markersRef.current, titlesRef.current, activeKey);
  }, [activeKey]);

  // Pan a selected entry into view when the selection came from the list.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !active) return;
    if (!map.getBounds().contains([active.lat, active.lon])) {
      map.panTo([active.lat, active.lon], { animate: true });
    }
  }, [active]);

  // Escape closes the sheet — it covers the map, so there has to be a way out
  // that isn't hunting for the button.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseSheet(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, onCloseSheet]);

  return (
    <div className="res-map-wrap">
      <div className="res-map" ref={hostRef} />
      <div className="res-map-legend">
        <span><span className="res-pin res-pin-sight res-legend-pin" /> place</span>
        <span><span className="res-pin res-pin-food res-legend-pin" /> food</span>
        <span><span className="res-star">★</span> must-see</span>
      </div>

      {sheet && (
        <>
          <div className="res-sheet-backdrop" onClick={onCloseSheet} />
          <div className="res-sheet" role="dialog" aria-modal="true" aria-label={entryTitle(sheet.entry)}>
            <button
              type="button"
              className="res-sheet-grab"
              aria-label="Close"
              onClick={onCloseSheet}
            />
            {sheet.entry.photo_url && (
              // Only mounted while the sheet is open, so a 40-pin area doesn't
              // pull 40 photos on load — this page gets used on hotel wifi.
              // eslint-disable-next-line @next/next/no-img-element
              <img className="res-card-photo" src={sheet.entry.photo_url} alt="" loading="lazy" />
            )}
            <div className="res-card-body">
              <div className="res-card-seq">{sheet.seq}</div>
              <EntryBody bucket={sheet.bucket} entry={sheet.entry} compact />
              {sheet.also.map(({ bucket, entry }) => (
                <div className="res-card-also" key={entryKey(entry)}>
                  <div className="res-card-also-label">also here</div>
                  <EntryBody bucket={bucket} entry={entry} compact />
                </div>
              ))}
              <div className="res-card-actions">
                <button type="button" className="res-card-btn" onClick={() => onShowInList(sheet.key)}>
                  Show in list
                </button>
                <button type="button" className="res-card-btn res-card-close" onClick={onCloseSheet}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Show which pin is selected. Done by hand on the existing markers rather than
 *  by re-issuing divIcons, so selecting doesn't tear down and rebuild every
 *  marker on the map. Three things, because in a dense cluster the first alone
 *  is invisible (a pin hidden behind others isn't visible):
 *   1. the disc is scaled and ringed;
 *   2. the MARKER is lifted to the front. The old code put `z-index` on the
 *      inner disc, which does nothing — Leaflet stacks the marker elements
 *      themselves, ordered by latitude, so a selected pin stayed buried under
 *      whatever sits north of it. `setZIndexOffset` is the stacking that
 *      actually applies;
 *   3. a callout naming the place points down at it, so the answer to "which
 *      one is it" doesn't depend on spotting a 26px disc in a pile of them. */
function applySelection(
  markers: Map<string, LMarker>,
  titles: Map<string, string>,
  activeKey: string | null,
) {
  for (const [key, marker] of markers) {
    const on = key === activeKey;
    marker.getElement()?.querySelector(".res-pin")?.classList.toggle("res-pin-active", on);
    marker.setZIndexOffset(on ? 1000 : 0);
    if (!on) {
      marker.unbindTooltip();
      // NOT isTooltipOpen(): Leaflet implements it as `this._tooltip.isOpen()`
      // with no guard, so it THROWS on any marker that has never had one bound
      // — which is every marker on first selection. The TS types don't say so.
      // getTooltip() returns undefined instead, and since binding always opens
      // and deselecting always unbinds, "has one" is the same question.
    } else if (!marker.getTooltip()) {
      // Leaflet renders tooltip content as HTML, and these names come from
      // research output, so escape them.
      marker
        .bindTooltip(esc(titles.get(key) || ""), {
          permanent: true,
          direction: "top",
          offset: [0, -16],
          className: "res-callout",
          opacity: 1,
        })
        .openTooltip();
    }
  }
}
