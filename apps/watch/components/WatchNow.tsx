"use client";

import { useMemo, useState, useTransition } from "react";
import { markNotForUs, saveSeen } from "@/lib/actions";
import { everyone, poster, type WatchFilm } from "@/lib/types";

/**
 * What to watch, best predicted first, and where: in theaters, on a streaming service, free,
 * or to rent. Filter by where. Data: watch_catalog, refreshed daily by movie-db-refresh.
 */
export default function WatchNow({ films }: { films: WatchFilm[] }) {
  const [where, setWhere] = useState("all");
  const [gone, setGone] = useState<Set<number>>(new Set());
  const [pending, start] = useTransition();
  const services = useMemo(() => {
    const n = new Map<string, number>();
    for (const f of films) for (const s of f.providers?.stream || []) n.set(s, (n.get(s) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s]) => s);
  }, [films]);
  const theaters = films.filter((f) => f.in_theaters).length;
  const shown = films.filter((f) => !gone.has(f.id)).filter((f) =>
    where === "all" ? true
      : where === "theaters" ? f.in_theaters
      : where === "free" ? !!f.providers?.free.length
      : where === "rent" ? !!f.providers?.rent && !f.providers?.stream.length
      : !!f.providers?.stream.includes(where));
  const hide = (id: number, fn: () => Promise<unknown>) => { setGone((g) => new Set(g).add(id)); start(async () => { await fn(); }); };
  const chip = (id: string, label: string) => (
    <button key={id} type="button" className={`chip${where === id ? " on" : ""}`} onClick={() => setWhere(id)}>{label}</button>
  );
  return (
    <div>
      <div className="chips">
        {chip("all", "All")}
        {theaters > 0 && chip("theaters", `🎟️ In theaters`)}
        {services.map((s) => chip(s, s))}
        {chip("free", "Free")}
        {chip("rent", "Rent only")}
      </div>
      {!shown.length && <p className="empty">Nothing here right now.</p>}
      <ul className="watch-list">
        {shown.map((f) => {
          const img = poster(f.poster_path, "w154");
          const where = [
            f.in_theaters ? "🎟️ In theaters" : null,
            ...(f.providers?.stream || []),
            ...(f.providers?.free.length ? [`Free: ${f.providers.free.slice(0, 2).join(", ")}`] : []),
            !f.in_theaters && !f.providers?.stream.length && f.providers?.rent ? "Rent / buy" : null,
          ].filter(Boolean) as string[];
          return (
            <li key={f.id} className="watch-row">
              {img ? <img src={img} alt="" loading="lazy" /> : <div className="thumb none">🎬</div>}
              <div className="watch-body">
                <div className="rated-title">
                  {f.imdb_id ? <a href={`https://www.imdb.com/title/${f.imdb_id}/`} target="_blank" rel="noreferrer">{f.title}</a> : f.title}
                  {f.year && <span className="year"> {f.year}</span>}
                </div>
                <div className="watch-meta">
                  <span className="match" title="How likely you are to like it">{Math.min(99, Math.round((f.model_p || 0) * 100))}% match</span>
                  {f.imdb_rating && <span>IMDb {f.imdb_rating}</span>}
                  {f.genres && <span>{f.genres.split(", ").slice(0, 2).join(", ")}</span>}
                </div>
                <div className="where">{where.length ? where.map((w) => <span key={w} className="badge">{w}</span>) : <span className="muted">Not available in the US yet</span>}</div>
                <div className="watch-actions">
                  <button className="link" disabled={pending} onClick={() => hide(f.id, () => saveSeen(f.id, everyone("liked")))}>Seen it 👍</button>
                  <button className="link" disabled={pending} onClick={() => hide(f.id, () => markNotForUs(f.id))}>Not for us 👎</button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
