// action-approval.mjs — the pure core of Face-ID approval for plugin actions.
//
// Requirement: any plugin can put a Face ID check in front of an action it
// declares risky, without writing its own approval flow or its own app screen.
//
// The flow (docs/writing-a-plugin.md, "Actions that need your approval"):
//   1. The plugin declares the action in plugin.json:
//        "approvals": { "<action>": { "title": "…", "run": "{node} bin/<cmd> …" } }
//   2. Its code (or its playbook) files a request with `bin/approval request`:
//      a title, labelled fields for people, and the exact params the action
//      will run with. The row lands in `action_approvals`; the phone gets a
//      time-sensitive push and opens the generic review screen.
//   3. The app shows the title, every field AND every param, re-derives the
//      hash from what it displays (ActionApproval.swift mirrors
//      canonicalStringify byte for byte) and signs it with Face ID.
//   4. `bin/action-approval-poll` (no LLM) verifies the signature against the
//      paired device key, checks the plugin is still on and still declares the
//      action, and only then runs the declared `run` command with the signed
//      params on stdin.
//
// What the signature binds: the plugin, the action, the title, the fields and
// the params. The command that runs comes from the manifest, never from the
// request, so a request cannot choose what executes.
//
// Signing domain: `jori-action.v1`, fixed in code on both sides (never read
// from the row or from config), and the canonical message is the same five
// lines as every other approval. A purchase signs the installation's purchase
// domain and a self-improvement card the approval domain, so none of the three
// can be replayed as another. Plugin actions share the purchase device key,
// which is registered only by burning a host-minted pairing code
// (`purchase pair`); an app session alone cannot add a signing device.

import { itemHash, buildApprovalRequest, checkApproval, canonicalMessage } from "../agent/core/app-approval.mjs";

export const ACTION_DOMAIN = "jori-action.v1";
export const DEFAULT_TTL_MINUTES = 15;
export const MAX_TTL_MINUTES = 24 * 60;
export const DEFAULT_TIMEOUT_SECONDS = 300;
// A signature made just before expiry may be picked up just after it.
export const EXECUTE_GRACE_MS = 2 * 60 * 1000;

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/; // lang-regex-ok: plugin / action id syntax
const PARAM_KEY = /^[a-z][a-z0-9_]{0,40}$/; // lang-regex-ok: param key syntax
const MAX_FIELDS = 20;
const MAX_PARAMS = 30;
const MAX_PARAM_STRING = 4000;
const MAX_CANONICAL = 16 * 1024;

function text(v, field, max) {
  if (v == null) throw new Error(`action item: ${field} is required`);
  const s = String(v).replace(/\s+/g, " ").trim();
  if (!s) throw new Error(`action item: ${field} is required`);
  if (s.length > max) throw new Error(`action item: ${field} longer than ${max} chars`);
  return s;
}

/**
 * One param value. Only what renders and hashes the same in Swift and JS:
 * strings, safe integers, booleans and null. A float, an object or a list is
 * refused (put structured data in a string the action parses).
 */
function scalar(v, key) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`action item: params.${key} must be an integer (no decimals)`);
    return v;
  }
  if (typeof v === "string") {
    if (v.length > MAX_PARAM_STRING) throw new Error(`action item: params.${key} longer than ${MAX_PARAM_STRING} chars`);
    return v;
  }
  throw new Error(`action item: params.${key} must be a string, an integer, true/false or null`);
}

/**
 * Validate + canonicalize a request. Every key here is displayed on the phone,
 * so nothing is hashed that the user does not see.
 */
export function normalizeActionItem(input) {
  if (!input || typeof input !== "object") throw new Error("action item: expected an object");
  const plugin = String(input.plugin || "");
  const action = String(input.action || "");
  if (!NAME.test(plugin)) throw new Error("action item: plugin must be a plugin name");
  if (!NAME.test(action)) throw new Error("action item: action must be lowercase letters, digits and dashes");
  const fields = Array.isArray(input.fields) ? input.fields : [];
  if (fields.length > MAX_FIELDS) throw new Error(`action item: more than ${MAX_FIELDS} fields`);
  const params = input.params == null ? {} : input.params;
  if (typeof params !== "object" || Array.isArray(params)) throw new Error("action item: params must be an object");
  const keys = Object.keys(params);
  if (keys.length > MAX_PARAMS) throw new Error(`action item: more than ${MAX_PARAMS} params`);
  const outParams = {};
  for (const k of keys) {
    if (!PARAM_KEY.test(k)) throw new Error(`action item: param name '${k}' must be lowercase letters, digits and underscores`);
    outParams[k] = scalar(params[k], k);
  }
  const item = {
    v: 1,
    plugin,
    action,
    title: text(input.title, "title", 120),
    fields: fields.map((f, i) => ({
      label: text(f?.label, `fields[${i}].label`, 60),
      value: text(f?.value, `fields[${i}].value`, 500),
    })),
    params: outParams,
  };
  if (item.fields.length === 0 && keys.length === 0) throw new Error("action item: give at least one field or param, so the card says what will happen");
  if (JSON.stringify(item).length > MAX_CANONICAL) throw new Error("action item: too large to show on a card");
  return item;
}

export function actionHash(item) {
  return itemHash(normalizeActionItem(item));
}

export function buildActionRequest(id, item, { now = Date.now(), nonce = null, ttlMs = DEFAULT_TTL_MINUTES * 60000 } = {}) {
  const norm = normalizeActionItem(item);
  const req = buildApprovalRequest(id, norm, { now, nonce, ttlMs });
  return { ...req, domain: ACTION_DOMAIN, item: norm, message: canonicalMessage({ ...req, domain: ACTION_DOMAIN }) };
}

/**
 * Verify a signed action_approvals row before anything runs. `publicKeyRawB64`
 * is the paired device key for row.signed_by. Returns {ok, reason}.
 */
export function verifyActionRow(row, publicKeyRawB64, { now = Date.now() } = {}) {
  if (!row) return { ok: false, reason: "no row" };
  if (!row.signature || !row.signed_by) return { ok: false, reason: "unsigned" };
  if (!publicKeyRawB64) return { ok: false, reason: "signing device is not a paired device" };
  let item;
  try { item = normalizeActionItem(row.item_json); } catch (e) { return { ok: false, reason: `item invalid: ${e.message}` }; }
  if (item.plugin !== row.plugin || item.action !== row.action) return { ok: false, reason: "row and signed item name different actions" };
  const expiresAt = Number(row.expires_at_ms);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "no expiry" };
  if (now > expiresAt + EXECUTE_GRACE_MS) return { ok: false, reason: "expired" };
  // checkApproval's own expiry check would refuse inside the grace window, so
  // it gets a clock pinned at expiry when we are inside the grace.
  const request = { id: row.id, hash: row.item_hash, nonce: row.nonce, expiresAt, domain: ACTION_DOMAIN };
  return checkApproval({ request, item, signatureB64: row.signature, publicKeyRawB64, now: Math.min(now, expiresAt) });
}

/** One line for the push and the chat: the title, then the first two fields. */
export function summarize(item) {
  const bits = item.fields.slice(0, 2).map((f) => `${f.label}: ${f.value}`);
  return bits.length ? `${item.title} — ${bits.join(", ")}` : item.title;
}

/**
 * The command that runs an approved action: the manifest's `run`, with the
 * same placeholders and plugin-relative `bin/` / `lib/` paths as a schedule's
 * `run`. `env` holds {node, sysnode, root, home}. The request never supplies it.
 */
export function expandRun(run, pluginDir, env) {
  return String(run)
    .replace(/\{node\}/g, env.node).replace(/\{sysnode\}/g, env.sysnode)
    .replace(/\{root\}/g, env.root).replace(/\{home\}/g, env.home)
    .replace(/(^|\s)(bin|lib)\//g, `$1${pluginDir}/$2/`); // lang-regex-ok: plugin-relative paths in a command
}

/**
 * The chat line after an approved action ran. The action may print one line
 * for the user as the LAST line of its stdout, prefixed `say: `; otherwise a
 * plain sentence from the title.
 */
export function resultMessage(item, { ok, stdout = "", stderr = "", exitCode = null, timedOut = false }) {
  const said = String(stdout).split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  const say = said.startsWith("say: ") ? said.slice(5).trim().slice(0, 600) : "";
  if (ok) return say || `Done: ${item.title}.`;
  if (timedOut) return `${item.title} didn't finish in time, so I stopped it. It may have partly run; worth a look.`;
  const why = String(stderr).split("\n").map((l) => l.trim()).filter(Boolean).pop() || `exit ${exitCode}`;
  return say || `${item.title} didn't go through (${why.slice(0, 200)}).`;
}
