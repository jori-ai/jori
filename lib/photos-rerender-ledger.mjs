// photos-rerender-ledger — decides how to repair a `stale_render` date (photos
// landed after the day page was rendered). Replaces the photos-daily agent's
// `ls data/jobs | grep day-rerender-<date>` judgment, which is what let
// 2026-07-10 be re-sent in full three nights running (2026-08-19..21).
//
// Ladder per date, within a 7-day window:
//   no prior attempt        → "normal"  (daily-summary-run <date>)
//   one prior attempt       → "silent"  (daily-summary-run <date> SILENT — fixes
//                                        data without re-sending the email)
//   two+ prior attempts     → "give-up" once (alert system channel: render/
//                                        publish needs a code-level look)
//   already gave up         → "skip"

export const WINDOW_MS = 7 * 86400_000;

export function plan(ledger, dates, now = Date.now()) {
  const out = [];
  const next = { dates: { ...(ledger?.dates || {}) } };
  for (const date of dates) {
    const rec = next.dates[date] || { attempts: [], gave_up_at: null };
    const recent = (rec.attempts || []).filter((t) => now - Date.parse(t) <= WINDOW_MS);
    let mode;
    if (rec.gave_up_at && now - Date.parse(rec.gave_up_at) <= WINDOW_MS) mode = "skip";
    else if (recent.length === 0) mode = "normal";
    else if (recent.length === 1) mode = "silent";
    else mode = "give-up";
    const iso = new Date(now).toISOString();
    if (mode === "normal" || mode === "silent") rec.attempts = [...recent, iso];
    else rec.attempts = recent;
    if (mode === "give-up") rec.gave_up_at = iso;
    next.dates[date] = rec;
    out.push({ date, mode });
  }
  // Forget dates with nothing in the window.
  for (const [d, rec] of Object.entries(next.dates)) {
    const live = (rec.attempts || []).some((t) => now - Date.parse(t) <= WINDOW_MS)
      || (rec.gave_up_at && now - Date.parse(rec.gave_up_at) <= WINDOW_MS);
    if (!live) delete next.dates[d];
  }
  return { plan: out, ledger: next };
}
