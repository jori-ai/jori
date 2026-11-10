// The wiki renderer draws a markdown task list as checkboxes (project pages' ## Tasks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const r = createRequire(import.meta.url)("../lib/wiki-render.js");

test("a markdown task list renders as checkboxes, not brackets", () => {
  const html = r.renderMarkdown("- [ ] Book the venue · due 2027-02-01\n- [x] Measure the room\n- [-] Old idea\n- plain item", { resolveLink: () => true });
  assert.match(html, /<li class="task open"><span class="tick" aria-label="open">☐<\/span> Book the venue/);
  assert.match(html, /<li class="task done">/);
  assert.match(html, /<li class="task dropped">/);
  assert.match(html, /<li>plain item<\/li>/);
  assert.ok(!html.includes("[ ]"));
});
