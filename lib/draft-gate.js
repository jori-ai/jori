// draft-gate — the two rules a Gmail DRAFT addressed to a third party has to
// satisfy before gmail-action is allowed to create it.
//
// WHY THIS EXISTS. The user's email-voice rules (no em/en dashes in what is
// written to a third party; a draft sent on the user's behalf closes with their
// signature) were written down and still unfollowed: each ask was "place it in
// my drafts", so the code path in use was gmail-action's createDraft /
// createDraftReply, which had no gate of any kind. Written down is not enforced.
//
// WHICH RULES: agent/local/config/draft-gate.json
//   {"forbid_dashes": true, "signature_token": "<a fixed token every sign-off contains>"}
// Both are off by default (a fresh install gates nothing). Tests and callers can
// pass forbidDashes / signatureToken explicitly.
//
// SCOPE IS THE WHOLE DESIGN. These checks fire only when a recipient is someone
// other than the authenticated account. A draft addressed solely to the user is
// a note to self; gating those repeats an earlier mistake in which the em-dash
// filter sat on the internal self-addressed path, blocking Jori's own digests
// to the user, while never touching the external path the rule was about.
//
// THE SIGNATURE CHECK IS A PRESENCE CHECK, DELIBERATELY. It asks whether a known
// fixed token appears in the draft. It does NOT ask whether the sign-off reads
// like the user, which is a question about meaning and belongs to a model rather
// than to a pattern (agent/CLAUDE.md Rule #0b). Every recorded signature variant
// contains the configured token, so the token is what it looks for. The
// asymmetry is deliberate too: a draft signed some other way is refused loudly
// and the composer re-runs, whereas a weak pass costs nothing this gate ever
// promised to catch.
//
// Consumed by bin/gmail-action. Pure (config read once, lazily) so it can be
// unit tested without a network or a Gmail token — see tests/draft-gate.test.mjs.

"use strict";

// This installation's rules (none by default). Compared case-insensitively.
let _config = null;
function config() {
  if (!_config) {
    const c = require("./instance.cjs").localConfig("draft-gate", { forbid_dashes: false, signature_token: "" });
    _config = { forbidDashes: !!c.forbid_dashes, signatureToken: String(c.signature_token || "").trim().toLowerCase() };
  }
  return _config;
}

// Structural parse of an RFC 5322 address list: `"Jane Doe" <jane@acme.com>,
// bob@example.com`. A machine-generated header format, never prose.
function parseAddressList(headerValue) {
  return String(headerValue || "")
    .split(",")
    .map((entry) => {
      const angle = entry.match(/<([^>]*)>/); // lang-regex-ok: pulls the addr-spec out of RFC 5322 header syntax, interprets nothing
      return (angle ? angle[1] : entry).trim().toLowerCase();
    })
    .filter(Boolean);
}

// Recipients that are not the authenticated account itself.
function externalRecipients(headerValue, selfAddress) {
  const self = String(selfAddress || "").trim().toLowerCase();
  return parseAddressList(headerValue).filter((addr) => addr !== self);
}

/**
 * Decide whether a draft may be created.
 *
 * @param {object}  args
 * @param {string}  args.to             raw To header value (address list)
 * @param {string} [args.subject]
 * @param {string} [args.body]
 * @param {boolean} [args.inheritedSubject] true when the subject came from the
 *   email being replied to rather than from the composer (see below)
 * @param {string}  args.selfAddress    the authenticated Gmail account
 * @param {boolean} [args.allowDashes]  GMAIL_ACTION_ALLOW_DASHES escape hatch
 * @param {boolean} [args.allowUnsigned] GMAIL_ACTION_ALLOW_UNSIGNED escape hatch
 * @param {boolean} [args.forbidDashes] the dash rule; default from config
 * @param {string}  [args.signatureToken] the signature token; default from config ("" = no check)
 * @returns {{ok: boolean, external: string[], rule?: "em-dash"|"signature", detail?: string, message?: string}}
 *   `message` is what gmail-action prints after "gmail-action <command>: ".
 */
function checkDraft({
  to,
  subject = "",
  body = "",
  inheritedSubject = false,
  selfAddress,
  allowDashes = false,
  allowUnsigned = false,
  forbidDashes = config().forbidDashes,
  signatureToken = config().signatureToken,
} = {}) {
  const external = externalRecipients(to, selfAddress);
  const token = String(signatureToken || "").trim().toLowerCase();

  // Note to self. Neither rule was written about these.
  if (external.length === 0) return { ok: true, external };

  // The dash rule is about what Jori WRITES, never about what it quotes. A
  // reply carries the other party's subject forward verbatim (`Re: <theirs>`),
  // and third parties use em dashes constantly — "Re: The lease — can you
  // come Thursday instead?" is a typical vendor subject. Judging an inherited subject would refuse a perfectly good reply
  // over punctuation the composer neither wrote nor can change from the CLI,
  // and the only way out would be GMAIL_ACTION_ALLOW_DASHES, which switches the
  // check off for the body too — the half the rule actually targets.
  const haystack = inheritedSubject ? String(body || "") : `${subject || ""}\n${body || ""}`;

  // Checked before the signature so a draft breaking both reports the dash
  // first — deterministic ordering keeps the unit test and the error the
  // composer sees in agreement.
  if (forbidDashes && !allowDashes) {
    const found = haystack.match(/.{0,40}[—–].{0,40}/); // lang-regex-ok: two literal punctuation codepoints plus surrounding context for the error, no interpretation
    if (found) {
      return {
        ok: false, external, rule: "em-dash", detail: found[0],
        message: `em/en dash in the subject or body of a draft to ${external.join(", ")} (violates feedback-no-em-dashes). Example: ${JSON.stringify(found[0])}. Use a plain hyphen, comma, semicolon, period or parens, or set GMAIL_ACTION_ALLOW_DASHES=1 to override.`,
      };
    }
  }

  if (token && !allowUnsigned && !String(body || "").toLowerCase().includes(token)) {
    return {
      ok: false, external, rule: "signature", detail: "",
      message: `draft to ${external.join(", ")} has no signature (violates the email-voice rule: a draft sent on the user's behalf closes with their name and phone number). Add the sign-off, or set GMAIL_ACTION_ALLOW_UNSIGNED=1 to override.`,
    };
  }

  return { ok: true, external };
}

/**
 * Decide whether gmail-action may SEND a message on the user's behalf (`send`
 * with --from). The em-dash rule only — moved here from gmail-action's
 * sendMessage, where it had been since it moved off email-send. Pinned rule
 * feedback-no-em-dashes was written about a draft outreach email a third
 * party would read, not about internal report titles the user reads alone —
 * so it belongs on the "on-behalf-of-the-user to a third party" path, not on
 * email-send's self-addressed digests/alerts. GMAIL_ACTION_ALLOW_DASHES=1
 * (allowDashes) overrides for one-off paste-throughs.
 *
 * @returns {{ok: boolean, rule?: "em-dash", detail?: string, message?: string}}
 */
function checkSend({ subject = "", body = "", allowDashes = false, forbidDashes = config().forbidDashes } = {}) {
  if (allowDashes || !forbidDashes) return { ok: true };
  const haystack = `${subject}\n${body}`;
  if (/[—–]/.test(haystack)) { // lang-regex-ok: two literal punctuation codepoints, no interpretation
    const m = haystack.match(/.{0,40}[—–].{0,40}/); // lang-regex-ok: same codepoints plus surrounding context for the error
    return {
      ok: false, rule: "em-dash", detail: m?.[0] || "",
      message: `em/en dash found in subject or body (violates feedback-no-em-dashes). Example: ${JSON.stringify(m?.[0] || "")}. Replace with comma/semicolon/period/parens/hyphen, or set GMAIL_ACTION_ALLOW_DASHES=1 to override.`,
    };
  }
  return { ok: true };
}

module.exports = { checkDraft, checkSend, parseAddressList, externalRecipients, config };
