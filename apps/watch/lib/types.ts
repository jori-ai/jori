import { VIEWERS, type Viewer } from "@/lib/config";

/** A viewer id as stored in watch_ratings.person (see VIEWERS in lib/config). */
export type Person = string;
export type Verdict = "loved" | "liked" | "meh" | "disliked" | "not_watched";

export type CatalogFilm = {
  id: number;
  tmdb_id: number;
  imdb_id: string | null;
  title: string;
  year: number | null;
  poster_path: string | null;
  overview: string | null;
  genres: string | null;
  original_language: string | null;
  seen: boolean | null;
  not_for_us?: boolean;
  title_id: number | null;
};

/** Where to watch in the US (movie-db-refresh, TMDB/JustWatch). */
export type Providers = { stream: string[]; free: string[]; rent: boolean };
export type WatchFilm = CatalogFilm & {
  model_p: number | null; in_theaters: boolean; providers: Providers | null;
  imdb_rating: number | null; theatrical_date: string | null; digital_date: string | null;
};

export type RatedFilm = CatalogFilm & { ratings: Partial<Record<Person, Verdict>> };

export const VERDICTS: { v: Verdict; label: string; emoji: string }[] = [
  { v: "loved", label: "Loved", emoji: "❤️" },
  { v: "liked", label: "Liked", emoji: "👍" },
  { v: "meh", label: "Meh", emoji: "😐" },
  { v: "disliked", label: "Didn't like", emoji: "👎" },
  { v: "not_watched", label: "Didn't watch", emoji: "—" },
];

/** The people who rate on this site, from the deployment's config. */
export const PEOPLE: Viewer[] = VIEWERS;

/** The same verdict for every viewer — a one-tap mark on behalf of everyone watching. */
export function everyone(v: Verdict, people: Viewer[] = PEOPLE): Partial<Record<Person, Verdict>> {
  return Object.fromEntries(people.map(({ p }) => [p, v]));
}

export const poster = (path: string | null, size = "w342") => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null);
