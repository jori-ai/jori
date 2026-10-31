"use strict";
// awardwallet-api.js — minimal READ-ONLY client for the AwardWallet Business
// "Account Access" API (https://awardwallet.com/api/account).
//
// AwardWallet already logs into every airline / hotel / card program on its own
// schedule; this just reads what it holds. GET-only: there is one transport
// function and it carries no body.
//
// Auth: `X-Authentication: <key>` — AWARDWALLET_API_KEY in .env (no key = the
// capability is off: every call throws code NOT_CONFIGURED).
// The key is IP-WHITELISTED in the AwardWallet Business profile (API settings).
// A new egress IP answers 403 {"code":"IP_DENIED"} — that is a whitelist
// problem, not a bad key. Repeated auth failures can lock the IP out, so a
// failure is never retried in a loop.
//
// Rate limit: 20 requests / rolling 10 min PER id on the /{id} routes. One
// weekly run reads each user once, so the only way to hit it is a burst of
// manual refreshes.

const { loadEnv } = require("./load-env.js");
loadEnv();

const BASE_URL = "https://business.awardwallet.com/api/export/v2";

class AwardWalletError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function get(path) {
  const key = process.env.AWARDWALLET_API_KEY;
  if (!key) {
    throw new AwardWalletError(
      "AWARDWALLET_API_KEY missing — set it in .env",
      { code: "NOT_CONFIGURED" }
    );
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: { "X-Authentication": key, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok || (body && body.error)) {
    const code = (body && body.code) || (body && body.error) || `HTTP_${res.status}`;
    const msg = (body && body.message) || text.slice(0, 200);
    throw new AwardWalletError(`AwardWallet ${path}: ${res.status} ${code} — ${msg}`, { status: res.status, code });
  }
  return body;
}

const listConnectedUsers = async () => (await get("/connectedUser")).connectedUsers || [];
const getConnectedUser = (id) => get(`/connectedUser/${encodeURIComponent(id)}`);
const listMembers = async () => (await get("/member")).members || [];
const getMember = (id) => get(`/member/${encodeURIComponent(id)}`);

const isConfigured = () => !!process.env.AWARDWALLET_API_KEY;

module.exports = { isConfigured, AwardWalletError, listConnectedUsers, getConnectedUser, listMembers, getMember };
