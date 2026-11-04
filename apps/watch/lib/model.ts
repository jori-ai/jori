// Loads what the recommendation model (lib/recsys.mjs) needs, as the signed-in user (RLS).
import { createClient } from "@/lib/supabase/server";
// Plain ESM: a copy of the kernel lib/watch-recsys.mjs (bin/movie-discover uses the same model); typed loosely here.
// @ts-ignore
import * as recsysModule from "@/lib/recsys.mjs";
const { assembleLabels, buildModel, designBatch, accuracy } = recsysModule as any;
import type { CatalogFilm } from "@/lib/types";

type SB = Awaited<ReturnType<typeof createClient>>;
// Model inputs only — posters and synopses are fetched for the five picks alone.
const FEAT = "id,kind,tmdb_id,title,year,genres,keywords,directors,cast_names,original_language,vote_count,vote_average,imdb_rating,seen,not_for_us,skip_count,title_id";

/** Every row of a query: the first page tells the total, the rest are fetched concurrently. */
async function all<T>(q: () => any, page = 1000): Promise<T[]> {
  const first = await q().range(0, page - 1);
  if (first.error) throw new Error(first.error.message);
  const total: number = first.count ?? (first.data?.length || 0);
  const rest = await Promise.all(Array.from({ length: Math.max(0, Math.ceil(total / page) - 1) }, async (_, i) => {
    const { data, error } = await q().range((i + 1) * page, (i + 2) * page - 1);
    if (error) throw new Error(error.message);
    return data as T[];
  }));
  return [...(first.data as T[]), ...rest.flat()];
}

// MovieLens vectors never change between releases and TMDB's graph changes slowly, yet they
// were the bulk of every batch's download (~3,200 × 64 floats). Kept per warm instance (Fluid
// Compute reuses them) and topped up with only the ids not seen yet.
const TTL = 6 * 3600_000;
let cacheAt = 0;
const embCache = new Map<number, { v: Float64Array; n: number } | null>();
const edgeCache = new Map<number, { src_tmdb: number; dst_tmdb: number; weight: number }[]>();
function freshCache() {
  if (Date.now() - cacheAt > TTL) { embCache.clear(); edgeCache.clear(); cacheAt = Date.now(); }
}
async function chunked<T>(ids: number[], size: number, fn: (part: number[]) => Promise<T[]>): Promise<T[]> {
  const parts = Array.from({ length: Math.ceil(ids.length / size) }, (_, i) => ids.slice(i * size, i * size + size));
  return (await Promise.all(parts.map(fn))).flat();
}
async function loadEdges(sb: SB, src: number[]) {
  const miss = src.filter((id) => !edgeCache.has(id));
  const rows = await chunked(miss, 150, async (part) =>
    ((await sb.from("watch_film_edges").select("src_tmdb,dst_tmdb,weight").in("src_tmdb", part).limit(5000)).data || []) as any[]);
  for (const id of miss) edgeCache.set(id, []);
  for (const r of rows) edgeCache.get(r.src_tmdb)!.push(r);
  return src.flatMap((id) => edgeCache.get(id) || []);
}
async function loadEmbeddings(sb: SB, ids: number[]) {
  const miss = ids.filter((id) => !embCache.has(id));
  const rows = await chunked(miss, 300, async (part) =>
    ((await sb.from("watch_embeddings").select("tmdb_id,ml_count,v").in("tmdb_id", part)).data || []) as any[]);
  for (const id of miss) embCache.set(id, null);
  for (const r of rows) embCache.set(r.tmdb_id, { v: Float64Array.from(r.v), n: r.ml_count });
  const embeddings = new Map<number, Float64Array>(), mlCount = new Map<number, number>();
  for (const id of ids) { const e = embCache.get(id); if (e) { embeddings.set(id, e.v); mlCount.set(id, e.n); } }
  return { embeddings, mlCount };
}

export type Pick = { film: CatalogFilm; slot: string; p: number; u: number; why: string };

/** Fit the model on everything collected so far and design the next batch of five. */
export async function nextBatch(): Promise<{ picks: Pick[]; labels: number; acc: { hit: number; n: number } }> {
  const sb: SB = await createClient();
  const [labelledRows, pool, titles, feedback, ratings, prefs, batches] = await Promise.all([
    // Rows that carry a label (on the list, or marked on the site) — films and shows.
    all<any>(() => sb.from("watch_catalog").select(FEAT, { count: "exact" }).or("title_id.not.is.null,seen.not.is.null,not_for_us.eq.true").order("id")),
    // Askable films: unmarked, enriched, widely enough seen that a mark is likely, and from the
    // past 10 years (rolling; older marks still teach the model).
    all<any>(() => sb.from("watch_catalog").select(FEAT, { count: "exact" }).eq("kind", "movie").is("seen", null).eq("not_for_us", false)
      .gte("year", new Date().getFullYear() - 10).not("features_at", "is", null).gte("vote_count", 800).order("vote_count", { ascending: false }).order("id")),
    all<any>(() => sb.from("watch_titles").select("id,kind,tmdb_id,status,source", { count: "exact" }).order("id")),
    all<any>(() => sb.from("watch_feedback").select("title_id,verdict,season_n,source,created_at", { count: "exact" }).order("created_at")),
    all<any>(() => sb.from("watch_ratings").select("title_id,person,verdict", { count: "exact" }).order("title_id")),
    sb.from("watch_taste_prefs").select("audience,tag,weight").then((r: any) => r.data || []),
    sb.from("watch_batches").select("shown,marks").order("created_at", { ascending: false }).limit(20).then((r: any) => r.data || []),
  ]);
  const have = new Set(labelledRows.map((r) => r.id));
  const catalog = [...labelledRows, ...pool.filter((r) => !have.has(r.id))];
  const labels = assembleLabels({ catalog, titles, feedback, ratings });
  // Collaborative edges out of every labelled film; MovieLens taste vectors for every labelled
  // or askable film. Both cached across batches (above).
  freshCache();
  const src = [...labels.keys()].filter((k: string) => k.startsWith("movie:")).map((k: string) => Number(k.slice(6)));
  const ids = [...new Set([...src, ...pool.map((r: any) => r.tmdb_id)])];
  const [edges, { embeddings, mlCount }] = await Promise.all([loadEdges(sb, src), loadEmbeddings(sb, ids)]);
  const model = buildModel({ catalog, labels, prefs, edges, embeddings, mlCount });
  const batch = designBatch(model, pool);
  const { data: details } = await sb.from("watch_catalog").select("id,imdb_id,poster_path,overview").in("id", batch.map((x: any) => x.row.id));
  const det = new Map((details || []).map((d: any) => [d.id, d]));
  const picks = batch.map((x: any) => ({ film: { ...x.row, ...(det.get(x.row.id) || {}) } as CatalogFilm, slot: x.slot, p: x.p, u: x.u, why: x.why }));
  return { picks, labels: labels.size, acc: accuracy(batches) };
}
