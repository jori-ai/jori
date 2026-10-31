// watch-model.mjs — load everything the recommendation model learns from (service role, on
// the host) and fit it. The model itself is lib/watch-recsys.mjs, which the ratings site
// (apps/watch) carries a copy of, so the site and the harvesters learn the same way.
import { rest } from "./watch-db.mjs";
import * as recsys from "./watch-recsys.mjs";

const FEAT = "id,kind,tmdb_id,imdb_id,title,year,poster_path,overview,genres,keywords,directors,cast_names,original_language,vote_count,vote_average,imdb_rating,seen,not_for_us,skip_count,title_id,features_at,model_p,in_theaters,providers";

async function all(path, page = 1000) {
  const out = [];
  for (let off = 0; ; off += page) {
    const rows = await rest(`${path}${path.includes("?") ? "&" : "?"}limit=${page}&offset=${off}`);
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

/** Everything collected → {model, labels, catalog, edges, titles}. */
export async function loadModel({ audience = "together" } = {}) {
  const [catalog, titles, feedback, ratings, prefs] = await Promise.all([
    all(`watch_catalog?select=${FEAT}&order=id`),
    all("watch_titles?select=id,kind,tmdb_id,status,source,name&order=id"),
    all("watch_feedback?select=title_id,verdict,season_n,source,created_at&order=created_at"),
    all("watch_ratings?select=title_id,person,verdict&order=title_id"),
    rest("watch_taste_prefs?select=audience,tag,weight"),
  ]);
  const labels = recsys.assembleLabels({ catalog, titles, feedback, ratings });
  const src = [...labels.keys()].filter((k) => k.startsWith("movie:")).map((k) => Number(k.slice(6)));
  const edges = [];
  for (let i = 0; i < src.length; i += 150) edges.push(...await all(`watch_film_edges?select=src_tmdb,dst_tmdb,weight&src_tmdb=in.(${src.slice(i, i + 150).join(",")})&order=src_tmdb`));
  // MovieLens film vectors (bin/movielens-embed) for every film we might score.
  const embRows = await all("watch_embeddings?select=tmdb_id,ml_count,v&order=tmdb_id");
  const embeddings = new Map(embRows.map((r) => [r.tmdb_id, Float64Array.from(r.v)]));
  const mlCount = new Map(embRows.map((r) => [r.tmdb_id, r.ml_count]));
  const model = recsys.buildModel({ catalog, labels, prefs, edges, audience, embeddings, mlCount });
  return { model, labels, catalog, edges, titles, feedback, ratings, prefs, embeddings, mlCount };
}

/**
 * Leave-one-out backtest over explicit labels: refit without each, predict it, score.
 * Reports how often the sign is right (liked → p ≥ .5, disliked → p < .5).
 */
export function backtest(ctx, params = recsys.PARAMS) {
  const { catalog, labels, prefs, edges } = ctx;
  const rows = new Map(catalog.map((r) => [`${r.kind === "show" ? "show" : "movie"}:${r.tmdb_id}`, r]));
  let hit = 0, n = 0, pos = 0;
  const preds = [];
  for (const [k, l] of labels) {
    if (l.score === 0 || !rows.has(k) || !rows.get(k).features_at) continue;
    const rest = new Map(labels); rest.delete(k);
    const m = recsys.buildModel({ catalog, labels: rest, prefs, edges: edges.filter((e) => `movie:${e.src_tmdb}` !== k), params, embeddings: ctx.embeddings, mlCount: ctx.mlCount });
    const p = recsys.predict(m, rows.get(k)).p;
    n++; if ((l.score > 0) === (p >= 0.5)) hit++;
    if (l.score > 0) pos++;
    preds.push({ y: l.score > 0 ? 1 : 0, p });
  }
  // AUC: the chance a random liked title is ranked above a random disliked one — what a
  // recommender is actually for, and independent of where the 0.5 line sits.
  const P = preds.filter((x) => x.y), N = preds.filter((x) => !x.y);
  let wins = 0;
  for (const a of P) for (const b of N) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  const auc = P.length && N.length ? wins / (P.length * N.length) : null;
  // Baseline = always guessing the majority class; the model has to beat it to mean anything.
  return { hit, n, baseline: Math.max(pos, n - pos), auc, preds };
}

/** Fit Platt scaling (a, b) on leave-one-out predictions by gradient descent on log-loss. */
export function fitPlatt(preds) {
  const logit = (p) => Math.log(Math.min(1 - 1e-6, Math.max(1e-6, p)) / (1 - Math.min(1 - 1e-6, Math.max(1e-6, p))));
  const xs = preds.map((x) => ({ z: logit(x.p), y: x.y }));
  let a = 1, b = 0;
  for (let it = 0; it < 4000; it++) {
    let ga = 0, gb = 0;
    for (const { z, y } of xs) { const q = 1 / (1 + Math.exp(-(a * z + b))); ga += (q - y) * z; gb += q - y; }
    a -= 0.05 * ga / xs.length; b -= 0.05 * gb / xs.length;
  }
  return { a: Math.round(a * 1000) / 1000, b: Math.round(b * 1000) / 1000 };
}
