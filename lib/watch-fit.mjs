// watch-fit.mjs — the one fit gate every watchlist harvester uses (2026-10-10).
//
// Every harvester asks Jev whether a candidate fits before it joins a list, so
// the lists hold only titles the viewers will truly enjoy, not stretches. Code
// gates (ids, ratings, critic floors, fully dropped, genres) run first in each
// harvester; this decides taste fit.
//
// Jev site `watchlist-fit` (kernel definition agent/config/jev-questions/watchlist-fit.json;
// an installation's data/jev-questions/watchlist-fit.json replaces it): one
// boolean per candidate through decide() in jev-shadow.mjs. Legacy — the shadow
// during the site's own week and the fallback below Jev's threshold — is ONE
// batched, tool-less Sonnet judgement over all of the run's candidates (memoized,
// so N candidates cost one Claude call, not N).
//
// Callers: the watch-discover bin (new series + new films) and the back-catalog
// film harvester.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { PARTNER, whoFor, ownerId, ownerName, watchConfig } from "./watch-config.mjs";

const require = createRequire(import.meta.url);
const SITE = "watchlist-fit";
export const WHO = {
  solo: `${whoFor("solo")} alone`,
  together: `${whoFor("together")} together`,
  [PARTNER]: `${whoFor(PARTNER)} alone`,
};

/** The taste profile: the memory page named in config, else the configured fallback. */
export function tasteProfile(memoryDir = null) {
  const cfg = watchConfig();
  const dir = memoryDir || require("./instance.cjs").claudeMemoryDir();
  try {
    return fs.readFileSync(path.join(dir, cfg.taste_profile_page), "utf8").replace(/^---[\s\S]*?---\s*/, "").trim().slice(0, 4000); // lang-regex-ok: strips YAML frontmatter
  } catch {}
  return cfg.taste_profile || "(no taste profile recorded — judge on the ratings and stated preferences)";
}

/**
 * Who rated what, by person id. Per-person ratings come from watch_ratings (the ratings
 * site); older verdicts in watch_feedback carry no person and are listed as shared.
 *
 * A title both of them marked the same way is listed once, under `both` — the site
 * marks them together, so that is nearly every title — and the owner / partner lists hold
 * only the titles where one of them rated it alone or they differ. Lists are kept whole up to
 * LIST_CAP, most recently marked first. The old cap (the last 40 of each person's list, in
 * the arbitrary order the unordered watch_ratings read returns) hid most of their marks
 * from both judges once they marked in bulk: at one 2026-10-10 back-catalog run
 * it kept 40 of 130 likes and dropped all four Harry Potter films, the three Godfathers,
 * GoodFellas and Saving Private Ryan, while the run was judging four Harry Potter
 * entries, three mob films and Schindler's List.
 */
export const LIST_CAP = 400;
export function ratingsDigest({ titles, feedback, ratings = [] }) {
  const name = new Map(titles.map((t) => [t.id, t.name]));
  const byTitle = new Map(); // title_id → { verdicts: {person: verdict}, at }
  for (const r of ratings) {
    if (r.verdict === "not_watched" || !name.has(r.title_id)) continue;
    const e = byTitle.get(r.title_id) || { verdicts: {}, at: "" };
    e.verdicts[r.person] = r.verdict;
    if ((r.updated_at || "") > e.at) e.at = r.updated_at || "";
    byTitle.set(r.title_id, e);
  }
  const me = ownerId();
  const lists = { both: {}, [me]: {}, [PARTNER]: {}, shared: {} };
  const put = (who, verdict, id, at) => { ((lists[who] ||= {})[verdict] ||= new Map()).set(name.get(id), at || ""); };
  for (const [id, { verdicts, at }] of byTitle) {
    const v = Object.values(verdicts);
    if (verdicts[me] && verdicts[PARTNER] && v.every((x) => x === v[0])) put("both", v[0], id, at);
    else for (const [who, verdict] of Object.entries(verdicts)) put(who, verdict, id, at);
  }
  for (const f of feedback) if (f.source !== "web" && name.has(f.title_id)) put("shared", f.verdict, f.title_id, f.created_at);
  const names = (m) => [...m].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, LIST_CAP).map(([n]) => n);
  return Object.fromEntries(Object.entries(lists).map(([who, v]) => [who, Object.fromEntries(Object.entries(v).map(([k, m]) => [k, names(m)]))]));
}

/**
 * Stated preferences per audience, each with the user's own words (`note`) when given.
 * The note is where the caveats live (an exception to a negative weight, say) — so both
 * judges read the exception, not just the bare weight, and a new caveat needs no prompt edit.
 */
export function prefLines(prefs) {
  const one = (p) => `${p.tag} ${p.weight > 0 ? "+" : ""}${p.weight}${p.note ? ` (${String(p.note).slice(0, 300)})` : ""}`;
  const line = (aud) => prefs.filter((p) => p.audience === aud || p.audience === "all").map(one).join("; ") || "(none)";
  return { together: line("together"), solo: line("solo"), [PARTNER]: line(PARTNER) };
}

/** The state Jev reads for one candidate. Exported for tests. */
export function fitState(c, ctx) {
  return {
    for: WHO[c.audience] || WHO.together,
    candidate: {
      title: c.name, kind: c.kind, year: c.year ?? null, genres: c.genres ?? null, language: c.language ?? null,
      synopsis: (c.synopsis || "").slice(0, 900), imdb: c.imdb ?? null, rotten_tomatoes: c.rt ?? null, metacritic: c.metacritic ?? null,
      scout_reason: c.why ?? null,
    },
    taste: { profile: ctx.profile, stated_preferences: ctx.prefs, ...(ctx.learned ? { learned_from_their_marks: ctx.learned } : {}) },
    ...(c.model_p != null ? { model_prediction: { p_like: c.model_p, note: "Jori's taste model (trained on every mark and verdict); a hint, not the answer" } } : {}),
    ratings: ctx.ratings,
  };
}

/**
 * Judge every candidate. cands: [{name, kind, audience, year, genres, language,
 * synopsis, imdb, rt, metacritic, why}]. Returns [{keep, reason, used}] in order.
 * `deps` are test seams: { decide, legacyBatch }.
 */
export async function judgeFit(cands, data, deps = {}) {
  if (!cands.length) return [];
  // data.learned: tasteSummary() of the recommendation model (apps/watch/lib/recsys.mjs), when the caller fitted one.
  const ctx = { profile: tasteProfile(), prefs: prefLines(data.prefs || []), ratings: ratingsDigest(data), learned: data.learned || null };
  const decide = deps.decide || (await import("./jev-shadow.mjs")).decide;
  const { boolOf, answerConfidence, jevSiteDef } = await import("./jev.mjs");
  const def = jevSiteDef(SITE) || {};
  let memo = null;
  const legacyAll = () => (memo ||= (deps.legacyBatch || legacyBatch)(cands, ctx));
  const out = [];
  for (const [i, c] of cands.entries()) {
    try {
      const r = await decide({
        site: SITE,
        id: c.name,
        state: fitState(c, ctx),
        interpret: (answers) => {
          const a = answers.truly_enjoy;
          const b = boolOf(a);
          if (b === null) throw new Error("jev: no truly_enjoy answer");
          return { value: b ? "keep" : "drop", confidence: answerConfidence(a) };
        },
        legacy: () => legacyAll().then((m) => m.get(i)?.decision || "drop"),
        same: (j, l) => j === l,
        logInput: { title: c.name, for: c.audience },
        alwaysShadow: !!(def.shadow_until && Date.now() < Date.parse(def.shadow_until)),
      });
      const reason = r.used === "jev" ? `jev ${r.value}` : (await legacyAll().catch(() => new Map())).get(i)?.reason || r.reason || "";
      out.push({ keep: r.value === "keep", reason, used: r.used });
    } catch (e) {
      // Fails closed: an unjudged title is exactly how a stretch gets in.
      out.push({ keep: false, reason: `fit gate unavailable (${String(e.message).slice(0, 80)})`, used: "none" });
    }
  }
  return out;
}

/** Legacy: one tool-less Sonnet call over the whole batch → Map(i → {decision, reason}). */
export async function legacyBatch(cands, ctx) {
  const { runToolless, parseModelJson } = await import("./jev-claude.mjs");
  const { MODELS } = require("./models.cjs");
  const both = whoFor("together");
  const rules = [].concat(watchConfig().fit_rules || []).filter(Boolean).map((r) => `- ${r}`).join("\n");
  const prompt = `You are the last check before titles join the watch lists ${ownerName()} keeps with ${whoFor(PARTNER)}. Be strict: the lists must hold only titles they will truly enjoy.

Taste profile:
---
${ctx.profile}
---
Stated preferences: ${JSON.stringify(ctx.prefs)}
What their own marks have taught Jori's taste model: ${JSON.stringify(ctx.learned || "(not available)")}
How each of them rated things they've watched (by person id): ${JSON.stringify(ctx.ratings)}

Candidates:
${JSON.stringify(cands.map((c, i) => ({ i, ...fitState(c, ctx).candidate, for: WHO[c.audience] || WHO.together })), null, 1)}

"keep" ONLY a clear, confident match for whoever "for" names — for "${both} together", both. "drop" anything that is a stretch, a gamble, mixed or polarizing reviews, a network procedural or case-of-the-week, soapy, teen-centred, campy, gory, romance or relationship-centred, children's/family fare, close to things they disliked, or only loosely related to what they loved.${rules ? `\n${rules}` : ""}

Output ONE JSON object, no prose: {"verdicts":[{"i":0,"decision":"keep|drop","reason":"one short line"}]}`;
  const parsed = parseModelJson(await runToolless({ model: MODELS.sonnet, prompt, timeoutMs: 300000 }));
  if (!parsed?.verdicts) throw new Error("legacy fit judge returned no verdicts");
  return new Map(parsed.verdicts.map((v) => [v.i, v]));
}
