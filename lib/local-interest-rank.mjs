// local-interest-rank.mjs — rank Places rows for LOCAL INTEREST, which is not
// what Google ranks for. Moved out of the old nearby harvester (2026-10-20)
// when venue picks became ask-first; bin/meal-pick is the caller now.
//
// Google sorts with popularity as a POSITIVE term, so a spot with 30,000
// reviews outscores one with 100 before distance is considered. This ranks the
// other way: heavy review counts in a visitor-heavy area are a red flag (the
// tourist strip), and neighbourhood places come first. The tourist penalty is
// RELATIVE to the set's own median, so it calibrates per neighbourhood.
// Quality is a floor (4.2★ earns full credit), not a ranking signal.
// Pure.

export function rankLocalInterest(rows) {
  const counts = rows.map((r) => Number(r.ratingCount) || 0).filter((n) => n > 0).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  return rows
    .map((r) => {
      const rating = Number(r.rating) || 0;
      const count = Number(r.ratingCount) || 0;
      const dist = Number(r.distance) || 0;
      const qualityOk = rating >= 4.2 ? 1 : rating >= 4.0 ? 0.5 : 0;
      const ratio = median > 0 ? count / median : 1;
      const touristPenalty = ratio <= 1 ? 0 : Math.min(3, Math.log2(ratio) * 1.2);
      const thin = count > 0 && count < 15 ? -0.8 : 0;
      const proximity = Math.max(0, 2 - (dist / 400));
      const openBonus = r.isOpen === true ? 0.8 : 0;
      const tagged = r.marker ? 2 : 0;
      return { ...r, _local: tagged + qualityOk * 1.5 + proximity + openBonus + thin - touristPenalty,
               _tourist_ratio: Number(ratio.toFixed(2)) };
    })
    .sort((a, b) => b._local - a._local);
}
