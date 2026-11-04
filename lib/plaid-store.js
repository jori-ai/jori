"use strict";
// plaid-store.js — durable storage for Plaid Items (access tokens + sync state).
//
// The access_token is the long-lived credential that lets Jori read the bank
// account headlessly forever (Plaid access tokens do not expire). It is highly
// sensitive, so it lives ONLY in credentials/plaid-token.json, which is
// gitignored (credentials/ is in .gitignore) — never in the DB, never in
// .env, never committed. Same trust tier as credentials/gmail-push-token.json.
// PLAID_TOKEN_FILE points it elsewhere (tests, a dry run against no Items).
//
// File shape:
// {
//   "env": "sandbox",
//   "pending_link": { "link_token": "...", "created_at": "..." } | null,
//   "items": [
//     {
//       "item_id": "...",
//       "access_token": "...",
//       "institution_id": "ins_000000",
//       "institution_name": "Example Bank",
//       "status": "active",              // "active" | "login_required"
//       "cursor": null,                  // /transactions/sync cursor
//       "added_at": "2026-06-23T...",
//       "last_synced_at": null
//     }
//   ]
// }

const fs = require("node:fs");
const path = require("node:path");
const { installTools } = require("./root.cjs");

const TOKEN_FILE = process.env.PLAID_TOKEN_FILE || installTools("credentials", "plaid-token.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return { env: null, pending_link: null, items: [] };
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  // Atomic write: temp file then rename, matching google-auth.js.
  const tmp = `${TOKEN_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
  try {
    fs.chmodSync(TOKEN_FILE, 0o600); // tokens are owner-read/write only
  } catch {
    /* best effort */
  }
}

function getItems() {
  return load().items || [];
}

function getItem(itemId) {
  return getItems().find((i) => i.item_id === itemId) || null;
}

/** Insert or update an Item, merging the given fields onto any existing record. */
function upsertItem(fields) {
  if (!fields || !fields.item_id) throw new Error("upsertItem: item_id required");
  const state = load();
  state.items = state.items || [];
  const idx = state.items.findIndex((i) => i.item_id === fields.item_id);
  if (idx === -1) {
    state.items.push({ status: "active", cursor: null, last_synced_at: null, ...fields });
  } else {
    state.items[idx] = { ...state.items[idx], ...fields };
  }
  save(state);
  return getItem(fields.item_id);
}

function setCursor(itemId, cursor) {
  return upsertItem({ item_id: itemId, cursor });
}

/**
 * Forget an Item locally, recording that it was superseded.
 *
 * Called after `/item/remove` has disconnected it at Plaid. The `superseded`
 * list is the only remaining trace of the old item_id, and it matters: the rows
 * already in Supabase are keyed to that Item's account ids, and a replacement
 * Item issues brand-new ones for the same cards. Without this record there is
 * no way to tell the stale rows from the live ones, and they would double-count
 * forever.
 *
 * The access token is deliberately NOT kept — it is dead, and a dead credential
 * on disk is only a liability.
 */
function removeItem(itemId, reason) {
  const state = load();
  const item = (state.items || []).find((i) => i.item_id === itemId);
  state.items = (state.items || []).filter((i) => i.item_id !== itemId);
  state.superseded = state.superseded || [];
  if (item) {
    state.superseded.push({
      item_id: item.item_id,
      institution_name: item.institution_name || null,
      institution_id: item.institution_id || null,
      removed_at: new Date().toISOString(),
      reason: reason || null,
      cleaned_up: false,
    });
  }
  save(state);
  return item || null;
}

/** Superseded Items whose Supabase rows have not yet been cleaned up. */
function getSuperseded() {
  return (load().superseded || []).filter((s) => !s.cleaned_up);
}

/** Mark a superseded Item's stale rows as dealt with. */
function markSupersededCleaned(itemId) {
  const state = load();
  for (const s of state.superseded || []) {
    if (s.item_id === itemId) s.cleaned_up = true;
  }
  save(state);
}

function setStatus(itemId, status) {
  return upsertItem({ item_id: itemId, status });
}

function markSynced(itemId, when) {
  return upsertItem({ item_id: itemId, last_synced_at: when || new Date().toISOString() });
}

/** Track the in-flight Hosted Link token between `plaid-connect link` and `finish`. */
function setPendingLink(linkToken) {
  const state = load();
  state.pending_link = linkToken
    ? { link_token: linkToken, created_at: new Date().toISOString() }
    : null;
  save(state);
}

function getPendingLink() {
  return load().pending_link || null;
}

// ── Multiple in-flight Hosted Link sessions (connecting several institutions
// in one browser sitting). pending_links is an array; getPendingLinks also
// folds in any legacy single pending_link so older state still resolves. ──
function addPendingLinks(linkTokens) {
  const state = load();
  state.pending_links = state.pending_links || [];
  const now = new Date().toISOString();
  for (const lt of linkTokens) state.pending_links.push({ link_token: lt, created_at: now });
  save(state);
}

function getPendingLinks() {
  const state = load();
  const arr = [...(state.pending_links || [])];
  if (state.pending_link && !arr.some((p) => p.link_token === state.pending_link.link_token)) {
    arr.push(state.pending_link);
  }
  return arr;
}

function removePendingLink(linkToken) {
  const state = load();
  state.pending_links = (state.pending_links || []).filter((p) => p.link_token !== linkToken);
  if (state.pending_link && state.pending_link.link_token === linkToken) state.pending_link = null;
  save(state);
}

function getEnv() {
  return load().env;
}

function setEnv(env) {
  const state = load();
  state.env = env;
  save(state);
}

module.exports = {
  TOKEN_FILE,
  load,
  save,
  getItems,
  getItem,
  upsertItem,
  removeItem,
  getSuperseded,
  markSupersededCleaned,
  setCursor,
  setStatus,
  markSynced,
  setPendingLink,
  getPendingLink,
  addPendingLinks,
  getPendingLinks,
  removePendingLink,
  getEnv,
  setEnv,
};
