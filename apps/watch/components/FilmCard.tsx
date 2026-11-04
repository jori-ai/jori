"use client";

import { useState, useTransition } from "react";
import RatePanel from "@/components/RatePanel";
import { markNotForUs, markNotSeen, saveSeen } from "@/lib/actions";
import { poster, type CatalogFilm } from "@/lib/types";

/** One film: "haven't seen" or "seen it" → how much each of them liked it. */
type Outcome = "seen" | "not_seen" | "not_for_us";

export default function FilmCard({ film, onDone }: { film: CatalogFilm; onDone: (id: number, what: Outcome) => void }) {
  const [rating, setRating] = useState(false);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const img = poster(film.poster_path);
  const run = (fn: () => Promise<void>, what: Outcome) =>
    start(async () => {
      setErr(null);
      try { await fn(); onDone(film.id, what); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    });

  return (
    <article className="card">
      {img ? <img className="poster" src={img} alt="" loading="lazy" /> : <div className="poster none">🎬</div>}
      <div className="body">
        <h3>{film.title} {film.year && <span className="year">{film.year}</span>}</h3>
        {film.genres && <div className="genres">{film.genres}</div>}
        {film.overview && <p className="overview">{film.overview}</p>}
        {film.seen === true && <div className="tag">Already marked as seen</div>}
        {film.seen === false && <div className="tag">{film.not_for_us ? "Marked as not our thing" : "Marked as not seen"}</div>}
        {rating ? (
          <RatePanel busy={pending} onCancel={() => setRating(false)} onSave={(r) => run(() => saveSeen(film.id, r), "seen")} />
        ) : (
          <div className="actions">
            <button className="ghost" disabled={pending} onClick={() => run(() => markNotSeen(film.id), "not_seen")}>Haven&apos;t seen</button>
            <button className="ghost" disabled={pending} title="Haven't seen it — the genre or category isn't for us" onClick={() => run(() => markNotForUs(film.id), "not_for_us")}>Not our thing</button>
            <button className="primary" disabled={pending} onClick={() => setRating(true)}>Seen it</button>
          </div>
        )}
        {err && <p className="error">{err}</p>}
      </div>
    </article>
  );
}
