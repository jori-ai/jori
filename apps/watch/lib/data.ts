import { createClient } from "@/lib/supabase/server";
import type { CatalogFilm, Person, RatedFilm, Verdict, WatchFilm } from "@/lib/types";

const COLS = "id,tmdb_id,imdb_id,title,year,poster_path,overview,genres,original_language,seen,not_for_us,title_id";

export async function getCounts() {
  const sb = await createClient();
  const count = async (f: (q: any) => any) => (await f(sb.from("watch_catalog").select("id", { count: "exact", head: true }).eq("kind", "movie"))).count ?? 0;
  const [left, seen, notSeen, notForUs] = await Promise.all([
    count((q) => q.is("seen", null)), count((q) => q.eq("seen", true)),
    count((q) => q.eq("seen", false).eq("not_for_us", false)), count((q) => q.eq("not_for_us", true)),
  ]);
  return { left, seen, notSeen, notForUs };
}

/** Films marked "not our thing", newest first. */
export async function getNotForUs(): Promise<CatalogFilm[]> {
  const sb = await createClient();
  const { data, error } = await sb.from("watch_catalog").select(COLS).eq("kind", "movie").eq("not_for_us", true).order("marked_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data as CatalogFilm[];
}

/** Every film marked seen, with each person's rating. */
export async function getRated(): Promise<RatedFilm[]> {
  const sb = await createClient();
  const { data, error } = await sb.from("watch_catalog").select(COLS).eq("kind", "movie").eq("seen", true).order("marked_at", { ascending: false });
  if (error) throw new Error(error.message);
  const films = data as CatalogFilm[];
  const ids = films.map((f) => f.title_id).filter((x): x is number => !!x);
  const { data: rs } = ids.length ? await sb.from("watch_ratings").select("title_id,person,verdict").in("title_id", ids) : { data: [] };
  const by = new Map<number, Partial<Record<Person, Verdict>>>();
  for (const r of (rs || []) as { title_id: number; person: Person; verdict: Verdict }[]) {
    by.set(r.title_id, { ...(by.get(r.title_id) || {}), [r.person]: r.verdict });
  }
  return films.map((f) => ({ ...f, ratings: (f.title_id && by.get(f.title_id)) || {} }));
}

/**
 * The movie database (bin/movie-db-refresh, daily): films from the past 10 years, not seen, not "not our thing", with where to watch — best predicted first
 * (the films the model thinks the viewers will like best always come first).
 */
export async function getWatchNow(): Promise<WatchFilm[]> {
  const sb = await createClient();
  const minYear = new Date().getFullYear() - 10;
  const { data, error } = await sb.from("watch_catalog")
    .select(`${COLS},model_p,in_theaters,providers,imdb_rating,theatrical_date,digital_date`)
    .eq("kind", "movie").or("seen.is.null,seen.eq.false").eq("not_for_us", false)
    .gte("model_p", 0.5).order("model_p", { ascending: false }).limit(400);
  if (error) throw new Error(error.message);
  return (data as WatchFilm[]).filter((f) => (f.year ?? 0) >= minYear); // re-releases in theaters excluded
}
