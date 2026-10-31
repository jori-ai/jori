// Real Sea Terrace (balcony) fares for Virgin Voyages.
//
// WHY THIS EXISTS. Virgin's search payload publishes exactly ONE price per
// sailing — the cheapest cabin — plus a code saying which cabin that is. On
// 2026-09-01 that was INSIDER for 91.5% of 458 sailings, SEA VIEW for 7.0% and
// SEA TERRACE (their balcony) for 0.9%. So the extractor could record a balcony
// fare for 4 sailings and had to leave 449 unpriced, which is why Virgin was
// effectively absent from the browsing site: 6 of 453 priced, against 100% for
// every other line.
//
// WHY NOT APPROXIMATE. The question (2026-09-01) was whether the balcony price
// could be estimated from the published one. Measured over a 23-voyage sample
// spread across all four ships, five trip lengths and a range of months:
//
//   Sea Terrace / Insider   n=19  mean 1.247  sd 0.153  range 0.906–1.465
//   Sea Terrace / Sea View  n=20  mean 1.194  sd 0.054  range 1.067–1.300
//
// Multiplying the Insider fare by the mean ratio misses the real Sea Terrace
// fare by a MEDIAN of 10.8%, up to 37.6%, and is off by more than 10% on 10 of
// 19 sailings. The watchlist alerts on a 10% drop, so an estimate with a
// double-digit typical error would manufacture false alerts on its own noise —
// the estimate would be indistinguishable from the signal it exists to detect.
// The Sea View ratio is tight enough to be usable, but only 7% of sailings
// publish a Sea View price, so it cannot carry the line.
//
// So: no estimate. The same page render that produced those ratios also carries
// the true Sea Terrace fare, so we read the real number instead of guessing at
// it. A bare fetch will NOT do — it returns a generic cached variant of the
// page (the same $1,014 for two unrelated packages, where real renders of those
// voyages give $836 and $756), so the price only appears once the page's own JS
// has run. Hence headless Chrome.
//
// This runs BEFORE the upsert, enriching the extractor's rows in place, because
// the upsert is what computes price deltas — writing prices afterwards would
// leave every Virgin sailing looking like it changed price every week.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SITE = "https://www.virginvoyages.com";

/** Read one cabin grade's lead fare out of a rendered voyage page. */
function priceFor(text, grade) {
  // The page prints "Sea Terrace From $756 $1,051 per Sailor" — the first
  // number is what you pay, the second is the struck-through original.
  const m = text.match(new RegExp(`${grade}\\s*From\\s*\\$([\\d,]+)`, "i"));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function renderVoyage(packageCode, voyageId, { timeoutMs }) {
  const url = `${SITE}/book/voyage-planner/fullCruiseDetails`
    + `?currencyCode=USD&packageCode=${encodeURIComponent(packageCode)}&voyageId=${encodeURIComponent(voyageId)}`;
  // A throwaway profile per render: without --user-data-dir headless Chrome
  // leaks a scoped_dir profile + cache under ~/Library on every call.
  const profile = await mkdtemp(join(tmpdir(), "virgin-chrome-"));
  let stdout;
  try {
    ({ stdout } = await run(
      CHROME,
      ["--headless", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`,
        `--disk-cache-dir=${profile}/cache`, "--virtual-time-budget=13000", "--dump-dom", url],
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
    ));
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
  return stdout.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
}

/**
 * Fill `lowest_balcony_per_person_usd` on Virgin sailings that lack one.
 *
 * Mutates and returns the same array. A sailing whose page fails to render, or
 * whose page has no Sea Terrace grade (sold out at that grade), is left unpriced
 * — exactly as before — rather than given a guess.
 *
 * @param {object[]} sailings   rows from virgin.mjs
 * @param {object}   opts
 * @param {number}   opts.concurrency  parallel Chrome renders (default 4)
 * @param {number}   opts.limit        cap for a smoke test (default all)
 * @param {number}   opts.timeoutMs    per render (default 60s)
 * @param {function} opts.onProgress   (done, total, priced) => void
 */
export async function enrichVirginPrices(sailings, opts = {}) {
  const { concurrency = 4, limit = Infinity, timeoutMs = 60_000, onProgress } = opts;

  const todo = sailings
    .filter((s) => s.source === "virgin"
      && (s.lowest_balcony_per_person_usd === null || s.lowest_balcony_per_person_usd === undefined)
      && s.cruise_id)
    .slice(0, limit);

  let done = 0;
  let priced = 0;
  let failed = 0;

  async function work(s) {
    const voyageId = String(s.sailing_id).replace(/^virgin:/, "");
    try {
      const text = await renderVoyage(s.cruise_id, voyageId, { timeoutMs });
      const terrace = priceFor(text, "Sea Terrace");
      if (terrace !== null) {
        s.lowest_balcony_per_person_usd = terrace;
        // Virgin quotes per Sailor and taxes are inside `amount`, which is the
        // same basis the rest of the corpus uses.
        s.taxes_fees_included = true;
        s.balcony_price_source = "voyage-page";
        priced++;
      }
    } catch {
      failed++;
    } finally {
      done++;
      if (onProgress) onProgress(done, todo.length, priced);
    }
  }

  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.allSettled(todo.slice(i, i + concurrency).map(work));
  }
  return { attempted: todo.length, priced, failed };
}

export { priceFor as __priceFor };
