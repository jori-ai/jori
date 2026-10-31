// watch-recsys.mjs — the watch-list recommendation model (2026-10-10).
//
// A true recommendation system: it learns from every piece of feedback and from what the
// viewers like, each batch of five is designed to solicit feedback the model learns from,
// and it uses the data already collected.
//
// Shared, pure, no I/O: the ratings site (apps/watch, which carries its own copy) designs each
// batch of five with it, and the harvesters rank candidates with it. Callers load the rows.
//
// ── Model ────────────────────────────────────────────────────────────────────────────
// Every title (film or show) is a bag of features from TMDB (bin/watch-catalog-enrich):
//   g:<genre>  k:<keyword>  d:<director / show creator>  c:<cast>  e:<decade>  l:<language>
//   s:<franchise> (TMDB collection)
// Labels come from everything they've told us (assembleLabels): thumbs on the site, each
// person's ratings, verdicts in chat, what they watched, what they rejected, what they added.
// Each label has a score (loved +2 … disliked −1) and a confidence (explicit 1, implicit < 1).
//
//  content  per-feature preference w_f = (Σ conf·score + prior_f·PRIOR_N) / (Σ conf + PRIOR_N + SHRINK)
//           — shrunk toward the stated preferences (watch_taste_prefs: horror −1.5 …) and
//           toward 0 when a feature has little evidence. A film's content score is the
//           type-weighted mean of its features' w_f.
//  collab   TMDB's recommendation graph (watch_film_edges): Σ score_j·edge(j→i) over labelled
//           films j — "films like the ones you loved".
//  quality  TMDB vote average, a weak prior.
//  p(like)  = σ(1.8·content + 1.2·tanh(collab/2) + 0.35·quality)
//  u        = how little evidence stands behind the prediction (mean 1/√(n_f+1) over features).
//
// ── Learned film vectors (MovieLens) ────────────────────────────────────────────────
// bin/movielens-embed learns a 64-d vector per film from 32M MovieLens ratings
// (watch_embeddings). Their taste is a vector θ with a Bayesian posterior N(μ, Σ) fitted on
// their labelled films' vectors (fitTaste): z gains ze·θ·v. The posterior's spread is what
// Thompson sampling explores.
//
// ── Batch design (Bayesian active learning + Thompson sampling) ──────────────────────
// Draw a committee of S plausible tastes θ̃ ~ N(μ, Σ) (each with noise on the feature model
// scaled by its uncertainty). Four slots go to the films the committee DISAGREES on most
// (variance of the sampled p(like), × familiarity) — the marks that move the model most
// ("query by committee", a BALD-style criterion). One slot is a Thompson pick: one sampled
// taste's favourite, so a batch also shows a likely-loved film and checks calibration.
// Pure Thompson sampling was tried first and filled batches with 99% sure things.
//
// ── (earlier) slot design, kept for cold start ───────────────────────────────────────
// A batch is worth only the marks it gets, and they mark only films they've SEEN and feel
// strongly about — so every pick is weighted by familiarity φ (how widely seen it is,
// halved per earlier skip). Five slots, each asking a different question:
//   confirm   highest p           — does the model's best guess hold up?
//   probe ×2  highest u·φ         — where the model knows least
//   contrast  lowest p, φ high    — does a predicted dislike really miss? (guards confirmation bias)
//   explore   least-covered genre — taste the model has never seen evidence on
// A diversity rule keeps the five apart (feature overlap < 0.35, no shared director).
// Cold start (few labels): mostly explore + probe across different genres.

// Hyperparameters, tuned by `watch-model tune` (leave-one-out AUC on the collected labels).
export const PARAMS = {
  type: { g: 1.0, k: 0.55, d: 1.2, c: 0.4, e: 0.3, l: 0.5, s: 1.6 },
  // Dealbreaker term: a film's single most-disliked feature counts on its own, not averaged
  // away by its other genres (2026-10-10: The Conjuring scored 0.73 despite "horror −1.5").
  zmin: 0.8,
  priorN: 2,      // stated preferences count as this many observations
  shrink: 0.5,    // pull sparse features toward neutral
  center: false,  // learn features relative to their average title (tuned: off scores slightly better)
  zc: 1.8, zk: 0.6, zq: 0.8,  // zq/zmin tuned 2026-10-10 (LOO AUC 0.866 → 0.897)
  // Platt calibration p' = σ(a·logit(p) + b), fitted on leave-one-out predictions by
  // `watch-model calibrate` so "p ≥ 0.5" really means "more likely liked than not".
  horror: 1.5,    // stated-rule penalty for horror-led films below 7.8 (2026-10-11: AUC 0.914 → 0.917)
  ze: 1.0,        // weight of the MovieLens taste term (tuned 2026-10-10: AUC 0.897 → 0.917)
  tau: 1.0,       // prior std of taste weights
  sigma: 1.0,     // label noise
  calib: { a: 2.488, b: -0.899 }, // refit 2026-10-11 with IMDb as the quality prior: LOO 86.5% vs 76.5% baseline, AUC 0.915
};
export const TYPE_WEIGHT = PARAMS.type;
const CONF_FLOOR = 0.15;

const norm = (s) => String(s || "").trim().toLowerCase();
const GENRE_SPLIT = { "sci-fi & fantasy": ["science fiction", "fantasy"], "action & adventure": ["action", "adventure"], "war & politics": ["war", "politics"] };

/** Feature bag for one catalog row. */
export function featuresOf(r) {
  const out = new Set();
  for (const g of String(r.genres || "").split(",").map(norm).filter(Boolean)) for (const x of GENRE_SPLIT[g] || [g]) out.add(`g:${x}`);
  for (const k of String(r.keywords || "").split("|").map(norm).filter(Boolean).slice(0, 15)) out.add(`k:${k}`);
  for (const d of String(r.directors || "").split("|").map(norm).filter(Boolean)) out.add(`d:${d}`);
  for (const c of String(r.cast_names || "").split("|").map(norm).filter(Boolean).slice(0, 6)) out.add(`c:${c}`);
  if (r.year) out.add(`e:${Math.floor(r.year / 10) * 10}s`);
  if (r.original_language) out.add(`l:${norm(r.original_language)}`);
  if (r.collection) out.add(`s:${norm(r.collection)}`);
  return [...out];
}

// Stated preference tags (watch_taste_prefs) → the features they speak about.
const TAG_FEATURES = {
  horror: ["g:horror", "k:horror", "k:supernatural horror", "k:slasher", "k:body horror", "k:psychological horror"],
  superhero: ["k:superhero", "k:based on comic", "k:marvel cinematic universe (mcu)", "k:dc extended universe (dceu)", "k:superhero team", "k:super power"],
  romance: ["g:romance", "k:romance", "k:love", "k:romantic comedy"],
  "sci-fi": ["g:science fiction"],
  action: ["g:action"],
  comedy: ["g:comedy", "k:dark comedy", "k:satire"],
  spy: ["k:espionage", "k:spy", "k:secret agent", "k:cia", "k:mi6", "k:mossad"],
  drama: ["g:drama"],
};
export function priorsFrom(prefs = [], audience = "together") {
  const out = new Map();
  for (const p of prefs) {
    if (p.audience !== "all" && p.audience !== audience) continue;
    for (const f of TAG_FEATURES[p.tag] || [`g:${norm(p.tag)}`]) out.set(f, Math.max(-2, Math.min(2, (out.get(f) || 0) + Number(p.weight) * 0.6)));
  }
  return out;
}

const HYBRID = /\b(Science Fiction|Comedy|Action|Adventure|Drama)\b/;
/** Horror without a sci-fi / comedy / action / adventure / drama side (genre list from TMDB). */
export function isHorrorLed(genres) {
  const g = genres || "";
  return /\bHorror\b/.test(g) && !HYBRID.test(g);
}

export const VERDICT_SCORE = { loved: 2, liked: 1, meh: 0, disliked: -1, dropped: -1, not_interested: -1 };

/**
 * Everything they've told us → Map("movie:<tmdb>"|"show:<tmdb>" → {score, conf, why}).
 * The strongest signal for a title wins: site thumbs / per-person ratings > chat verdicts >
 * implicit status. Inputs are plain rows (catalog, titles, feedback, ratings).
 */
export function assembleLabels({ catalog = [], titles = [], feedback = [], ratings = [] }) {
  const byTitle = new Map(titles.map((t) => [t.id, t]));
  const key = (kind, tmdb) => `${kind === "show" ? "show" : "movie"}:${tmdb}`;
  const labels = new Map();
  const put = (k, score, conf, why) => { const cur = labels.get(k); if (!cur || conf > cur.conf) labels.set(k, { score, conf, why }); };

  // Implicit: what they did with titles on the list.
  for (const t of titles) {
    if (!t.tmdb_id) continue;
    const k = key(t.kind, t.tmdb_id);
    if (t.status === "watched") put(k, 0.5, 0.45, "watched");
    else if (t.status === "watching") put(k, 0.5, 0.35, "watching");
    else if (t.status === "dropped") put(k, -1, 0.7, "dropped");
    else if (t.status === "rejected") put(k, -1, t.source === "web" ? 0.9 : 0.5, "rejected");
    else if (t.status === "queued" && t.source === "manual") put(k, 0.4, 0.25, "added by hand");
  }
  // Chat / hum verdicts (latest per title). Cleanup rejections were the agent's call at the
  // user's request, so they count less than the user's own words.
  const latest = new Map(); // feedback arrives oldest first → the last one per title wins
  for (const f of feedback) latest.set(f.title_id, f);
  for (const [tid, f] of latest) {
    const t = byTitle.get(tid);
    if (!t?.tmdb_id || !(f.verdict in VERDICT_SCORE)) continue;
    put(key(t.kind, t.tmdb_id), VERDICT_SCORE[f.verdict], f.source === "cleanup" ? 0.55 : f.source === "web" ? 0.95 : 0.85, `verdict ${f.verdict}`);
  }
  // Per-person ratings from the site: the mean of whoever rated it.
  const per = new Map();
  for (const r of ratings) if (r.verdict in VERDICT_SCORE) (per.get(r.title_id) || per.set(r.title_id, []).get(r.title_id)).push(VERDICT_SCORE[r.verdict]);
  for (const [tid, xs] of per) {
    const t = byTitle.get(tid);
    if (t?.tmdb_id) put(key(t.kind, t.tmdb_id), xs.reduce((a, b) => a + b, 0) / xs.length, 1, "rated");
  }
  // Catalog marks with no title row (shouldn't happen, but a 👎 always counts).
  for (const c of catalog) if (c.not_for_us) put(key(c.kind, c.tmdb_id), -1, 0.9, "not our thing");
  return labels;
}

/** Fit the model. catalog rows need kind, tmdb_id + feature columns; edges: [{src_tmdb,dst_tmdb,weight}]. */
export function buildModel({ catalog, labels, prefs = [], edges = [], audience = "together", params = PARAMS, embeddings = new Map(), mlCount = new Map() }) {
  const rows = new Map(catalog.map((r) => [`${r.kind === "show" ? "show" : "movie"}:${r.tmdb_id}`, r]));
  const stats = new Map(); // f → {s, n}
  let ms = 0, mn = 0;
  for (const [k, l] of labels) { if (rows.has(k)) { const c = Math.max(CONF_FLOOR, l.conf); ms += c * l.score; mn += c; } }
  const mean = params.center && mn ? ms / mn : 0; // their average title
  for (const [k, l] of labels) {
    const r = rows.get(k);
    if (!r) continue;
    const c = Math.max(CONF_FLOOR, l.conf);
    for (const f of featuresOf(r)) { const x = stats.get(f) || { s: 0, n: 0 }; x.s += c * (l.score - mean); x.n += c; stats.set(f, x); }
  }
  const priors = priorsFrom(prefs, audience);
  const w = new Map();
  for (const f of new Set([...stats.keys(), ...priors.keys()])) {
    const x = stats.get(f) || { s: 0, n: 0 };
    w.set(f, (x.s + (priors.get(f) || 0) * params.priorN) / (x.n + params.priorN + params.shrink));
  }
  // Collaborative: score flows from labelled films along TMDB recommendation edges.
  const movieScore = new Map();
  for (const [k, l] of labels) if (k.startsWith("movie:")) movieScore.set(Number(k.slice(6)), l.score * Math.max(CONF_FLOOR, l.conf));
  const collab = new Map();
  for (const e of edges) {
    const s = movieScore.get(e.src_tmdb);
    if (s !== undefined) collab.set(e.dst_tmdb, (collab.get(e.dst_tmdb) || 0) + s * e.weight);
  }
  const labelled = new Set([...labels.keys()]);
  const taste = embeddings.size ? fitTaste(labels, embeddings, params) : null;
  return { w, stats, priors, collab, labelled, nLabels: labels.size, mean, params, taste, embeddings, mlCount };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// ── small dense linear algebra (K ≤ 128) ─────────────────────────────────────────────
function cholesky(A, n) { // A row-major n×n SPD → lower L
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * n + j];
    for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
    L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j];
  }
  return L;
}
function solveL(L, b, n) { const x = new Float64Array(n); for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k]; x[i] = s / L[i * n + i]; } return x; }
function solveLT(L, b, n) { const x = new Float64Array(n); for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; } return x; }
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Seeded RNG so a batch is reproducible for a given seed (tests); Math.random otherwise. */
export function rng(seed) {
  if (seed == null) return Math.random;
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rand) { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/**
 * Bayesian linear regression of label score on film vectors: θ ~ N(0, τ²I),
 * y_i ~ N(θ·v_i, σ²/conf_i). Returns {mu, L, K} where Σ = (L Lᵀ)⁻¹.
 */
export function fitTaste(labels, embeddings, params = PARAMS) {
  let K = 0;
  for (const v of embeddings.values()) { K = v.length; break; }
  if (!K) return null;
  const A = new Float64Array(K * K), b = new Float64Array(K);
  for (let i = 0; i < K; i++) A[i * K + i] = 1 / (params.tau * params.tau);
  let n = 0;
  for (const [k, l] of labels) {
    if (!k.startsWith("movie:")) continue;
    const v = embeddings.get(Number(k.slice(6)));
    if (!v) continue;
    const w = Math.max(CONF_FLOOR, l.conf) / (params.sigma * params.sigma);
    for (let i = 0; i < K; i++) { b[i] += w * l.score * v[i]; for (let j = 0; j <= i; j++) A[i * K + j] += w * v[i] * v[j]; }
    n++;
  }
  for (let i = 0; i < K; i++) for (let j = 0; j < i; j++) A[j * K + i] = A[i * K + j];
  const L = cholesky(A, K);
  const mu = solveLT(L, solveL(L, b, K), K);
  return { mu, L, K, n };
}
/** Posterior variance of θ·v. */
function tasteVar(t, v) { const y = solveL(t.L, v, t.K); return dot(y, y); }
/** One Thompson draw θ̃ = μ + L⁻ᵀ ε. */
function sampleTaste(t, rand) { const e = new Float64Array(t.K); for (let i = 0; i < t.K; i++) e[i] = gauss(rand); const d = solveLT(t.L, e, t.K); return t.mu.map((m, i) => m + d[i]); }

/** Prediction for one row: p(like), uncertainty, and the features driving it. */
export function predict(model, r) {
  const feats = featuresOf(r);
  let num = 0, den = 0, unc = 0, uden = 0, worst = 0;
  const byType = {};
  for (const f of feats) { const t = f[0]; (byType[t] ||= []).push(f); }
  const contrib = [];
  for (const [t, fs] of Object.entries(byType)) {
    const tw = (model.params || PARAMS).type[t] ?? 0.3;
    let m = 0;
    for (const f of fs) {
      const wf = model.w.get(f) || 0;
      m += wf;
      if (t !== "e" && t !== "l") worst = Math.min(worst, wf);
      const n = model.stats.get(f)?.n || 0;
      unc += tw / Math.sqrt(n + 1); uden += tw;
      if (wf) contrib.push({ f, v: wf * tw / fs.length });
    }
    num += tw * (m / fs.length); den += tw;
  }
  const content = den ? num / den : 0;
  const collabRaw = model.collab.get(r.tmdb_id) || 0;
  // Quality prior: IMDb rating when known (predicts their marks better than TMDB's score —
  // AUC .66 vs .62; Rotten Tomatoes .52 and Metacritic .57 don't, so they aren't used).
  // Shrunk toward 6.3 by vote count: a new release with one 10/10 vote is not a 10 (2026-10-11).
  const raw = r.imdb_rating ?? r.vote_average;
  const n = r.vote_count || 0;
  const score = raw ? (raw * n + 6.3 * 150) / (n + 150) : 0;
  const quality = score ? Math.max(-2.5, Math.min(1, (score - 6.8) / 1.2)) : 0;
  // Horror: "very low on our preferences. A show needs to be very highly rated for us to watch
  // it anyway (think widows bay)" — a stated rule, so code enforces it whatever the labels say.
  // Applied to horror-led films only: on their marks, horror hybrids (Alien, Shaun of the Dead,
  // World War Z, The Menu) were liked and pure horror (The Conjuring, Insidious, The Ring) wasn't.
  const horror = isHorrorLed(r.genres) && score < 7.8 ? -((model.params || PARAMS).horror ?? 1.5) : 0;
  const P = model.params || PARAMS;
  const base = horror + (model.mean || 0) + P.zc * content + (P.zmin ?? 0) * worst + P.zk * Math.tanh(collabRaw / 2) + P.zq * quality;
  const v = model.taste && model.embeddings?.get(r.tmdb_id);
  const tasteMean = v ? dot(model.taste.mu, v) : 0;
  const tVar = v ? tasteVar(model.taste, v) : 0;
  const z = base + (P.ze ?? 0) * tasteMean;
  const p = sigmoid((P.calib?.a ?? 1) * z + (P.calib?.b ?? 0));
  contrib.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  // Explanations name recognisable features only — never decade or language.
  const named = contrib.filter((c) => !c.f.startsWith("l:") && !c.f.startsWith("e:"));
  const uFeat = uden ? unc / uden : 1;
  // Total uncertainty: the feature model's evidence gap, and the taste posterior's spread.
  const u = v ? Math.min(1, 0.5 * uFeat + 0.5 * Math.sqrt(tVar)) : uFeat;
  return { p, u, uFeat, base, v, tasteMean, tVar, content, collab: collabRaw, top: contrib.slice(0, 3),
    plus: named.filter((c) => c.v > 0)[0] || null, minus: named.filter((c) => c.v < 0)[0] || null };
}

/**
 * How likely they've seen it: the film's vote-count percentile within the pool (TMDB votes
 * track how widely a film was watched), halved per earlier skip. `rankOf` maps tmdb_id → percentile.
 */
export function familiarity(r, rankOf, mlRankOf) {
  // MovieLens rating counts are a direct measure of how many people saw it; TMDB votes a proxy.
  const t = rankOf.get(r.tmdb_id) ?? 0, m = mlRankOf?.get(r.tmdb_id);
  const f = m == null ? t : (t + m) / 2;
  // Old films are widely rated but rarely seen by them: halve before 1975, quarter before 1960.
  const age = !r.year ? 1 : r.year < 1960 ? 0.25 : r.year < 1975 ? 0.5 : 1;
  return Math.max(0.02, f * age) * Math.pow(0.5, r.skip_count || 0);
}
// Never worth asking about: kids' fare and TV movies (nothing to learn from a 👎 they'd always give).
const UNASKABLE = ["g:tv movie", "g:family"];

function overlap(a, b) {
  const A = new Set(a), n = b.filter((x) => A.has(x)).length;
  return n / Math.max(1, Math.min(a.length, b.length));
}

export const featureLabel = (f) => {
  const [t, ...rest] = f.split(":"); const v = rest.join(":");
  return { g: `${v} films`, k: v, d: `${v}'s films`, c: `films with ${v}`, e: `the ${v}`, l: `${v}-language films`, s: v.replace(/ collection$/, "") }[t] || v; // lang-regex-ok: TMDB collection name suffix
};

/** Name a probe's question at a level they'd recognise: a director or genre the model knows little about. */
function probeWhy(model, x) {
  const thin = x.f.filter((f) => f.startsWith("d:") || f.startsWith("g:")).sort((a, b) => (model.stats.get(a)?.n || 0) - (model.stats.get(b)?.n || 0))[0];
  return thin ? `Learning: how do you feel about ${featureLabel(thin)}?` : "Learning something new about your taste";
}

/**
 * Settled: asking would teach nothing. A franchise with a 👎'd film, or a film the model is
 * already sure they dislike (p < 0.25 on solid evidence), never goes in a batch — 2026-10-10,
 * the old "contrast" slot showed four Pirates films and seven Marvel films in a row because
 * each 👎 made the next one a more confident miss.
 */
function settled(model, x) {
  if (x.f.some((f) => f.startsWith("s:") && (model.w.get(f) || 0) < -0.2 && (model.stats.get(f)?.n || 0) >= 0.5)) return true;
  return x.p < 0.15 || (x.p < 0.25 && x.u < 0.6);
}

/**
 * Design one batch from the pool of askable films (kind movie, unmarked).
 * Returns [{row, slot, p, u, why}] — `why` is the question the pick asks, for the tile's details.
 */
export function designBatch(model, pool, { size = 5, seed = null } = {}) {
  if (!pool.length) return [];
  const byVotes = [...pool].sort((a, b) => (a.vote_count || 0) - (b.vote_count || 0));
  const rankOf = new Map(byVotes.map((r, i) => [r.tmdb_id, (i + 1) / byVotes.length]));
  const ml = [...pool].filter((r) => model.mlCount?.has(r.tmdb_id)).sort((a, b) => model.mlCount.get(a.tmdb_id) - model.mlCount.get(b.tmdb_id));
  const mlRankOf = new Map(ml.map((r, i) => [r.tmdb_id, (i + 1) / ml.length]));
  const scored = pool.map((r) => ({ row: r, f: featuresOf(r), phi: familiarity(r, rankOf, mlRankOf), ...predict(model, r) }))
    .filter((x) => !x.f.some((f) => UNASKABLE.includes(f)))
    // Poorly rated films (TMDB < 6.3) are rarely seen by them and teach little about taste.
    .filter((x) => (x.row.vote_average || 0) >= 6.3)
    // A film they've probably never heard of can't be marked; keep the widely seen half,
    // plus anything their own favourites point at.
    .filter((x) => x.phi >= 0.5 || x.collab > 0.5)
    .filter((x) => !settled(model, x));
  // One film per franchise per batch.
  const sameFranchise = (a, b) => a.f.some((f) => f.startsWith("s:") && b.f.includes(f));
  const chosen = [];
  const ok = (x) => !chosen.some((c) => c.row.tmdb_id === x.row.tmdb_id || overlap(c.f, x.f) >= 0.35
    || x.f.some((f) => f.startsWith("d:") && c.f.includes(f)) || sameFranchise(c, x));
  const take = (slot, list, why) => { const x = list.find(ok); if (x) chosen.push({ ...x, slot, why: why(x) }); };
  const by = (fn) => [...scored].sort((a, b) => fn(b) - fn(a));

  // Close in MovieLens taste space counts as "too similar" too.
  const near = (a, b) => a.v && b.v && dot(a.v, b.v) > 0.85;
  const okTS = (x) => ok(x) && !chosen.some((c) => near(c, x));

  if (model.taste && model.taste.n >= 10) {
    const rand = rng(seed);
    const P = model.params || PARAMS;
    const ca = P.calib?.a ?? 1, cb = P.calib?.b ?? 0;
    const S = 24;
    const thetas = Array.from({ length: S }, () => sampleTaste(model.taste, rand));
    for (const x of scored) {
      // Feature-model noise kept small: the committee should disagree because the TASTE is
      // uncertain, not because of dice (0.6 made every range 10–95%).
      const ps = thetas.map((th) => sigmoid(ca * (x.base + gauss(rand) * 0.2 * x.uFeat + (P.ze ?? 0) * (x.v ? dot(th, x.v) : 0)) + cb));
      const m = ps.reduce((a, b) => a + b, 0) / S;
      x.disagree = ps.reduce((a, q) => a + (q - m) * (q - m), 0) / S;
      const sorted = [...ps].sort((a, b) => a - b);
      x.lo = sorted[Math.floor(S * 0.1)]; x.hi = sorted[Math.floor(S * 0.9)];
      x.ts = ps[0]; // one committee member's opinion = a Thompson draw
    }
    const learn = by((x) => x.disagree * x.phi);
    while (chosen.length < size - 1) {
      const x = learn.find(okTS);
      if (!x) break;
      chosen.push({ ...x, slot: "learn", why: `Learning: Gandalf's guesses split on this one (${Math.round(x.lo * 100)}–${Math.round(x.hi * 100)}%)` });
    }
    const fav = by((x) => x.ts * x.phi).find(okTS);
    if (fav) chosen.push({ ...fav, slot: "confirm", why: fav.plus ? `Gandalf thinks you liked this — ${featureLabel(fav.plus.f)}` : "Gandalf's best guess for you" });
    return chosen.map(({ row, slot, p, u, why }) => ({ row, slot, p: Math.round(p * 100) / 100, u: Math.round(u * 100) / 100, why }));
  }

  // Genre coverage: how much labelled evidence each genre has; explore the thinnest.
  const genreN = (x) => Math.min(...x.f.filter((f) => f.startsWith("g:")).map((f) => model.stats.get(f)?.n || 0), 99);
  const cold = model.nLabels < 15;
  const plan = cold
    ? ["explore", "probe", "explore", "probe", "confirm"]
    : ["confirm", "probe", "probe", "contrast", "explore"];
  for (const slot of plan) {
    if (chosen.length >= size) break;
    if (slot === "confirm") take(slot, by((x) => x.p * (0.4 + x.phi)), (x) => x.plus ? `Gandalf thinks you liked this — ${featureLabel(x.plus.f)}` : "Gandalf's best guess for you");
    // Expected information ∝ p(1−p): a film the model is torn on teaches the most; a
    // near-certain miss (365 Days at 0.15) teaches nothing.
    if (slot === "probe") take(slot, by((x) => x.p * (1 - x.p) * x.u * x.phi), (x) => probeWhy(model, x));
    // Contrast tests a predicted miss the model is UNSURE of (0.25–0.5), never a sure one.
    if (slot === "contrast") take(slot, by((x) => (x.p >= 0.2 && x.p < 0.5 ? 1 : 0) * x.u * x.phi), (x) => x.minus ? `Gandalf leans no — ${featureLabel(x.minus.f)}. Right?` : "Gandalf leans no. Right?");
    if (slot === "explore") take(slot, by((x) => (x.p >= 0.3 ? 1 : 0) * x.phi / (1 + genreN(x))), (x) => {
      const g = x.f.filter((f) => f.startsWith("g:")).sort((a, b) => (model.stats.get(a)?.n || 0) - (model.stats.get(b)?.n || 0))[0];
      return g ? `Exploring: ${featureLabel(g)}` : "Exploring";
    });
  }
  // Fill any gap (diversity can starve a slot) with the most informative remaining.
  while (chosen.length < size) {
    const before = chosen.length;
    take("probe", by((x) => x.p * (1 - x.p) * x.u * x.phi), () => "Learning something new about your taste");
    if (chosen.length === before) break;
  }
  return chosen.map(({ row, slot, p, u, why }) => ({ row, slot, p: Math.round(p * 100) / 100, u: Math.round(u * 100) / 100, why }));
}

/** Model accuracy over logged batches: did 👍 land on p ≥ .5 and 👎 on p < .5? (meh = .35–.65) */
export function accuracy(batches) {
  let hit = 0, n = 0;
  for (const b of batches) for (const s of b.shown || []) {
    const m = (b.marks || {})[s.tmdb_id];
    if (!m) continue;
    n++;
    if ((m === "up" && s.p >= 0.5) || (m === "down" && s.p < 0.5) || (m === "meh" && s.p >= 0.35 && s.p <= 0.65)) hit++;
  }
  return { hit, n };
}

/** What the model has learned, for Jev's state and for display: strongest features with evidence. */
export function tasteSummary(model, n = 8) {
  const xs = [...model.w].filter(([f]) => (model.stats.get(f)?.n || 0) >= 1.5 || model.priors.has(f))
    .map(([f, v]) => ({ f, v, label: featureLabel(f) }));
  const likes = xs.filter((x) => x.v > 0.15).sort((a, b) => b.v - a.v).slice(0, n).map((x) => x.label);
  const dislikes = xs.filter((x) => x.v < -0.15).sort((a, b) => a.v - b.v).slice(0, n).map((x) => x.label);
  return { likes, dislikes, labels: model.nLabels };
}
