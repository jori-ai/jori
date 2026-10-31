"use client";

import { useState, useTransition, useRef, useCallback, useMemo, useEffect } from "react";
import dynamic from "next/dynamic";
import { setEntryState } from "@/app/reservoir/actions";
import { visible, type ReservoirEntry, type ReservoirStructured } from "@/lib/reservoir-entry";
import { EntryBody, SECTIONS, entryKey, Star, SeqBadge } from "./EntryBody";
import { pinsFrom, type Pin } from "./ReservoirMap";

// Renders an area guide from the structured reservoir, with a done/undone button
// on every entry, plus the map above it. Mirrors lib/reservoir-render.js's
// markup and class names (that renderer still produces `area_html` for the wiki
// mirror) — but this one has to be React, because a baked HTML blob can't carry
// per-entry buttons or a map.

// Leaflet touches `window` at import time, so the map must not render on the
// server.
const ReservoirMap = dynamic(() => import("./ReservoirMap"), {
  ssr: false,
  loading: () => <div className="res-map-wrap res-map-loading" />,
});

type EntryState = "open" | "done" | "skipped";
type View = "type" | "cluster";

// Done / Skip pills. Overlaid on the bottom-right corner of the photo when
// there is one, otherwise shown inline. Each pill toggles its own
// state on/off; Done and Skip are mutually exclusive (setting one clears the
// other, since both resolve to a single `state`).
function Pills({
  state, pending, disabled, onSet,
}: {
  state: EntryState; pending: boolean; disabled: boolean;
  onSet: (s: EntryState) => void;
}) {
  const done = state === "done";
  const skipped = state === "skipped";
  return (
    <div className="res-pills">
      <button
        type="button"
        className={`res-pill-btn res-pill-done${done ? " on" : ""}`}
        disabled={pending || disabled}
        aria-pressed={done}
        title={done ? "Mark as not done" : "Mark as done"}
        onClick={() => onSet(done ? "open" : "done")}
      >
        {done ? "✓ Done" : "Mark done"}
      </button>
      <button
        type="button"
        className={`res-pill-btn res-pill-skip${skipped ? " on" : ""}`}
        disabled={pending || disabled}
        aria-pressed={skipped}
        title={skipped ? "Un-skip" : "Skip — not somewhere we want to go"}
        onClick={() => onSet(skipped ? "open" : "skipped")}
      >
        {skipped ? "✕ Skipped" : "Skip"}
      </button>
    </div>
  );
}

function Entry({
  bucket, entry, onSet, onSelect, pending, active, showBucket,
}: {
  bucket: string; entry: ReservoirEntry;
  onSet: (key: string, state: EntryState) => void; pending: boolean;
  onSelect: (key: string) => void;
  active: boolean;
  showBucket?: string;
}) {
  const state: EntryState = entry.state === "done" ? "done" : entry.state === "skipped" ? "skipped" : "open";
  const done = state === "done";
  const skipped = state === "skipped";
  const key = entryKey(entry);

  const stateClass = done ? " res-done" : skipped ? " res-skipped" : "";
  const pills = <Pills state={state} pending={pending} disabled={!key} onSet={(s) => onSet(key, s)} />;

  // The list half of the two-way link: tapping a row selects its map pin.
  // Clicks that land on a control (Done/Skip, the Maps link) are that control's
  // — selecting on the way past would fight them.
  const onClick = (e: React.MouseEvent<HTMLLIElement>) => {
    if ((e.target as HTMLElement).closest("button, a")) return;
    if (key) onSelect(key);
  };

  return (
    <li
      id={entry.seq ? `res-${entry.seq}` : undefined}
      className={`res-item${stateClass}${active ? " res-active" : ""}`}
      onClick={onClick}
    >
      <div className="res-main">
        <div className="res-item-head">
          <SeqBadge seq={entry.seq} />
          {/* In cluster view the Must-see section header is gone, so the star
              is how a must-see reads — and the bucket becomes a chip. */}
          {showBucket && <span className="res-typechip">{showBucket}</span>}
        </div>
        {entry.photo_url ? (
          <div className="res-photo-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="res-photo" src={entry.photo_url} alt="" loading="lazy" />
            {done && (
              // res-photo-badge already styles this (green bg, white text). Do
              // NOT also add res-donebadge — its green text would win over the
              // white here (equal specificity, defined later) and render the
              // label invisible: an empty green pill (2026-07-18).
              <span className="res-photo-badge" title={entry.done_evidence || ""}>
                ✓ been{entry.done_date ? ` ${entry.done_date}` : ""}
              </span>
            )}
            {pills}
          </div>
        ) : null}
        <EntryBody bucket={bucket} entry={entry} />
        {/* No photo to overlay on — show the pills inline under the entry. */}
        {!entry.photo_url && <div className="res-pills-inline">{pills}</div>}
      </div>
    </li>
  );
}

const BUCKET_LABEL: Record<string, string> = Object.fromEntries(SECTIONS);

// The breakpoint at which the guide splits into two vertical panes — map on one
// side, list on the other. It MUST match the `min-width` in globals.css
// (`.res-split`), because the layout decides the interaction: with the list
// beside the map a pin tap scrolls the list, and without it a pin tap opens a
// bottom sheet instead.
const WIDE = "(min-width: 1024px)";

function useWideLayout() {
  // Starts false so the server-rendered markup (which has no window) and the
  // first client paint agree; the effect corrects it before anything is tapped.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide;
}

export default function ReservoirList({ structured }: { structured: ReservoirStructured }) {
  // Local copy so a click reflects immediately; the server action revalidates.
  const [data, setData] = useState(structured);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("type");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const wide = useWideLayout();

  const onSet = (key: string, state: EntryState) => {
    setError(null);
    setPendingKey(key);
    // Optimistic: flip locally, roll back if the write fails.
    const next = structuredClone(data);
    for (const arr of Object.values(next.buckets || {})) {
      if (!Array.isArray(arr)) continue;
      for (const e of arr) {
        if (entryKey(e) === key) {
          e.state = state;
          e.manual = true;
          e.done_date = state === "done" ? new Date().toISOString().slice(0, 10) : null;
          e.done_evidence = state === "done" ? "marked done on the site" : undefined;
        }
      }
    }
    setData(next);
    startTransition(async () => {
      const res = await setEntryState(data.area, key, state);
      if (!res?.ok) {
        setData(data); // roll back
        setError(res?.error || "could not save");
      }
      setPendingKey(null);
    });
  };

  // Duplicates stay in the data (pass 2 is non-destructive) but never render.
  const groups = useMemo(
    () => SECTIONS.map(([bucket]) => ({ bucket, entries: visible((data.buckets || {})[bucket]) })),
    [data],
  );
  const pins: Pin[] = useMemo(() => pinsFrom(groups), [groups]);

  const shown = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  const doneCount = shown.filter((e) => e.state === "done").length;
  const skippedCount = shown.filter((e) => e.state === "skipped").length;

  // Map pin -> list row. Scrolls and flashes, so the eye lands on the right one
  // in a list of 80.
  const listRef = useRef<HTMLDivElement | null>(null);
  const showInList = useCallback((key: string) => {
    const entry = shown.find((e) => entryKey(e) === key);
    if (!entry?.seq) return;
    setSheetKey(null); // jumping to the list is also how the sheet is dismissed
    setActiveKey(key);
    // rAF so the row is on screen before the scroll starts — on the narrow
    // layout the sheet it replaces was covering part of the page.
    requestAnimationFrame(() => {
      document.getElementById(`res-${entry.seq}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    setFlashKey(key);
  }, [shown]);

  // Tapping a pin, on either layout. Wide: the list pane is right there, so
  // scroll it to the entry — that IS the detail view, no card needed. Narrow:
  // the list is far below, so open the bottom sheet.
  const onPinClick = useCallback((key: string) => {
    if (wide) { showInList(key); return; }
    setActiveKey(key);
    setSheetKey(key);
  }, [wide, showInList]);

  // Tapping a list row selects its pin (highlight + pan). It never opens the
  // sheet — the row it would describe is the one under the finger.
  const onSelectRow = useCallback((key: string) => {
    setActiveKey((cur) => (cur === key ? null : key));
  }, []);

  const closeSheet = useCallback(() => setSheetKey(null), []);

  // Crossing the breakpoint with a sheet open would leave it stranded over a
  // layout that has no use for it.
  useEffect(() => { if (wide) setSheetKey(null); }, [wide]);

  useEffect(() => {
    if (!flashKey) return;
    const t = setTimeout(() => setFlashKey(null), 1600);
    return () => clearTimeout(t);
  }, [flashKey]);

  // Cluster view: group by the cluster pass 3 assigned, ordered the way the
  // clusters array already is (biggest / most must-sees first), with the
  // coordinate-less entries last rather than dropped.
  const clusterGroups = useMemo(() => {
    const byId = new Map<string, { label: string; mode: string; km: number; items: { bucket: string; entry: ReservoirEntry }[] }>();
    const unplaced: { bucket: string; entry: ReservoirEntry }[] = [];
    for (const { bucket, entries } of groups) {
      for (const entry of entries) {
        const c = entry.cluster;
        if (!c) { unplaced.push({ bucket, entry }); continue; }
        if (!byId.has(c.id)) byId.set(c.id, { label: c.label, mode: c.mode, km: c.km_from_center, items: [] });
        byId.get(c.id)!.items.push({ bucket, entry });
      }
    }
    const order = (data.clusters || []).map((c) => c.id);
    const ids = [...byId.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
    });
    return { ids, byId, unplaced };
  }, [groups, data.clusters]);

  // `activeKey` is the one selection both halves read, so the binding is
  // symmetric: a pin tap highlights its row and a row tap highlights its pin.
  const entryProps = (bucket: string, entry: ReservoirEntry, withChip: boolean) => ({
    bucket,
    entry,
    onSet,
    onSelect: onSelectRow,
    pending: pendingKey === entryKey(entry),
    active: activeKey === entryKey(entry) || flashKey === entryKey(entry),
    showBucket: withChip ? BUCKET_LABEL[bucket] : undefined,
  });

  const hasMap = pins.length > 0;

  return (
    // res-split turns into two vertical panes at the WIDE breakpoint (map
    // sticky on the left, list scrolling on the right) and stays a single
    // stacked column below it. Without a map there is nothing to split.
    <div className={`res${hasMap ? " res-split" : ""}`} ref={listRef}>
      {hasMap && (
        <div className="res-pane-map">
          <ReservoirMap
            pins={pins}
            center={data.lat != null && data.lon != null ? { lat: data.lat, lon: data.lon } : null}
            activeKey={activeKey}
            sheetKey={wide ? null : sheetKey}
            onPinClick={onPinClick}
            onCloseSheet={closeSheet}
            onShowInList={showInList}
          />
        </div>
      )}

      <div className="res-pane-list">
        {error && <div className="res-error">⚠ {error}</div>}

        <div className="res-toolbar">
          <div className="res-progress">
            {doneCount} of {shown.length} done{skippedCount ? ` · ${skippedCount} skipped` : ""}
          </div>
          <div className="res-viewtoggle" role="group" aria-label="Group entries by">
            <button
              type="button" className={view === "type" ? "on" : ""}
              aria-pressed={view === "type"} onClick={() => setView("type")}
            >
              By type
            </button>
            <button
              type="button" className={view === "cluster" ? "on" : ""}
              aria-pressed={view === "cluster"} onClick={() => setView("cluster")}
            >
              By cluster
            </button>
          </div>
        </div>

        {view === "type"
          ? groups.map(({ bucket, entries }) => {
              if (!entries.length) return null;
              return (
                <section key={bucket}>
                  <h2>{BUCKET_LABEL[bucket]}</h2>
                  <ul>
                    {entries.map((entry, i) => (
                      <Entry key={entryKey(entry) || i} {...entryProps(bucket, entry, false)} />
                    ))}
                  </ul>
                </section>
              );
            })
          : (
            <>
              {clusterGroups.ids.map((id) => {
                const g = clusterGroups.byId.get(id)!;
                const how = g.mode === "walk" ? "walkable" : `drive ${g.km}km`;
                return (
                  <section key={id}>
                    <h2>
                      {g.label}{" "}
                      <span className={`res-cluster res-cluster-${g.mode}`}>{how} · {g.items.length} stops</span>
                    </h2>
                    <ul>
                      {g.items.map(({ bucket, entry }, i) => (
                        <Entry key={entryKey(entry) || i} {...entryProps(bucket, entry, true)} />
                      ))}
                    </ul>
                  </section>
                );
              })}
              {clusterGroups.unplaced.length > 0 && (
                <section key="unplaced">
                  <h2>
                    Unplaced{" "}
                    <span className="res-cluster">no fixed location · {clusterGroups.unplaced.length}</span>
                  </h2>
                  <ul>
                    {clusterGroups.unplaced.map(({ bucket, entry }, i) => (
                      <Entry key={entryKey(entry) || i} {...entryProps(bucket, entry, true)} />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
      </div>
    </div>
  );
}
