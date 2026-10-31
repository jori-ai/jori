"use strict";
// firestore-rest — read-only Firestore access for a service account, over REST.
//
// Jori reads a rental portfolio's books (properties, tenants, leases, the
// categorised ledger) that live in a Firebase project this repo has no SDK
// for. `firebase-admin` would be ~40MB of dependency and a second auth
// stack for what is three HTTP calls: mint a JWT, exchange it for an access
// token, GET documents. So this is the whole client.
//
// READ-ONLY BY CONSTRUCTION. The scope requested is `datastore`, but nothing
// here can write — there is no POST/PATCH/DELETE path in this file, and a
// ledger read this way is a book of record whose only authors are its own
// sync, its classifier and its admin. A jori that could write to it would be a
// fifth author nobody designed for.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { localConfig } = require("./instance.cjs");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/datastore";

// Where the service-account key is looked for: an env var naming the key file,
// then the key paths an installation lists (agent/local/config/firestore.json:
// `env_var`, `credential_paths`, `~` = home). No key configured anywhere means
// no Firestore reader on this installation, and the constructor says so.
const config = () => localConfig("firestore", { env_var: "FIREBASE_SA", credential_paths: [] });

/** Where a service-account JSON is looked for, in order. */
function credentialPaths(envVar) {
  const out = [];
  if (process.env[envVar]) out.push(process.env[envVar]);
  for (const p of config().credential_paths || []) out.push(String(p).replace(/^~(?=\/|$)/, os.homedir()));
  out.push(path.join(os.homedir(), ".config", "jori", "firebase-sa.json"));
  return out;
}

function loadServiceAccount(envVar = config().env_var || "FIREBASE_SA") {
  for (const p of credentialPaths(envVar)) {
    try {
      const raw = fs.readFileSync(p.replace(/^~/, os.homedir()), "utf8");
      const sa = JSON.parse(raw);
      if (sa.client_email && sa.private_key) return sa;
    } catch {
      // Try the next candidate — a missing file here is normal.
    }
  }
  throw new Error(
    `No Firebase service account found. Looked at: ${credentialPaths(envVar).join(", ")}. ` +
    `Set ${envVar} to the JSON key path.`
  );
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/**
 * Access tokens last an hour and cost a round trip. A CLI invoked twice in one
 * answer should not mint two, so the token is cached on disk with its expiry —
 * 0600, in the user's cache dir, never in the repo.
 */
function tokenCachePath(clientEmail) {
  const key = crypto.createHash("sha256").update(clientEmail).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `jori-fs-token-${key}.json`);
}

function readCachedToken(clientEmail) {
  try {
    const c = JSON.parse(fs.readFileSync(tokenCachePath(clientEmail), "utf8"));
    // 60s of slack: a token that expires mid-request is a confusing 401.
    if (c.token && c.expiresAt > Date.now() + 60_000) return c.token;
  } catch { /* no cache yet */ }
  return null;
}

function writeCachedToken(clientEmail, token, expiresInSec) {
  try {
    fs.writeFileSync(
      tokenCachePath(clientEmail),
      JSON.stringify({ token, expiresAt: Date.now() + expiresInSec * 1000 }),
      { mode: 0o600 }
    );
  } catch { /* cache is an optimisation, never a requirement */ }
}

async function getAccessToken(sa) {
  const cached = readCachedToken(sa.client_email);
  if (cached) return cached;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signature = b64url(
    crypto.createSign("RSA-SHA256").update(`${header}.${claim}`).sign(sa.private_key)
  );
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token exchange failed (${res.status}): ${body.error_description || body.error || "no token"}`);
  }
  writeCachedToken(sa.client_email, body.access_token, body.expires_in || 3600);
  return body.access_token;
}

// ── Value coding ────────────────────────────────────────────────────────────
// Firestore REST speaks a tagged-union value format. Everything below turns it
// back into ordinary JS, and a query filter into it.

function decodeValue(v) {
  if (v == null) return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;   // ISO 8601 string
  if ("bytesValue" in v) return v.bytesValue;
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return v.geoPointValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}

function decodeDoc(doc) {
  if (!doc || !doc.name) return null;
  return { id: doc.name.split("/").pop(), ...decodeFields(doc.fields) };
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  return { stringValue: String(v) };
}

// ── The client ──────────────────────────────────────────────────────────────

class FirestoreClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.projectId]   defaults to the service account's project
   * @param {string} [opts.envVar]      env var naming the key file
   */
  constructor({ projectId, envVar } = {}) {
    this.sa = loadServiceAccount(envVar);
    this.projectId = projectId || this.sa.project_id;
    this.base = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents`;
  }

  async #request(url, init = {}) {
    const token = await getAccessToken(this.sa);
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      throw new Error(`Firestore: ${msg}`);
    }
    return body;
  }

  /** One document, or null when it does not exist. */
  async get(collection, id) {
    try {
      return decodeDoc(await this.#request(`${this.base}/${collection}/${encodeURIComponent(id)}`));
    } catch (err) {
      if (err.message.includes("NOT_FOUND") || err.message.includes("HTTP 404")) return null;
      throw err;
    }
  }

  /**
   * Every document in a collection, paging until Firestore stops.
   * @param {string} collection
   * @param {object} [opts] {pageSize, limit}
   */
  async list(collection, { pageSize = 300, limit = Infinity } = {}) {
    const out = [];
    let pageToken;
    do {
      const qs = new URLSearchParams({ pageSize: String(Math.min(pageSize, 300)) });
      if (pageToken) qs.set("pageToken", pageToken);
      const body = await this.#request(`${this.base}/${collection}?${qs}`);
      for (const d of body.documents || []) {
        out.push(decodeDoc(d));
        if (out.length >= limit) return out;
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  /**
   * A structured query against one collection.
   *
   * @param {string} collection
   * @param {object} [opts]
   * @param {Array<[string,string,any]>} [opts.where]  e.g. [["fiscalYear","EQUAL",2025]]
   * @param {Array<[string,('ASCENDING'|'DESCENDING')]>} [opts.orderBy]
   * @param {number} [opts.limit]
   */
  async query(collection, { where = [], orderBy = [], limit } = {}) {
    const filters = where.map(([field, op, value]) => ({
      fieldFilter: { field: { fieldPath: field }, op, value: encodeValue(value) },
    }));
    const structuredQuery = { from: [{ collectionId: collection }] };
    if (filters.length === 1) structuredQuery.where = filters[0];
    else if (filters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters } };
    if (orderBy.length) {
      structuredQuery.orderBy = orderBy.map(([field, direction]) => ({
        field: { fieldPath: field }, direction: direction || "ASCENDING",
      }));
    }
    if (limit) structuredQuery.limit = limit;

    const body = await this.#request(`${this.base}:runQuery`, {
      method: "POST",
      body: JSON.stringify({ structuredQuery }),
    });
    return (body || []).filter((r) => r.document).map((r) => decodeDoc(r.document));
  }
}

module.exports = { FirestoreClient, decodeDoc, decodeFields, loadServiceAccount };
