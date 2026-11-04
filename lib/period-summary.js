"use strict";
// period-summary — the deterministic half of weekly-summary / monthly-summary.
//
// Both jobs used to be an agent turn on the heavy tier that ran the
// SQL, computed medians/totals/distinct places by hand, ESTIMATED home vs away
// nights "from sleep_at location patterns", built the HTML, upserted and
// emailed. Only the narrative is language. Code now does everything else:
//
//   windows()      the week/month that just ended, on the user's LOCAL calendar
//                  (local-day), not a fixed home zone
//   stats()        exact aggregates from daily_summaries rows
//   nights()       home/away nights from the travel timeline (presence.js),
//                  the single source of truth for where the user slept
//   validate()     the model's {narrative, themes[]} reply, schema-checked
//   renderHtml()   the email
//
// bin/period-summary wires these to Supabase + email-send.

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** @param {"weekly"|"monthly"} kind  @param {string} today local YYYY-MM-DD */
function windows(kind, today) {
  if (kind === "weekly") {
    // Runs Monday: the week that just ended is Mon..Sun before today.
    const end = addDays(today, -1);
    return { kind, start: addDays(end, -6), end };
  }
  if (kind === "monthly") {
    const firstThis = `${today.slice(0, 7)}-01`;
    const end = addDays(firstThis, -1);
    return { kind, start: `${end.slice(0, 7)}-01`, end };
  }
  throw new Error(`unknown kind ${kind}`);
}

function datesBetween(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const toMin = (hhmm) => {
  if (typeof hhmm !== "string" || !hhmm.includes(":")) return null; // HH:MM stamp
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const fromMin = (m) => (m == null ? null : `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`);

function median(nums) {
  const a = nums.filter((n) => n != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Sleep times after midnight sort after late-evening ones (00:30 > 23:30). */
function sleepMin(hhmm) {
  const m = toMin(hhmm);
  return m != null && m < 12 * 60 ? m + 24 * 60 : m;
}

function stats(rows, window) {
  const all = datesBetween(window.start, window.end);
  const have = new Set(rows.map((r) => r.date));
  const places = new Set();
  for (const r of rows) {
    for (const e of Array.isArray(r.key_events) ? r.key_events : []) {
      if (e && typeof e === "object" && e.place) places.add(String(e.place).trim());
    }
  }
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  return {
    days_in_window: all.length,
    days_with_data: rows.length,
    missing_dates: all.filter((d) => !have.has(d)),
    median_wake: fromMin(median(rows.map((r) => toMin(r.wake_at)))),
    median_sleep: fromMin(median(rows.map((r) => sleepMin(r.sleep_at)))),
    total_commits: sum("commits_count"),
    total_messages: sum("messages_count"),
    total_photos: sum("photos_count"),
    total_place_visits: sum("places_count"),
    distinct_named_places: places.size,
  };
}

/**
 * Home vs away nights from the travel timeline. `where(date)` returns a
 * presence result ({metro, ambiguous, candidates}) for the night of `date`.
 */
async function nights(window, where, homeMetros) {
  let home = 0, away = 0, unknown = 0;
  const awayMetros = {};
  for (const d of datesBetween(window.start, window.end)) {
    let r;
    try { r = await where(`${d}T23:00`); } catch { r = null; }
    if (!r || (!r.metro && !r.ambiguous)) { unknown++; continue; }
    const cands = r.ambiguous ? r.candidates || [] : [r.metro];
    if (cands.length && cands.every((m) => homeMetros.has(m))) home++;
    else { away++; const k = cands.join("/"); awayMetros[k] = (awayMetros[k] || 0) + 1; }
  }
  return { home, away, unknown, away_metros: awayMetros };
}

const LIMITS = { weekly: { themes: [3, 6], words: [250, 900] }, monthly: { themes: [5, 8], words: [400, 1300] } };

/** Returns {ok, value?, problems[]}. Structure only — no reading of the prose. */
function validate(kind, reply) {
  const problems = [];
  const lim = LIMITS[kind];
  if (!reply || typeof reply !== "object") return { ok: false, problems: ["reply is not a JSON object"] };
  const narrative = typeof reply.narrative === "string" ? reply.narrative.trim() : "";
  const themes = Array.isArray(reply.themes) ? reply.themes.map((t) => String(t).trim()).filter(Boolean) : null;
  const words = narrative ? narrative.split(/\s+/).length : 0; // lang-regex-ok: whitespace word count, no interpretation
  if (!narrative) problems.push("narrative missing");
  else if (words < lim.words[0] || words > lim.words[1]) problems.push(`narrative is ${words} words (want ${lim.words[0]}-${lim.words[1]})`);
  if (!themes) problems.push("themes missing");
  else if (themes.length < lim.themes[0] || themes.length > lim.themes[1]) problems.push(`${themes.length} themes (want ${lim.themes[0]}-${lim.themes[1]})`);
  return { ok: problems.length === 0, value: { narrative, themes: themes || [] }, problems };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); // lang-regex-ok: HTML escape

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtDay = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

function subject(window) {
  if (window.kind === "weekly") return `Week of ${fmtDay(window.start)}–${fmtDay(window.end)} ${window.end.slice(0, 4)}`;
  return `Month of ${MONTHS[Number(window.start.slice(5, 7)) - 1]} ${window.start.slice(0, 4)}`;
}

function renderHtml(window, st, nt, value) {
  const paras = value.narrative.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join("\n"); // lang-regex-ok: paragraph split on blank lines
  const statRow = (k, v) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${k}</td><td>${esc(v)}</td></tr>`;
  const statsBlock = window.kind === "monthly" ? `<table style="font-size:13px;margin:8px 0 16px">
${statRow("Days with data", `${st.days_with_data} of ${st.days_in_window}`)}
${statRow("Typical wake / sleep", `${st.median_wake || "—"} / ${st.median_sleep || "—"}`)}
${statRow("Nights home / away", `${nt.home} / ${nt.away}${nt.unknown ? ` (${nt.unknown} unknown)` : ""}`)}
${statRow("Commits", st.total_commits)}
${statRow("Distinct places", st.distinct_named_places)}
${statRow("Photos", st.total_photos)}
</table>` : "";
  const themes = value.themes.length ? `<p style="font-size:13px;color:#666">Themes: ${value.themes.map(esc).join(" · ")}</p>` : "";
  return `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:640px;line-height:1.5;color:#222">
<h2 style="font-weight:600">${esc(subject(window))}</h2>
${statsBlock}
${paras}
${themes}
</div>`;
}

module.exports = { addDays, windows, datesBetween, stats, nights, validate, renderHtml, subject, median, LIMITS };
