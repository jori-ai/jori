// TripIt API client helpers.
//
// Uses the official v1 API with JSON responses. The public docs support
// both OAuth and a basic-auth testing mode; this helper is designed around
// basic auth because it is simple to automate for local imports.

"use strict";

const https = require("node:https");
const zlib = require("node:zlib");

const DEFAULT_BASE_URL = "https://api.tripit.com/v1";

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function basicAuthHeader(user, password) {
  if (!user || !password) {
    throw new Error("TripIt auth requires both user and password");
  }
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

function requestJson(url, { user, password, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "User-Agent": "jori-tripit-import/1.0",
          ...(user && password ? { Authorization: basicAuthHeader(user, password) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const rawBuffer = Buffer.concat(chunks);
          let decoded = rawBuffer;
          const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
          try {
            if (encoding.includes("gzip")) decoded = zlib.gunzipSync(rawBuffer);
            else if (encoding.includes("deflate")) decoded = zlib.inflateSync(rawBuffer);
            else if (encoding.includes("br")) decoded = zlib.brotliDecompressSync(rawBuffer);
          } catch (err) {
            err.message = `TripIt API decompression failed for ${url}: ${err.message}`;
            return reject(err);
          }
          const raw = decoded.toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`TripIt API ${res.statusCode} for ${url}: ${raw.slice(0, 500)}`);
            err.statusCode = res.statusCode;
            err.body = raw;
            return reject(err);
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            err.message = `TripIt API JSON parse failed for ${url}: ${err.message}`;
            err.body = raw;
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function buildUrl(pathname, params = {}, baseUrl = DEFAULT_BASE_URL) {
  const url = new URL(baseUrl.replace(/\/$/, "") + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url;
}

function normalizeResponse(payload) {
  const root = payload?.Response || payload || {};
  const trip = root.Trip || root.trip || null;
  return { root, trip };
}

async function listTrips({
  user,
  password,
  past = true,
  traveler = "all",
  includeObjects = true,
  pageNum = 1,
  pageSize = 100,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  const url = buildUrl(
    `/list/trip/past/${past ? "true" : "false"}/traveler/${traveler}`,
    {
      format: "json",
      include_objects: includeObjects ? "true" : "false",
      page_num: pageNum,
      page_size: pageSize,
    },
    baseUrl,
  );
  const payload = await requestJson(url, { user, password });
  const { root } = normalizeResponse(payload);
  return {
    raw: payload,
    root,
    trips: asArray(root.Trip || root.trip),
    pageNum: Number(root.page_num || pageNum),
    pageSize: Number(root.page_size || pageSize),
    maxPage: Number(root.max_page || 1),
    timestamp: root.timestamp || null,
  };
}

async function getTrip({
  user,
  password,
  tripId,
  includeObjects = true,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  if (!tripId) throw new Error("getTrip requires tripId");
  const url = buildUrl(
    `/get/trip/id/${tripId}`,
    {
      format: "json",
      include_objects: includeObjects ? "true" : "false",
    },
    baseUrl,
  );
  const payload = await requestJson(url, { user, password });
  const { root, trip } = normalizeResponse(payload);
  return { raw: payload, root, trip };
}

async function listObjectsForTrip({
  user,
  password,
  tripId,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  if (!tripId) throw new Error("listObjectsForTrip requires tripId");
  const url = buildUrl(
    `/list/object/trip_id/${tripId}`,
    { format: "json" },
    baseUrl,
  );
  const payload = await requestJson(url, { user, password });
  const { root } = normalizeResponse(payload);
  return {
    raw: payload,
    root,
    objects: root.object || root.Object || root.objects || null,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  asArray,
  buildUrl,
  getTrip,
  listObjectsForTrip,
  listTrips,
  normalizeResponse,
  requestJson,
};
