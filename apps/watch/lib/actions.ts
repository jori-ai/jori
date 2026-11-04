"use server";

// Writes run as the signed-in user: RLS on watch_catalog / watch_titles /
// watch_ratings allows exactly the allowed viewers' Google identities (migration
// 20261010_watch_ratings_catalog.sql). No service-role key on Vercel.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAllowedUser } from "@/lib/auth";
import { everyone, PEOPLE as VIEWERS, type CatalogFilm, type Person, type Verdict } from "@/lib/types";

const PEOPLE: Person[] = VIEWERS.map((v) => v.p);
const VERDICTS: Verdict[] = ["loved", "liked", "meh", "disliked", "not_watched"];

async function film(sb: Awaited<ReturnType<typeof createClient>>, catalogId: number) {
  const { data, error } = await sb.from("watch_catalog").select("*").eq("id", catalogId).single();
  if (error || !data) throw new Error(error?.message || "film not found");
  return data as CatalogFilm & { kind: string };
}

/**
 * The watch_titles row for a catalog film — found by TMDB/IMDb id, else created — set to
 * `status`: "watched" (seen it) or "rejected" (not our thing: discovery never adds it, and
 * taste fit counts it against its genres).
 */
async function ensureTitle(sb: Awaited<ReturnType<typeof createClient>>, f: CatalogFilm, status: "watched" | "rejected" = "watched") {
  if (f.title_id) {
    await sb.from("watch_titles").update({ status, updated_at: new Date().toISOString() }).eq("id", f.title_id);
    return f.title_id;
  }
  const q = sb.from("watch_titles").select("id").neq("kind", "show");
  const { data: hit } = f.imdb_id
    ? await q.or(`tmdb_id.eq.${f.tmdb_id},imdb_id.eq.${f.imdb_id}`).limit(1)
    : await q.eq("tmdb_id", f.tmdb_id).limit(1);
  if (hit?.length) {
    await sb.from("watch_titles").update({ status, updated_at: new Date().toISOString() }).eq("id", hit[0].id);
    return hit[0].id as number;
  }
  const { data, error } = await sb.from("watch_titles").insert({
    kind: (f.genres || "").includes("Documentary") ? "documentary" : "movie",
    name: f.title, imdb_id: f.imdb_id, tmdb_id: f.tmdb_id, audience: "together", status,
    year_start: f.year, genres: f.genres, description: f.overview, original_language: f.original_language,
    source: "web", intro_emailed_at: new Date().toISOString(), // seen or not wanted — never introduce it
  }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as number;
}

type SB = Awaited<ReturnType<typeof createClient>>;

async function notSeen(sb: SB, catalogId: number) {
  const { error } = await sb.from("watch_catalog").update({ seen: false, marked_at: new Date().toISOString() }).eq("id", catalogId);
  if (error) throw new Error(error.message);
}

async function notForUs(sb: SB, catalogId: number) {
  const f = await film(sb, catalogId);
  const titleId = await ensureTitle(sb, f, "rejected");
  const { error } = await sb.from("watch_catalog")
    .update({ seen: false, not_for_us: true, title_id: titleId, marked_at: new Date().toISOString() }).eq("id", catalogId);
  if (error) throw new Error(error.message);
  return f;
}

async function seen(sb: SB, catalogId: number, ratings: Partial<Record<Person, Verdict>>) {
  const f = await film(sb, catalogId);
  const titleId = await ensureTitle(sb, f);
  const rows = PEOPLE.filter((p) => ratings[p] && VERDICTS.includes(ratings[p]!))
    .map((p) => ({ title_id: titleId, person: p, verdict: ratings[p]!, source: "web", updated_at: new Date().toISOString() }));
  if (rows.length) {
    const { error } = await sb.from("watch_ratings").upsert(rows, { onConflict: "title_id,person" });
    if (error) throw new Error(error.message);
  }
  const { error } = await sb.from("watch_catalog").update({ seen: true, not_for_us: false, title_id: titleId, marked_at: new Date().toISOString() }).eq("id", catalogId);
  if (error) throw new Error(error.message);
  return f;
}

export type Mark = "up" | "meh" | "down" | null;

/**
 * Unmarked in a batch: not seen, or no strong feeling — it goes to the back. Left unmarked a
 * second time it's taken as "haven't seen it" (there is no point in showing it
 * again): seen=false drops it from the batches, and movie-discover may propose it.
 */
async function skipped(sb: SB, catalogId: number) {
  const { data } = await sb.from("watch_catalog").select("skip_count").eq("id", catalogId).single();
  const skips = (data?.skip_count ?? 0) + 1;
  const { error } = await sb.from("watch_catalog")
    .update({ skip_count: skips, last_shown_at: new Date().toISOString(), ...(skips >= 2 ? { seen: false } : {}) }).eq("id", catalogId);
  if (error) throw new Error(error.message);
}

/**
 * One batch of five: 👍 = seen and liked, sideways thumb = seen it, meh, 👎 = didn't want to
 * see it or didn't like it (rejected, never suggested), unmarked = not seen or no strong
 * feeling — not recorded, sent to the back (it can come round again later). 👍 and meh
 * record every viewer's rating (refine per person under "What we've seen"). The batch, the
 * model's predictions for it and the marks are logged to watch_batches — the model's own
 * accuracy record. The next batch is designed by lib/recsys.mjs from everything collected.
 */
export async function submitBatch(shown: { tmdb_id: number; id: number; slot: string; p: number; u: number }[], marks: Record<number, Mark>, labels: number) {
  await requireAllowedUser();
  const sb = await createClient();
  const logMarks: Record<number, string> = {};
  // The five films are independent rows — write them concurrently (sequentially it was ~20
  // round trips, seconds of "Learning…").
  await Promise.all([
    ...shown.slice(0, 10).map((s) => {
      const m = marks[s.id] ?? null;
      if (m) logMarks[s.tmdb_id] = m;
      if (m === "up") return seen(sb, s.id, everyone("liked"));
      if (m === "meh") return seen(sb, s.id, everyone("meh"));
      if (m === "down") return notForUs(sb, s.id);
      return skipped(sb, s.id);
    }),
  ]);
  await sb.from("watch_batches").insert({
    shown: shown.map(({ tmdb_id, slot, p, u }) => ({ tmdb_id, slot, p, u })), marks: logMarks, model_labels: labels,
  });
  revalidatePath("/");
}

export async function markNotSeen(catalogId: number) {
  await requireAllowedUser();
  await notSeen(await createClient(), catalogId);
  revalidatePath("/");
}

/** "Not our thing" — haven't seen it because the genre/category isn't for them. */
export async function markNotForUs(catalogId: number) {
  await requireAllowedUser();
  await notForUs(await createClient(), catalogId);
  revalidatePath("/");
}

export async function saveSeen(catalogId: number, ratings: Partial<Record<Person, Verdict>>) {
  await requireAllowedUser();
  await seen(await createClient(), catalogId, ratings);
  revalidatePath("/");
}

/** Put a film back in the queue (an accidental tap). Ratings stay unless re-marked. */
export async function unmark(catalogId: number) {
  await requireAllowedUser();
  const sb = await createClient();
  const { data: f } = await sb.from("watch_catalog").select("not_for_us,title_id").eq("id", catalogId).single();
  // Undoing "not our thing" lifts the rejection: a row this site created just for the
  // rejection is deleted (RLS allows deleting source='web' rows only); a title that was
  // already on the list goes back to the queue. A seen film stays watched.
  let unlink = false;
  if (f?.not_for_us && f.title_id) {
    const { data: t } = await sb.from("watch_titles").select("source,status").eq("id", f.title_id).single();
    if (t?.source === "web") { await sb.from("watch_titles").delete().eq("id", f.title_id); unlink = true; }
    else if (t?.status === "rejected") await sb.from("watch_titles").update({ status: "queued", updated_at: new Date().toISOString() }).eq("id", f.title_id);
  }
  const { error } = await sb.from("watch_catalog")
    .update({ seen: null, not_for_us: false, marked_at: null, ...(unlink ? { title_id: null } : {}) }).eq("id", catalogId);
  if (error) throw new Error(error.message);
  revalidatePath("/");
}

/** Find any film: the catalog first, then TMDB (new hits are added to the catalog). */
export async function searchFilms(query: string): Promise<CatalogFilm[]> {
  await requireAllowedUser();
  const q = query.trim();
  if (q.length < 2) return [];
  const sb = await createClient();
  const cols = "id,tmdb_id,imdb_id,title,year,poster_path,overview,genres,original_language,seen,not_for_us,title_id";
  const key = process.env.TMDB_API_KEY;
  if (key) {
    const r = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${key}&query=${encodeURIComponent(q)}&include_adult=false`, { cache: "no-store" });
    const hits = r.ok ? ((await r.json()).results || []).slice(0, 8) : [];
    const fresh = hits.filter((m: any) => m.id && m.title).map((m: any) => ({
      kind: "movie", tmdb_id: m.id, title: m.title, year: m.release_date ? parseInt(m.release_date.slice(0, 4), 10) : null,
      poster_path: m.poster_path || null, overview: m.overview || null, original_language: m.original_language || null,
      vote_count: m.vote_count || 0, vote_average: Math.round((m.vote_average || 0) * 10) / 10, rank: 100000,
    }));
    // ignoreDuplicates: never overwrite a film's marks or its seed rank.
    if (fresh.length) await sb.from("watch_catalog").upsert(fresh, { onConflict: "kind,tmdb_id", ignoreDuplicates: true });
    const ids: number[] = fresh.map((m: { tmdb_id: number }) => m.tmdb_id);
    if (ids.length) {
      const { data } = await sb.from("watch_catalog").select(cols).eq("kind", "movie").in("tmdb_id", ids);
      const order = new Map<number, number>(ids.map((id, i) => [id, i] as [number, number]));
      return ((data || []) as CatalogFilm[]).sort((a, b) => (order.get(a.tmdb_id) ?? 0) - (order.get(b.tmdb_id) ?? 0));
    }
  }
  const { data } = await sb.from("watch_catalog").select(cols).eq("kind", "movie").ilike("title", `%${q}%`).order("rank").limit(12);
  return (data || []) as CatalogFilm[];
}
