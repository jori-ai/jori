"use strict";
// awardwallet-map.js — AwardWallet account object → loyalty_accounts row.
// Pure; kept apart from the client so tests need no network.

const ELITE_KIND = 3; // AwardWallet property kind for elite status

function decodeEntities(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

/** AwardWallet writes "never expires" as a far-future date (seen: 2286-11-20). */
function realDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() > 2200) return null;
  return d.toISOString();
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// A negative balance is a program's own bookkeeping (a car-rental program can
// show one on its own site) — nothing is owed in points. Requirement: show
// negative values as zero. Stored as 0 so every reader shows 0.
function nonNegative(raw, text) {
  if (raw == null || raw >= 0) return { raw, text: text ?? null };
  return { raw: 0, text: "0" };
}

function toRow(a, ownerKind, ownerId, asOf) {
  const props = Array.isArray(a.properties) ? a.properties : [];
  const elite = props.find((p) => p.kind === ELITE_KIND);
  const bal = nonNegative(num(a.balanceRaw), a.balance);
  return {
    account_id: a.accountId,
    owner_kind: ownerKind,
    owner_id: ownerId,
    owner_name: a.owner || null,
    provider_code: a.code || null,
    display_name: decodeEntities(a.displayName) || null,
    kind: a.kind || null,
    login: a.login || null,
    balance: bal.text,
    balance_raw: bal.raw,
    elite_status: elite ? decodeEntities(elite.value) : null,
    expiration_date: realDate(a.expirationDate),
    last_change_date: realDate(a.lastChangeDate),
    last_retrieve_date: realDate(a.lastRetrieveDate),
    last_detected_change: a.lastDetectedChange ?? null,
    error_code: a.errorCode ?? null,
    error_message: a.errorMessage || null,
    sub_accounts: (a.subAccounts || []).map((s) => ({
      display_name: decodeEntities(s.displayName),
      balance: nonNegative(num(s.balanceRaw), s.balance).text,
      balance_raw: nonNegative(num(s.balanceRaw), s.balance).raw,
      expiration_date: realDate(s.expirationDate),
      properties: (s.properties || []).map((p) => ({ name: p.name, value: decodeEntities(p.value) })),
    })),
    properties: props.map((p) => ({ name: p.name, value: decodeEntities(p.value), kind: p.kind ?? null })),
    as_of: asOf,
    updated_at: asOf,
  };
}

/** errorCode 1 = AwardWallet read the program successfully on its last try. */
const isReadable = (row) => row.error_code === 1;

// AwardWallet errorCode meanings (https://awardwallet.com/api/account):
// 0 unchecked, 1 ok, 2 invalid credentials, 3 locked out, 4 provider error,
// 5 provider disabled, 6 unknown/engine error, 7 missing password,
// 8 "change the password to prevent lockout", 9 warning, 10 security question,
// 11 timeout. The first group only a person can fix; the second is the
// provider having a bad day and usually clears on the next try.
const NEEDS_USER_CODES = new Set([2, 3, 5, 7, 8, 10]);
const needsUser = (code) => NEEDS_USER_CODES.has(code);
// Never re-try these unattended: a stored password the provider rejects, tried
// weekly, is how a program account gets locked.
const LOCKOUT_RISK_CODES = new Set([2, 3, 7, 8]);

// A program not read successfully for three weeks has stopped updating, error
// or not. A card program once sat at a years-old balance while reporting errorCode 1 — the
// silent disconnect — and a "try again later" that never clears is the same.
const STALE_DAYS = 21;

/**
 * Why this program is not current, or null when it is.
 * `lastOk` = when Jori last saw this program read successfully (state file),
 * because AwardWallet's last_retrieve_date also moves on FAILED attempts.
 */
function unhealthyReason(row, now = new Date(), lastOk = null) {
  if (needsUser(row.error_code)) return row.error_message || `AwardWallet error ${row.error_code}`;
  const okAt = isReadable(row) ? row.last_retrieve_date : lastOk;
  if (!okAt) return isReadable(row) ? "AwardWallet has never read it" : (row.error_message || `AwardWallet error ${row.error_code}`);
  const days = Math.floor((now - new Date(okAt)) / 86400000);
  if (days > STALE_DAYS) {
    return isReadable(row) ? `not updated in ${days} days` : `no successful read in ${days} days (${row.error_message || `error ${row.error_code}`})`;
  }
  return null;
}

/**
 * Compare this run against the last one. Only a program going from current to
 * not-current is "newly" disconnected, so a long-dead program never re-alerts.
 * `prev` null (no state yet) seeds silently. `lastOk` is read and updated:
 * a transiently-failing program first seen without a record starts its 21-day
 * grace now rather than being declared dead on sight.
 */
function diffHealth(prev, rows, now = new Date(), lastOk = {}) {
  const unhealthy = {};
  const newly = [];
  const recovered = [];
  const nextOk = { ...lastOk };
  for (const r of rows) {
    if (isReadable(r)) nextOk[r.account_id] = r.last_retrieve_date || now.toISOString();
    else if (!needsUser(r.error_code) && !nextOk[r.account_id]) nextOk[r.account_id] = now.toISOString();
    const reason = unhealthyReason(r, now, nextOk[r.account_id] || null);
    if (reason) {
      unhealthy[r.account_id] = reason;
      if (prev && !(r.account_id in prev)) newly.push({ row: r, reason });
    } else if (prev && r.account_id in prev) {
      recovered.push(r);
    }
  }
  return { unhealthy, newly, recovered, lastOk: nextOk };
}

module.exports = { toRow, isReadable, needsUser, LOCKOUT_RISK_CODES, unhealthyReason, diffHealth, STALE_DAYS, realDate, decodeEntities };
