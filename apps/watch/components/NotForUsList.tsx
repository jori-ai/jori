"use client";

import { useTransition } from "react";
import { unmark } from "@/lib/actions";
import { poster, type CatalogFilm } from "@/lib/types";

function Row({ f }: { f: CatalogFilm }) {
  const [pending, start] = useTransition();
  const img = poster(f.poster_path, "w154");
  return (
    <li className="rated">
      {img ? <img src={img} alt="" loading="lazy" /> : <div className="thumb none">🎬</div>}
      <div className="rated-body">
        <div className="rated-title">{f.title} {f.year && <span className="year">{f.year}</span>}</div>
        {f.genres && <div className="genres">{f.genres}</div>}
        <div className="rated-who">
          <button className="link" disabled={pending} onClick={() => start(() => unmark(f.id))}>Undo</button>
        </div>
      </div>
    </li>
  );
}

export default function NotForUsList({ films }: { films: CatalogFilm[] }) {
  if (!films.length) return <p className="empty">Nothing marked as not your thing yet.</p>;
  return <ul className="rated-list">{films.map((f) => <Row key={f.id} f={f} />)}</ul>;
}
