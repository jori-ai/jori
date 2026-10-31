"use client";

import { useState, useTransition } from "react";
import { submitBatch, type Mark } from "@/lib/actions";
import { poster } from "@/lib/types";
import type { Pick } from "@/lib/model";

/**
 * Five films at a time, each chosen by the model to answer a question about their taste
 * (lib/recsys.mjs designBatch). 👍 liked · sideways = seen it, meh · 👎 didn't want to see it
 * or didn't like it · left alone = not seen / no strong feeling (shown again later).
 * Posters only; tap one for the year, genres, synopsis and the question it's asking.
 */
export default function BatchMarker({ picks, labels }: { picks: Pick[]; labels: number }) {
  const [marks, setMarks] = useState<Record<number, Mark>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const toggle = (id: number, m: Exclude<Mark, null>) => setMarks((cur) => ({ ...cur, [id]: cur[id] === m ? null : m }));
  const next = () => start(async () => {
    setErr(null);
    try {
      await submitBatch(picks.map((x) => ({ id: x.film.id, tmdb_id: x.film.tmdb_id, slot: x.slot, p: x.p, u: x.u })), marks, labels);
      // revalidatePath in the action already streams back the re-rendered page with the next
      // five; a router.refresh() here re-fit the whole model a second time.
      setMarks({}); setOpen(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  });

  if (!picks.length) return <p className="empty">Nothing left to ask about right now.</p>;
  const btn = (id: number, m: Exclude<Mark, null>, label: string, cls: string) => (
    <button type="button" aria-label={label} title={label} aria-pressed={marks[id] === m}
      className={`thumb ${cls}${marks[id] === m ? " on" : ""}`} onClick={() => toggle(id, m)}><span>👍</span></button>
  );
  return (
    <div>
      <div className="five">
        {picks.map(({ film: f, why }) => {
          const img = poster(f.poster_path, "w342");
          const m = marks[f.id] ?? null;
          return (
            <article key={f.id} className={`tile${m ? ` marked-${m}` : ""}`}>
              <button type="button" className="tile-face" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}>
                {img ? <img className="tile-poster" src={img} alt={f.title} loading="lazy" /> : <div className="tile-poster none">🎬</div>}
                {open === f.id && (
                  <div className="tile-info">
                    <div className="tile-meta">{[f.year, f.genres].filter(Boolean).join(" · ")}</div>
                    {why && <div className="tile-why">{why}</div>}
                    {f.overview && <p>{f.overview}</p>}
                  </div>
                )}
              </button>
              <div className="tile-title">{f.title}</div>
              <div className="thumbs">
                {btn(f.id, "up", "Seen it, liked it", "up")}
                {btn(f.id, "meh", "Seen it, meh", "meh")}
                {btn(f.id, "down", "Didn't want to see it, or didn't like it", "down")}
              </div>
            </article>
          );
        })}
      </div>
      <div className="batch-footer">
        {err && <p className="error">{err}</p>}
        <button className="primary next" disabled={pending} onClick={next}>{pending ? "Learning…" : "Next 5"}</button>
      </div>
    </div>
  );
}
