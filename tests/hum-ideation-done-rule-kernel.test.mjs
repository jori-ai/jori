// hum-ideation-done-rule-kernel.test.mjs — the hum-ideation playbook's
// done-annotation rule ("For any idea touching Google Tasks or a project memory
// file") spans ALL categories, not only event-prep / stuck-task. Found by its
// own subject line, not by ordinal (a rule inserted earlier once shifted the
// numbering and the check read the wrong rule).
// Run: node --test tests/hum-ideation-done-rule-kernel.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYBOOK = join(ROOT, "agent/ops-agent/jobs/hum-ideation.md");
const SUBJECT = "**For any idea touching Google Tasks or a project memory file:**";

/** The numbered rule whose text starts with SUBJECT, up to the next numbered rule or heading. */
function doneRule(md) {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.includes(SUBJECT));
  if (i < 0) return null;
  const out = [lines[i]];
  for (const l of lines.slice(i + 1)) {
    const t = l.trimStart();
    if (t.startsWith("#") || /^\d+\.\s/.test(t)) break; // lang-regex-ok: markdown list numbering in our own playbook
    out.push(l);
  }
  return out.join("\n");
}

test("kernel playbook: the done-annotation rule still spans ALL categories", () => {
  const rule = doneRule(readFileSync(PLAYBOOK, "utf8"));
  assert.ok(rule, "the done-annotation rule is gone from the kernel playbook entirely");
  assert.ok(["regardless of category", "ALL categories"].some((p) => rule.includes(p)),
    "the rule lost its 'ALL categories' scope marker — regression to event-prep/stuck-task only");
});

test("the rule is found by subject even when another rule takes its number", () => {
  const md = "1. **Sandbox tooling:** x\n8. **Other rule:** y\n9. " + SUBJECT + " applies to ALL categories.\n   more text\n10. **Next:** z\n";
  const rule = doneRule(md);
  assert.ok(rule.includes("ALL categories") && rule.includes("more text"));
  assert.ok(!rule.includes("Next"));
});
