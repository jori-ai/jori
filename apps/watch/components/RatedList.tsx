"use client";

import { useState, useTransition } from "react";
import RatePanel from "@/components/RatePanel";
import { saveSeen, unmark } from "@/lib/actions";
import { PEOPLE, VERDICTS, poster, type RatedFilm } from "@/lib/types";

const label = (v?: string) => { const x = VERDICTS.find((y) => y.v === v); return x ? `${x.emoji} ${x.label}` : "not rated"; };

function Row({ f }: { f: RatedFilm }) {
  const [edit, setEdit] = useState(false);
  const [pending, start] = useTransition();
  const img = poster(f.poster_path, "w154");
  return (
    <li className="rated">
      {img ? <img src={img} alt="" loading="lazy" /> : <div className="thumb none">🎬</div>}
      <div className="rated-body">
        <div className="rated-title">{f.title} {f.year && <span className="year">{f.year}</span>}</div>
        {edit ? (
          <RatePanel initial={f.ratings} busy={pending} onCancel={() => setEdit(false)}
            onSave={(r) => start(async () => { await saveSeen(f.id, r); setEdit(false); })} />
        ) : (
          <div className="rated-who">
            {PEOPLE.map(({ p, name }) => <span key={p}><b>{name}:</b> {label(f.ratings[p])}</span>)}
            <button className="link" onClick={() => setEdit(true)}>Change</button>
            <button className="link" disabled={pending} onClick={() => start(() => unmark(f.id))}>Unmark</button>
          </div>
        )}
      </div>
    </li>
  );
}

export default function RatedList({ films }: { films: RatedFilm[] }) {
  if (!films.length) return <p className="empty">Nothing marked as seen yet.</p>;
  return <ul className="rated-list">{films.map((f) => <Row key={f.id} f={f} />)}</ul>;
}
