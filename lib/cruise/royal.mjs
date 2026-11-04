// Royal Caribbean cruise-watch extractor — uses the shared RCL Group base.
// Discovered via DevTools network capture, 2026-05-03.

import { createRclGroupExtractor } from "./rcl-group.mjs";

export const fetchSailings = createRclGroupExtractor({
  source: "royal",
  origin: "https://www.royalcaribbean.com",
  brand: "R",
  clientName: "rci-NextGen-Cruise-Search",
  queryName: "cruiseSearch_Cruises",
});

// CLI smoke-test: `node lib/cruise/royal.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const t0 = Date.now();
    const { sailings, total_cruises, pages } = await fetchSailings({
      signal: ctrl.signal,
      maxPages: 3,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(
      `[royal] ${pages} pages, ${total_cruises} total cruises, ${sailings.length} balcony-priced sailings in ${dt}s`,
    );
    if (sailings.length) console.log(JSON.stringify(sailings.slice(0, 2), null, 2));
  } finally {
    clearTimeout(timer);
  }
}
