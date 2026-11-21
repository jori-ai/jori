// self-improve-rebuild — an approved card whose apply failed on a conflict is
// rebuilt once against the current tree, instead of left dead.
//
// Requirement: an approved fix that fails to apply is refused and redone, not
// left dead. An approved fix once failed to apply because its file had moved
// on; the applier said so in the Improvements channel and asked the user to
// request a rebuild in chat. Nobody did, and the same question reached the user
// again. A signed card's content cannot be edited (its signature binds the
// item hash, and data/migrations/20261022_self_improve_approvals_freeze.sql
// makes the database refuse the edit outright), so a
// rebuild is a NEW card: the same intent, re-authored against today's files, and
// it needs the user's Face ID again.
//
// The author is the chat-build job (jobs/chat-build.md § Rebuilding an approved
// card): Opus, already wired to land through the self-improvement pipeline, and
// launchd-queued so it runs in-session on Max. This module only writes the queue
// file. It never re-applies anything itself.
//
// Repair (2026-11-15). The same queue also takes a card that DID go in — written
// and committed — but is not running because its tests fail (`result.not_live`
// from lib/self-improve-live.mjs). Retry alone re-ran the identical check and
// failed identically, so the card sat "In, not running" with nothing fixing it.
// A repair keeps the approved change and fixes forward: chat-build makes the
// failing tests pass on today's code and files that as a fresh card
// (`--rebuild-of <id>`, so the same once-rule applies). When that card is
// applied and running, the poller marks the original as running too.
//
// Once means once:
//   - a card that is itself a rebuild (item_json.rebuild_of) is never rebuilt
//     again — a second conflict goes back to the old "ask me" notice;
//   - a card is queued at most once, recorded in data/self-improve-rebuilds.json
//     (the retry path re-runs the same failed apply and must not queue twice).

import fs from "node:fs";
import path from "node:path";

const RATIONALE_CHARS = 2500;

export const rebuildStatePath = (root) => path.join(root, "data/self-improve-rebuilds.json");

function readState(file) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; }
  catch { return {}; }
}

/** May this approval row be rebuilt? Returns { ok } or { ok:false, reason }. */
export function canRebuild(row, state = {}) {
  if (!row?.id) return { ok: false, reason: "no row" };
  if (row.item_type !== "code-fix") return { ok: false, reason: `item_type ${row.item_type} is not rebuilt` };
  if (row.item_json?.rebuild_of) return { ok: false, already: true, reason: `already a rebuild of ${row.item_json.rebuild_of}` };
  if (state[row.id]) return { ok: false, already: true, kind: state[row.id].kind || "rebuild", requestId: state[row.id].request_id, reason: `${state[row.id].kind === "repair" ? "repair" : "rebuild"} already queued (${state[row.id].request_id})` };
  return { ok: true };
}

/** The brief chat-build reads. Plain text, self-contained, well under build-request's 6000-char cap. */
export function rebuildSpec(row, error) {
  const files = Object.keys(row.item_json?.files || {});
  const rationale = String(row.rationale || "").trim();
  return [
    `REBUILD OF AN APPROVED CARD — approval ${row.id}.`,
    `The user approved this change with Face ID, but it could not be applied because the code moved on after it was written: ${String(error || "").trim()}`,
    `Rebuild the same change against the current files, then file it as a fresh card (jobs/chat-build.md § Rebuilding an approved card). Read the original with: bin/self-improve-show ${row.id} --full`,
    `Title: ${row.summary || row.id}`,
    `Files it changed: ${files.join(", ") || "(none recorded)"}`,
    `What it said, in the card's own words:`,
    rationale.length > RATIONALE_CHARS ? `${rationale.slice(0, RATIONALE_CHARS)}…` : rationale,
  ].join("\n\n");
}

/** The brief for a card that went in but whose tests fail (see the header). */
export function repairSpec(row, error, failures = []) {
  const files = Object.keys(row.item_json?.files || {});
  const tests = files.filter((f) => /(^|\/)tests\/[^/]+\.test\.(mjs|cjs|js)$/.test(f)); // lang-regex-ok: file paths
  const rationale = String(row.rationale || "").trim();
  const failing = (failures || []).slice(0, 12).map((f) => `- ${f}`).join("\n");
  return [
    `REPAIR OF AN APPLIED CARD — approval ${row.id}.`,
    `The user approved this change with Face ID. It is written and committed, but it is not counted as running because its tests fail where the approval poller runs them: ${String(error || "").trim()}`,
    failing ? `Failing tests (new with this change):\n${failing}` : "",
    `Keep the approved change and fix forward on the current code: make these tests pass (fix the code, or the test when the test is what is wrong, or what the test assumes about its environment). Do not revert the change. File the fix as a fresh card (jobs/chat-build.md § Repairing an applied card). Read the original with: bin/self-improve-show ${row.id} --full`,
    tests.length ? `Its test files: ${tests.join(" ")}. The poller runs them from cron: node --test --test-reporter=tap <files>, with only HOME and PATH=<node's dir>:/usr/bin:/bin set.` : "",
    `Title: ${row.summary || row.id}`,
    `Files it changed: ${files.join(", ") || "(none recorded)"}`,
    `What it said, in the card's own words:`,
    rationale.length > RATIONALE_CHARS ? `${rationale.slice(0, RATIONALE_CHARS)}…` : rationale,
  ].filter(Boolean).join("\n\n");
}

const WAITING = ["pending", "held"];   // held/ = waiting on the allowance governor (trigger-chat-build.sh)

/**
 * Where this approval's queued rebuild or repair stands: { requestId, where }
 * with where one of pending | held | running | done | failed | withdrawn |
 * gone, or null when none was ever queued.
 */
export function queuedRebuild({ root, id }) {
  const e = readState(rebuildStatePath(root))[id];
  if (!e?.request_id) return null;
  if (e.withdrawn_at) return { requestId: e.request_id, kind: e.kind || "rebuild", where: "withdrawn" };
  const q = path.join(root, "data/build-queue");
  const where = [...WAITING, "running", "done", "failed"].find((d) => fs.existsSync(path.join(q, d, `${e.request_id}.json`))) || "gone";
  return { requestId: e.request_id, kind: e.kind || "rebuild", where };
}

/**
 * The original card went in after all (a Retry, once the applier could carry
 * it). A rebuild still waiting in the queue would only come back as a second
 * card for a change that is already live, so it is taken out of the queue. One
 * already running is left alone. The state entry stays, so the once-rule holds.
 * Never throws. Returns { withdrawn, requestId?, where? }.
 */
export function withdrawQueuedRebuild({ root, id, now = new Date() }) {
  try {
    const qr = queuedRebuild({ root, id });
    if (!qr || !WAITING.includes(qr.where)) return { withdrawn: false, ...(qr || {}) };
    fs.unlinkSync(path.join(root, "data/build-queue", qr.where, `${qr.requestId}.json`));
    const stateFile = rebuildStatePath(root);
    const state = readState(stateFile);
    state[id] = { ...state[id], withdrawn_at: now.toISOString() };
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(`${stateFile}.tmp`, stateFile);
    return { withdrawn: true, requestId: qr.requestId, where: qr.where };
  } catch (e) {
    return { withdrawn: false, error: String(e?.message || e) };
  }
}

/**
 * Queue a rebuild for a card whose apply failed on a conflict, or (kind
 * "repair") a fix for a card that went in but whose tests fail. Never throws.
 * Returns { queued:true, requestId } or { queued:false, already, reason }
 * (`already` = it was rebuilt or repaired once before, so the once-rule stopped it).
 */
export function queueCardRebuild({ root, row, error, kind = "rebuild", failures = [], now = new Date() }) {
  try {
    const stateFile = rebuildStatePath(root);
    const state = readState(stateFile);
    const can = canRebuild(row, state);
    if (!can.ok) return { queued: false, already: !!can.already, ...(can.requestId ? { kind: can.kind, requestId: can.requestId } : {}), reason: can.reason };

    const repair = kind === "repair";
    const q = path.join(root, "data/build-queue");
    for (const d of ["pending", "running", "done", "failed", "results"]) fs.mkdirSync(path.join(q, d), { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const requestId = `${stamp}-${repair ? "rp" : "rb"}${String(row.id).replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;
    // Same source for both: the landing checks (lib/self-improve-landing.mjs)
    // treat a rebuild and a repair alike — the owner's signed card, carried on.
    const body = {
      id: requestId, spec: repair ? repairSpec(row, error, failures) : rebuildSpec(row, error),
      source: "approval-rebuild", kind, rebuild_of: row.id, requested_at: now.toISOString(),
    };
    // Rename into place last, as build-request does, so launchd never sees a half-written file.
    const tmp = path.join(q, `.${requestId}.json`);
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, path.join(q, "pending", `${requestId}.json`));

    state[row.id] = { request_id: requestId, kind, queued_at: now.toISOString(), error: String(error || "").slice(0, 400) };
    const tmpState = `${stateFile}.tmp`;
    fs.writeFileSync(tmpState, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(tmpState, stateFile);
    return { queued: true, requestId };
  } catch (e) {
    return { queued: false, reason: `could not queue: ${e?.message || e}` };
  }
}
