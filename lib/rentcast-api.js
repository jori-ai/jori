"use strict";
// rentcast-api.js — minimal READ-ONLY client for RentCast property valuations.
//
// WHY: real estate rarely reports its own value the way brokerage and bank
// accounts do, so counting it in net worth needs an AVM.
//
// READ-ONLY, structurally: one GET-only transport. There is nothing to write
// to at RentCast anyway, but the shape is kept so the financial clients all
// read the same way.
//
// METERED — this is the part that makes it different from every other client
// here. The free tier is 50 requests/month and a request is spent whether or not
// the answer is useful, so the caller is expected to budget: see
// `bin/property-values`, which refuses to exceed a per-run cap and tracks
// monthly usage. Do NOT add a retry loop; a failed call has already been paid
// for and retrying it just spends the next one.
//
// Env (.env): RENTCAST_API_KEY.

const { loadEnv } = require("./load-env.js");
loadEnv();

const BASE_URL = "https://api.rentcast.io/v1";

function apiKey() {
  const k = process.env.RENTCAST_API_KEY;
  if (!k) {
    throw new Error(
      "RENTCAST_API_KEY missing — set it in .env (keep the canonical copy in " +
        "your password manager). Free tier: 50 requests/month, sign up at rentcast.io/api."
    );
  }
  return k;
}

/** The only transport. GET-only by construction. */
async function get(path, params = {}, { timeoutMs = 30000 } = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== "")
  ).toString();
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-Api-Key": apiKey(), Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || text.slice(0, 300);
    const err = new Error(`RentCast GET ${path}: HTTP ${res.status} — ${msg}`);
    err.status = res.status;
    err.rentcast = data;
    throw err;
  }
  return data;
}

/** True when the key is missing, invalid, or the monthly quota is exhausted. */
function isQuotaOrAuthError(err) {
  return err && (err.status === 401 || err.status === 402 || err.status === 429);
}

/**
 * Current market value for one address. Costs ONE metered request.
 *
 * `lookupSubjectAttributes` defaults to true at RentCast, which lets it fill in
 * bedrooms/bathrooms/sqft from its own property records — worth having, since we
 * hold none of those and a comp set built without them is noticeably worse.
 *
 * Returns `{ price, priceRangeLow, priceRangeHigh, subjectProperty, comparables }`.
 */
async function valueEstimate({ address, propertyType, compCount = 15 }) {
  return get("/avm/value", { address, propertyType, compCount });
}

/** Long-term rent estimate for one address. Costs ONE metered request. */
async function rentEstimate({ address, propertyType, compCount = 15 }) {
  return get("/avm/rent/long-term", { address, propertyType, compCount });
}

module.exports = { get, valueEstimate, rentEstimate, isQuotaOrAuthError, BASE_URL };
