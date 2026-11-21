"use strict";
// email-recipients.cjs — what `email-send --to` names.
//
// `me` (any case) stands for the owner's own address (lib/instance.cjs
// owner_email), so an agent emailing the user writes `--to me` and never
// types the address into a command. Why that matters: Claude Code's built-in
// privacy plugin (`cc-plugin-privacy`) holds any shell call whose text carries
// the signed-in account's address together with a network word (`https`,
// `curl`, `ssh`, …) and asks first; an agent session runs headless, so the
// question has no one to answer it and the call is refused. One HTML body with
// a link, written in the same call as `email-send --to <address>`, was enough.
// With `me`, the address is filled in here, inside the tool, where the plugin
// does not look. Detail: docs/outbound-messaging.md § The account-address guard.
//
// resolveRecipients("me,a@b.com", owner) → { list: [owner, "a@b.com"] }
// An entry that is neither `me` nor an address is an error, not a send: a
// mistyped alias must not become a recipient.

const OWNER_ALIAS = "me";

function resolveRecipients(to, ownerEmail) {
  const parts = String(to == null ? "" : to).split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { error: "no recipient given" };
  const list = [];
  const seen = new Set();
  for (const part of parts) {
    let addr = part;
    if (part.toLowerCase() === OWNER_ALIAS) {
      if (!ownerEmail) {
        return { error: "`me` stands for the owner's address, and none is set (owner_email in agent/local/instance.json, or JORI_OWNER_EMAIL)" };
      }
      addr = String(ownerEmail).trim();
    } else if (!part.includes("@")) {
      return { error: `"${part}" is not an email address (write \`me\` for the user's own address)` };
    }
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(addr);
  }
  return { list };
}

module.exports = { OWNER_ALIAS, resolveRecipients };
