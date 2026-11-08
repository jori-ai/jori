// self-improve-landing.mjs — how a finished, verified self-improvement lands:
// on its own, as a Face-ID card, or not at all. No clock; the only I/O is
// reading the installation's config and its optional landing hook at import.
//
// Improvement cards are reserved for complex, high-blast-radius items;
// everything else is applied automatically. Until then every change reached the
// user's phone as a card (rubric schema v3), and the user had signed hundreds of
// them and declined none — a gate with a 100% pass rate had stopped being a gate. Schema v4 of
// data/self-improvement-risk-rubric.md reopens automatic landing, and
// this module is the part of it that is code rather than prose, so that the
// boundary does not depend on an agent classifying its own work honestly.
//
// Three outcomes:
//
//   refuse — FORBIDDEN (secrets, credentials) or RECURSION_GUARD (the
//            improvement pipeline's own controls). Nothing is drafted, staged
//            or applied; a human edits these directly. One exception (rubric
//            schema v6): a guarded file outside LOCK_CORE goes on a card when
//            the owner asked for the change in chat, quoted word for word
//            (see verifyOwnerRequest). LOCK_CORE is refused regardless. Also refused, with
//            `redraft: true`: whatever the installation's landing hook rejects
//            (_ext/self-improve-landing.mjs `landingRefusals`, e.g. content that
//            does not belong in the file it was put in). The author fixes the
//            change and resubmits; neither a card nor a signature can land it.
//   card   — anything high-blast-radius or complex: a CARD_ONLY path (the
//            daily-summary repair loop's own files), a FORCE_HIGH path (money,
//            logins, outbound messages, calendar, triage, the supervisor, the
//            enforcement hooks), a new capability, more than MAX_FILES files or
//            MAX_CHANGED_LINES changed lines, a high risk label, or a critic
//            that did not say SAFE. Lands only on the user's Face-ID signature.
//   auto   — everything else. Committed directly, tagged [auto-impl], revertable
//            like any commit, and listed in the review email.
//
// The paths are judged from the ACTUAL file set, never from what an agent
// predicted it would touch, and the lists below are mirrored in the rubric and
// pinned by tests/self-improve-landing.test.mjs.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHook } from "./ext-hooks.mjs";

// The installation's own landing checks: lib/_ext/self-improve-landing.mjs
// may export landingRefusals({ files, before }) → string[] (synchronous). Each
// string refuses the change; an empty list (or no hook) lets it through to the
// rails below. A fresh install has no hook. A hook that fails to load refuses
// every change with the load error (an unchecked change does not land) rather
// than breaking the import for the callers that only compose cards.
const LANDING_HOOK = await loadHook(path.dirname(fileURLToPath(import.meta.url)), "self-improve-landing").catch((e) => ({
  landingRefusals: () => { throw new Error(`could not load _ext/self-improve-landing.mjs: ${e?.message ?? e}`); },
}));

// Path rails are written kernel-relative and matched against repo-relative
// paths: rail(/bin\/x$/) is /^bin\/x$/ where the kernel sits under
// tools/ (KERNEL_SUBDIR, lib/root.cjs) and /^bin\/x$/ where it is the repo root.
const { KERNEL_SUBDIR } = createRequire(import.meta.url)("./root.cjs");
const KERNEL_PREFIX = KERNEL_SUBDIR ? KERNEL_SUBDIR.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "\\/" : "";
function rail(re) {
  return new RegExp(`^${KERNEL_PREFIX}${re.source}`, re.flags);
}

// Size of a change that may land without review (agent/local/config/self-improve-landing.json).
const LANDING_SIZE = createRequire(import.meta.url)("./instance.cjs").localConfig("self-improve-landing", { max_files: 5, max_changed_lines: 300 });
export const MAX_FILES = Number(LANDING_SIZE.max_files);
export const MAX_CHANGED_LINES = Number(LANDING_SIZE.max_changed_lines);

/** Never touched by the pipeline in any form. */
export const FORBIDDEN = [
  rail(/secrets\//),
  rail(/credentials\//),
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)\.credentials\.json$/,
  /\.p8$/,
];

/**
 * The improvement pipeline's own controls. A system that could rewrite these
 * could approve its own loosening, so nothing in the pipeline may even draft a
 * change to them — Face-ID or not. A human edits them directly.
 */
export const RECURSION_GUARD = [
  rail(/agent\/CLAUDE\.md$/),
  rail(/agent\/chat-agent\/CLAUDE\.md$/),
  // On-demand procedures split out of chat-agent/CLAUDE.md (2026-10-04): the
  // same rules, so the same guard.
  rail(/agent\/chat-agent\/procedures\//),
  // Rule text moved out of agent/CLAUDE.md into on-demand docs (same day).
  rail(/docs\/(calendar-invite-guard|agent-auth-model|agent-effort-policy|outbound-messaging|system-channel-and-precheck|financial-carveouts|agent-rules-detail)\.md$/),
  rail(/agent\/ops-agent\/CLAUDE\.md$/),
  rail(/agent\/ops-light-agent\/CLAUDE\.md$/),
  rail(/agent\/ops-agent\/jobs\/nightly-review\.md$/),
  rail(/agent\/ops-agent\/jobs\/self-improvement-executor\.md$/),
  rail(/agent\/ops-agent\/jobs\/improvement-plan\.md$/),
  rail(/agent\/ops-agent\/jobs\/system-issue-review\.md$/),
  // The instance's local twins of the files above (agent/local/): its
  // own agent rules, appended to every agent's system prompt beside the
  // CLAUDE.md files, and its additions to those playbooks, appended to them at
  // dispatch. The same rules, so the same guard.
  rail(/agent\/local\/(shared|chat|ops)\.md$/),
  rail(/agent\/local\/jobs\/(nightly-review|self-improvement-executor|improvement-plan|system-issue-review|skill-repair)\.md$/),
  rail(/data\/self-improvement-risk-rubric\.md$/),
  rail(/lib\/self-improve-landing\.mjs$/),
  rail(/bin\/self-improve-(auto-apply|request|approval-poll|feed-log)$/),
  rail(/agent\/core\/(self-improve-unified|app-approval)\.mjs$/),
  // The stale-base check and the once-only card rebuild (2026-10-22): what
  // decides whether a fix may overwrite a file, and whether a failed approval
  // comes back.
  rail(/lib\/self-improve-(rebase|rebuild)\.mjs$/),
  rail(/tests\/(self-improve-landing|auto-impl-policy|self-improve-rebase|self-improve-rebuild)\.test\.mjs$/),
  // The same-day browser-action repair loop (2026-10-16): a repair may rewrite
  // a broken action, never the loop's own admission rules or playbook.
  rail(/lib\/skill-repair\.mjs$/),
  rail(/bin\/skill-repair$/),
  rail(/agent\/scripts\/trigger-skill-repair\.sh$/),
  rail(/agent\/ops-agent\/jobs\/skill-repair\.md$/),
  rail(/tests\/skill-repair\.test\.mjs$/),
  // What marks a request as the owner's own chat request (schema v6): the
  // queue writer stamps `source`, the chat-build trigger exports the request id
  // the card is checked against. The pipeline may not change how its own
  // requests are told apart from the owner's.
  rail(/bin\/build-request$/),
  rail(/agent\/scripts\/trigger-chat-build\.sh$/),
];

/**
 * The lock's own machinery (rubric schema v6, 2026-11-04): the subset of
 * RECURSION_GUARD that stays absolute even when the owner asked for the change
 * in chat. The owner chose (2026-10-27) that a change they ask for may touch the
 * locked files on a normal Face-ID card that quotes their words; asked whether
 * that should reach the lock itself, they said no. If it did, one quoted request
 * could loosen what decides whether a quote is needed. So the rubric, this
 * module, the self-improve CLIs, the approval core, the rebase/rebuild rules
 * and the tests that pin them are refused on every route; a human edits them
 * in a session the owner directs. Every entry here is also in RECURSION_GUARD.
 */
export const LOCK_CORE = [
  rail(/data\/self-improvement-risk-rubric\.md$/),
  rail(/lib\/self-improve-landing\.mjs$/),
  rail(/bin\/self-improve-(auto-apply|request|approval-poll|feed-log)$/),
  rail(/agent\/core\/(self-improve-unified|app-approval)\.mjs$/),
  rail(/lib\/self-improve-(rebase|rebuild)\.mjs$/),
  rail(/tests\/(self-improve-landing|auto-impl-policy|self-improve-rebase|self-improve-rebuild)\.test\.mjs$/),
];

/**
 * The daily-summary repair loop's own files (2026-10-17): it fixes the day's
 * code, never its own plumbing or playbook. These used to sit in
 * RECURSION_GUARD, so nothing could even draft a change to them and every fix
 * waited for a hand apply (one patch sat in a build-queue result file). The
 * user chose to make the loop's own rules changeable by a Face-ID card, still
 * never automatically. So they
 * are card-only — a change to them is drafted and lands on the user's signature, and
 * self-improve-auto-apply still refuses them whatever the risk label says.
 */
export const CARD_ONLY = [
  rail(/bin\/daily-summary-fix$/),
  rail(/agent\/ops-agent\/jobs\/daily-summary-fix\.md$/),
  rail(/agent\/local\/jobs\/daily-summary-fix\.md$/),
  rail(/agent\/scripts\/trigger-daily-summary-fix\.sh$/),
  rail(/tests\/daily-summary-fix\.test\.mjs$/),
];

// geo-gate-ok: a list of path rails that names the send CLIs; this module sends nothing and recommends no event.
/** High blast radius: always a Face-ID card, whatever the classifier said. */
export const FORCE_HIGH = [
  // The reviewer of the daily summary (2026-10-17): the fix loop may need to add a
  // check, but a change to what the review looks for is the user's call, so it is a
  // card, never a silent landing (the fixer must not weaken its own judge).
  rail(/lib\/daily-summary-review\.js$/),
  rail(/bin\/daily-summary-review$/),
  rail(/tests\/daily-summary-review\.test\.mjs$/),
  // The supervisor and everything read once at boot.
  rail(/agent\/supervisor\//),
  rail(/agent\/phone-channel\//),
  rail(/agent\/chat-supervisor\.mjs$/),
  rail(/agent\/bin\/process-manager\.mjs$/),
  rail(/agent\/config\/agents\.json$/),
  rail(/agent\/[^/]+\/\.mcp\.json$/),
  // Outbound messages, and the gates in front of them.
  rail(/bin\/(email-send|gmail-action|jori-send-curl|jori-send|jori-notify|imsg|whatsapp-send)$/),
  rail(/bin\/outbound-precheck\.mjs$/),
  rail(/lib\/(claim-freshness|apns-push)\.mjs$/),
  // Calendar writes.
  rail(/bin\/jori-calendar$/),
  // Money: the installation's own purchase, banking, brokerage and holdings
  // tools are appended below from agent/local/config/self-improve-landing.json.
  // Face-ID purchases: the executor, its trust core, and the playbook.
  rail(/bin\/purchase(-queue|-approval-poll)?$/),
  rail(/lib\/purchase-approval\.mjs$/),
  rail(/agent\/core\/app-approval\.mjs$/),
  rail(/agent\/ops-agent\/jobs\/purchase\.md$/),
  rail(/agent\/local\/jobs\/purchase\.md$/),
  // Email triage, where a mistake misroutes a P1.
  rail(/agent\/ops-agent\/jobs\/(email-triage[^/]*|triage-learning)\.md$/),
  rail(/agent\/ops-agent\/email-triage-rules\.md$/),
  // ...and the instance's own triage rules, merged into that ruleset by heading.
  rail(/agent\/local\/jobs\/(email-triage[^/]*|triage-learning)\.md$/),
  rail(/agent\/local\/email-triage-rules\.md$/),
  rail(/data\/(email-triage-playbook\.md|spam-blocklist\.json|p1-senders\.json)$/),
  // The enforcement layer: hooks and lints that hold rules prose could not.
  rail(/githooks\//),
  rail(/bin\/lint-[^/]+$/),
  rail(/bin\/jori-commit$/),
];
// The installation's own high-blast-radius paths (its money tools, …):
// `force_high` in agent/local/config/self-improve-landing.json, as regex
// sources matched against the repo-relative path.
for (const src of createRequire(import.meta.url)("./instance.cjs").localConfig("self-improve-landing", { force_high: [] }).force_high || []) {
  FORCE_HIGH.push(new RegExp(src));
}

/** Shared process machinery: never labelled low, but may still land on its own. */
export const FORCE_MODERATE = [
  rail(/agent\/scripts\/watchdog\.sh$/),
  rail(/agent\/scripts\/trigger-[^/]+\.sh$/),
  rail(/system\/tasks(\.schema)?\.json$/),
  // ...and the installation's own task entries, merged into it by lib/registry.cjs.
  rail(/agent\/local\/tasks\.json$/),
  rail(/bin\/jori$/),
];

/** Categories that are complex or high-blast-radius by nature. */
export const CARD_CATEGORIES = new Set(["new-capability", "outbound", "auth", "financial", "recursion-guard"]);

function matchAll(paths, patterns) {
  return paths.filter((p) => patterns.some((re) => re.test(p)));
}

/** Which rails each path hits. */
export function railsFor(paths) {
  return {
    forbidden: matchAll(paths, FORBIDDEN),
    recursion: matchAll(paths, RECURSION_GUARD),
    lockCore: matchAll(paths, LOCK_CORE),
    cardOnly: matchAll(paths, CARD_ONLY),
    forceHigh: matchAll(paths, FORCE_HIGH),
    forceModerate: matchAll(paths, FORCE_MODERATE),
  };
}

/**
 * Lines changed between two versions of a file: lines added plus lines removed,
 * counted as a multiset. It ignores moves, which makes it a slight
 * over-estimate of `git diff --numstat` — the safe direction for a size limit.
 */
export function changedLines(before, after) {
  const count = (text) => {
    const m = new Map();
    for (const line of String(text ?? "").split("\n")) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  if (before == null) return String(after ?? "").split("\n").length;
  const a = count(before);
  const b = count(after);
  let diff = 0;
  for (const [line, n] of a) diff += Math.max(0, n - (b.get(line) ?? 0));
  for (const [line, n] of b) diff += Math.max(0, n - (a.get(line) ?? 0));
  return diff;
}

/**
 * What the installation's landing hook refuses in this change (empty = nothing).
 * A hook that throws refuses the change too: an unchecked change does not land.
 * `hook` defaults to the installation's; pass null to judge as a fresh install.
 */
export function installationRefusals({ files, before = {}, hook = LANDING_HOOK }) {
  if (!hook || typeof hook.landingRefusals !== "function") return [];
  try {
    const r = hook.landingRefusals({ files: files ?? {}, before: before ?? {} });
    return Array.isArray(r) ? r.map(String) : [];
  } catch (e) {
    return [`the installation's landing check failed: ${e?.message ?? e}`];
  }
}

/**
 * The owner's own request, as decideLanding accepts it: what verifyOwnerRequest
 * returned after it checked the quote against the stored chat row and the
 * build request against the queue. Anything else (a bare quote string, a
 * caller's say-so) is not an owner request.
 */
export function isVerifiedOwnerRequest(owner) {
  return !!owner && owner.verified === true && owner.via === "chat-build"
    && typeof owner.quote === "string" && owner.quote.trim().length >= MIN_QUOTE_CHARS
    && typeof owner.message_id === "string" && owner.message_id.length > 0
    && typeof owner.build_request === "string" && owner.build_request.length > 0;
}

/** A quote shorter than this could be found in almost any message, so it proves nothing. */
export const MIN_QUOTE_CHARS = 12;

// The build-queue sources that are the owner's chat: a request the chat agent
// queued (bin/build-request), or the once-only rebuild of a card the owner
// signed (lib/self-improve-rebuild.mjs), which inherits that card's quote.
const OWNER_SOURCES = new Set(["chat", "approval-rebuild"]);
// A row id from the database (uuid or bigint), checked before it is put in a query.
const ROW_ID = /^[A-Za-z0-9-]{1,64}$/; // lang-regex-ok: a database row id, not words

/**
 * Verify that a change to a guarded file is the owner's own chat request.
 * Two checks, both structural, neither an interpretation of what was said:
 *
 *   provenance — the request id the chat-build trigger exported
 *     (JORI_CHAT_BUILD_REQUEST) names a build-queue file whose `source` is the
 *     owner's chat. A pipeline job (improvement-plan, the executor,
 *     system-issue-review, skill-repair, the cost review) runs without it.
 *   the quote — an exact, case-sensitive substring of the `content` of a
 *     user-role row in the messages table, written before the build was
 *     requested. When no message id is given, the newest such row is used.
 *
 * A rebuild carries the original card's quote over (`original`, the approved
 * row it rebuilds): a new quote cannot be swapped in on the way.
 *
 * I/O is injected so this module stays clock- and network-free:
 *   readBuildRequest(id) → the queue file's JSON, or null
 *   getMessage(id)       → { id, role, content, created_at } or null (throws when the read failed)
 *   findUserMessages({ before }) → [{ id, role, content, created_at }] newest first (throws when the read failed)
 *   getApproval(id)      → the approval row, or null (only for a rebuild)
 *
 * @returns {Promise<{ok: true, owner: object} | {ok: false, reasons: string[]}>}
 */
export async function verifyOwnerRequest({ quote, messageId = null, buildRequestId, rebuildOf = null, readBuildRequest, getMessage, findUserMessages, getApproval }) {
  const no = (...reasons) => ({ ok: false, reasons });
  if (!buildRequestId) return no("not started from a chat request: a change to a locked file is filed only by the chat build the owner asked for (JORI_CHAT_BUILD_REQUEST is unset)");
  let req = null;
  try { req = await readBuildRequest(buildRequestId); } catch { req = null; }
  if (!req || req.id !== buildRequestId) return no(`no build request ${buildRequestId} in the queue`);
  if (!OWNER_SOURCES.has(String(req.source))) return no(`build request ${buildRequestId} came from ${req.source || "an unknown source"}, not the owner's chat`);

  let q = typeof quote === "string" ? quote : "";
  let mid = messageId ? String(messageId) : null;
  if (req.source === "approval-rebuild") {
    if (!rebuildOf || req.rebuild_of !== rebuildOf) return no(`build request ${buildRequestId} rebuilds ${req.rebuild_of || "nothing"}, not ${rebuildOf || "(no --rebuild-of)"}`);
    let orig = null;
    try { orig = await getApproval(rebuildOf); } catch (e) { return no(`could not read approval ${rebuildOf}: ${e?.message || e}`); }
    const was = orig?.item_json?.owner_request;
    if (!isVerifiedOwnerRequest(was)) return no(`approval ${rebuildOf} did not quote the owner, so its rebuild cannot touch a locked file`);
    if (q && q !== was.quote) return no("a rebuild keeps the original card's quote; a different one was given");
    if (mid && mid !== was.message_id) return no("a rebuild keeps the original card's message; a different one was given");
    q = was.quote;
    mid = was.message_id;
  }

  if (q.trim().length < MIN_QUOTE_CHARS) return no(`the owner's quote must be at least ${MIN_QUOTE_CHARS} characters of their own message, copied exactly`);
  // A rebuild's message predates its original card, not the rebuild request.
  const before = req.source === "approval-rebuild" ? null : (req.requested_at || null);
  let row = null;
  try {
    if (mid) {
      if (!ROW_ID.test(mid)) return no(`not a message id: ${JSON.stringify(mid)}`); // lang-regex-ok: checks a row id's shape, not words
      row = await getMessage(mid);
      if (!row) return no(`no message ${mid}`);
      if (row.role !== "user") return no(`message ${mid} was not written by the owner (role ${row.role})`);
      if (typeof row.content !== "string" || !row.content.includes(q)) return no(`message ${mid} does not contain the quote word for word`);
    } else {
      const rows = (await findUserMessages({ before })) || [];
      row = rows.find((r) => r?.role === "user" && typeof r.content === "string" && r.content.includes(q)) || null;
      if (!row) return no("none of the owner's messages contains the quote word for word: copy it exactly from their message, or pass --owner-message-id");
    }
  } catch (e) {
    return no(`could not read the owner's messages: ${e?.message || e}`);
  }
  if (before && row.created_at && Date.parse(row.created_at) > Date.parse(before)) {
    return no(`message ${row.id} was written after the build was requested`);
  }
  return {
    ok: true,
    owner: { quote: q, message_id: String(row.id), message_created_at: row.created_at || null, build_request: buildRequestId, via: "chat-build", verified: true },
  };
}

/**
 * Decide how a verified change lands.
 *
 * @param {object} p
 * @param {Record<string,string>} p.files      repo-relative path → new content
 * @param {Record<string,string|null>} p.before path → current content (null = new file)
 * @param {"low"|"moderate"|"high"} p.risk
 * @param {string} p.category
 * @param {string} p.critic                     the critic's verdict line ("SAFE", "DEFER_TO_OPERATOR: …", …)
 * @param {number} [p.architecturalOptions]     how many viable approaches the classifier saw
 * @param {object|null} [p.hook]                the installation's landing hook (default: its _ext module; null: none)
 * @param {object|null} [p.owner]               the owner's verified chat request (verifyOwnerRequest), or null
 * @returns {{mode: "auto"|"card"|"refuse", reasons: string[], rails: object, lines: number, fileCount: number, redraft?: true, ownerCardable?: true}}
 */
export function decideLanding({ files, before = {}, risk, category, critic, architecturalOptions = 0, hook = LANDING_HOOK, owner = null }) {
  const paths = Object.keys(files ?? {});
  const rails = railsFor(paths);
  const lines = paths.reduce((s, p) => s + changedLines(before[p] ?? null, files[p]), 0);
  const base = { rails, lines, fileCount: paths.length };

  if (paths.length === 0) return { mode: "refuse", reasons: ["no files"], ...base };
  if (rails.forbidden.length) return { mode: "refuse", reasons: rails.forbidden.map((p) => `forbidden path: ${p}`), ...base };
  if (rails.lockCore.length) {
    return { mode: "refuse", reasons: rails.lockCore.map((p) => `the lock's own machinery, which not even a quoted request may change: ${p}`), ...base };
  }
  const ownerAsked = rails.recursion.length > 0 && isVerifiedOwnerRequest(owner);
  if (rails.recursion.length && !ownerAsked) {
    // `ownerCardable`: every guarded path here could go on a card if the owner
    // had asked for it in chat (rubric schema v6) — a hint for the caller's
    // message, never a route the caller can take on its own.
    return { mode: "refuse", ownerCardable: true, reasons: rails.recursion.map((p) => `the improvement pipeline's own controls: ${p}`), ...base };
  }
  const local = installationRefusals({ files, before, hook });
  if (local.length) return { mode: "refuse", redraft: true, reasons: local, ...base };
  if (architecturalOptions > 1) return { mode: "refuse", reasons: [`more than one viable approach — ${createRequire(import.meta.url)("./instance.cjs").instanceValue("owner_name")} picks`], ...base };

  const reasons = [];
  if (ownerAsked) for (const p of rails.recursion) reasons.push(`a locked file, changed only because the owner asked in chat (quoted on the card): ${p}`);
  for (const p of rails.cardOnly) reasons.push(`the daily-summary repair loop's own files change only on a Face-ID card: ${p}`);
  for (const p of rails.forceHigh) reasons.push(`high blast radius: ${p}`);
  if (String(risk).toLowerCase() === "high") reasons.push("classified high risk");
  if (CARD_CATEGORIES.has(String(category))) reasons.push(`category ${category}`);
  if (paths.length > MAX_FILES) reasons.push(`${paths.length} files (auto-apply limit ${MAX_FILES})`);
  if (lines > MAX_CHANGED_LINES) reasons.push(`${lines} changed lines (auto-apply limit ${MAX_CHANGED_LINES})`);
  if (String(critic ?? "").trim().toUpperCase() !== "SAFE") reasons.push(`critic did not say SAFE (${String(critic ?? "none").slice(0, 80)})`);

  return reasons.length ? { mode: "card", reasons, ...base } : { mode: "auto", reasons: [], ...base };
}

/**
 * The text the user reads, on a card or in the email: four plain-language parts,
 * in the order the user asked for — the problem, what it is costing now, the fix, and
 * what else it could affect — written for someone without the background.
 * Technical detail (verification, revert) follows, set apart.
 */
export function composeCard({ problem, impact, fix, sideEffects, details = "" }) {
  const missing = Object.entries({ problem, impact, fix, sideEffects })
    .filter(([, v]) => !String(v ?? "").trim())
    .map(([k]) => k);
  if (missing.length) throw new Error(`card text is missing: ${missing.join(", ")}`);
  const parts = [
    `What's wrong: ${String(problem).trim()}`,
    `Why it matters now: ${String(impact).trim()}`,
    `The fix: ${String(fix).trim()}`,
    `Side effects: ${String(sideEffects).trim()}`,
  ];
  if (String(details).trim()) parts.push(`Details: ${String(details).trim()}`);
  return parts.join("\n\n");
}
