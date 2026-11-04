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
  if (state[row.id]) return { ok: false, already: true, reason: `rebuild already queued (${state[row.id].request_id})` };
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

/**
 * Queue a rebuild for a card whose apply failed on a conflict. Never throws.
 * Returns { queued:true, requestId } or { queued:false, already, reason }
 * (`already` = it was rebuilt once before, so the once-rule stopped it).
 */
export function queueCardRebuild({ root, row, error, now = new Date() }) {
  try {
    const stateFile = rebuildStatePath(root);
    const state = readState(stateFile);
    const can = canRebuild(row, state);
    if (!can.ok) return { queued: false, already: !!can.already, reason: can.reason };

    const q = path.join(root, "data/build-queue");
    for (const d of ["pending", "running", "done", "failed", "results"]) fs.mkdirSync(path.join(q, d), { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const requestId = `${stamp}-rb${String(row.id).replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;
    const body = { id: requestId, spec: rebuildSpec(row, error), source: "approval-rebuild", rebuild_of: row.id, requested_at: now.toISOString() };
    // Rename into place last, as build-request does, so launchd never sees a half-written file.
    const tmp = path.join(q, `.${requestId}.json`);
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, path.join(q, "pending", `${requestId}.json`));

    state[row.id] = { request_id: requestId, queued_at: now.toISOString(), error: String(error || "").slice(0, 400) };
    const tmpState = `${stateFile}.tmp`;
    fs.writeFileSync(tmpState, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(tmpState, stateFile);
    return { queued: true, requestId };
  } catch (e) {
    return { queued: false, reason: `could not queue: ${e?.message || e}` };
  }
}
