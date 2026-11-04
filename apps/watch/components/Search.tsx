"use client";

import { useState, useTransition } from "react";
import FilmCard from "@/components/FilmCard";
import { searchFilms } from "@/lib/actions";
import type { CatalogFilm } from "@/lib/types";

export default function Search() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<CatalogFilm[] | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [pending, start] = useTransition();
  const go = (e: React.FormEvent) => { e.preventDefault(); start(async () => { setRes(await searchFilms(q)); setDone(new Set()); }); };
  return (
    <div>
      <form className="search" onSubmit={go}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find any film…" aria-label="Search films" />
        <button className="primary" disabled={pending || q.trim().length < 2}>{pending ? "…" : "Search"}</button>
      </form>
      {res && !res.length && <p className="empty">No films found.</p>}
      <div className="list">
        {res?.filter((f) => !done.has(f.id)).map((f) => <FilmCard key={f.id} film={f} onDone={(id) => setDone(new Set(done).add(id))} />)}
      </div>
    </div>
  );
}
