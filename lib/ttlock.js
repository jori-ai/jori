"use strict";
// ttlock — a read-only TTLock Cloud (v3) client, for watching lock health.
//
// WHY READ-ONLY, AND WHY NO TOKEN OF ITS OWN. The portfolio's hub already owns
// the TTLock integration: it issues and revokes tenant codes, and it keeps the
// one OAuth token in its Firestore (the doc named by lock-health.json
// `ttlock.token_doc`), refreshing it before it expires. A refresh rotates the
// refresh token, so a second refresher here would sooner or later strand the
// hub with a dead one — and a fresh password grant could invalidate the
// token the hub is using mid-lease. So this client borrows the hub's current
// access token, read-only, and never mints, refreshes or stores one. When that
// token is missing or expired it says so and stops; the hub refreshes it on
// its next call (its battery cron alone runs daily).
//
// Nothing here can change a lock: there is no add/change/delete path in this
// file. `queryOpenState` asks the gateway to reach the lock, which is the only
// way to learn the lock is reachable before a code is pushed to it.
//
// Every call needs the app's clientId (the .env variable named by
// lock-health.json `ttlock.client_id_env`; not a secret on its own, but kept
// with the credentials) plus the token and a ms `date`.

const DEFAULT_BASE = "https://euapi.sciener.com";

/** TTLock's error codes this tool tells apart. Anything else is shown with TTLock's own message. */
const ERR = {
  NOT_CONNECTED_TO_GATEWAY: -2012, // "The Device is not connected to any Gateway" — lock out of range or dead
  GATEWAY_BUSY: -3003,             // "The gateway is busy" — what four codes hit at once on 2026-10-31
};

class TTLockError extends Error {
  constructor(path, errcode, errmsg) {
    super(`TTLock ${path} error ${errcode}: ${errmsg || "unknown"}`);
    this.errcode = errcode;
    this.errmsg = errmsg || "";
  }
}

class TTLockClient {
  /**
   * @param {object} o
   * @param {string} o.clientId
   * @param {string} o.accessToken
   * @param {string} [o.base]
   * @param {Function} [o.fetchImpl]  tests inject one
   */
  constructor({ clientId, accessToken, base, fetchImpl } = {}) {
    if (!clientId) throw new Error("TTLock: no clientId");
    if (!accessToken) throw new Error("TTLock: no access token");
    this.clientId = clientId;
    this.accessToken = accessToken;
    this.base = (base || DEFAULT_BASE).replace(/\/+$/, "");
    this.fetch = fetchImpl || fetch;
  }

  async post(path, params = {}) {
    const body = new URLSearchParams();
    const all = { clientId: this.clientId, accessToken: this.accessToken, date: Date.now(), ...params };
    for (const [k, v] of Object.entries(all)) body.set(k, String(v));
    const res = await this.fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`TTLock ${path} HTTP ${res.status}`);
    const data = await res.json();
    if (data && typeof data.errcode === "number" && data.errcode !== 0) throw new TTLockError(path, data.errcode, data.errmsg);
    return data || {};
  }

  async listLocks() {
    return (await this.post("/v3/lock/list", { pageNo: 1, pageSize: 200 })).list || [];
  }

  async listGateways() {
    return (await this.post("/v3/gateway/list", { pageNo: 1, pageSize: 200 })).list || [];
  }

  /** The gateways a lock is paired with (no isOnline here; join with listGateways). */
  async gatewaysForLock(lockId) {
    return (await this.post("/v3/gateway/listByLock", { lockId })).list || [];
  }

  /** A live round trip: cloud → gateway → lock. Resolves with the lock's state; rejects with a TTLockError. */
  async queryOpenState(lockId) {
    return (await this.post("/v3/lock/queryOpenState", { lockId })).state;
  }

  /** The lock's own records (unlocks and the rest) between two instants. */
  async lockRecords(lockId, startMs, endMs) {
    return (await this.post("/v3/lockRecord/list", { lockId, startDate: startMs, endDate: endMs, pageNo: 1, pageSize: 50 })).list || [];
  }
}

/**
 * The hub's current access token from its Firestore token doc, or why there
 * isn't a usable one. `db` is a lib/firestore-rest client; `docPath` is
 * "collection/doc".
 */
async function borrowedToken(db, docPath, nowMs = Date.now()) {
  const [col, id] = String(docPath || "").split("/");
  if (!col || !id) return { error: "no token doc configured (lock-health.json ttlock.token_doc)" };
  const doc = await db.get(col, id);
  if (!doc || !doc.accessToken) return { error: `no TTLock token in ${docPath}` };
  const expiresAt = Number(doc.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
    return { error: `the hub's TTLock token expired ${new Date(expiresAt).toISOString()} and has not been refreshed` };
  }
  return { accessToken: doc.accessToken, expiresAt };
}

module.exports = { TTLockClient, TTLockError, ERR, DEFAULT_BASE, borrowedToken };
