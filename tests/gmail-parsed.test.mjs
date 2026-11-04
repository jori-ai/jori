// lib/gmail-parsed.mjs parsePayload — the structural half of the minimal Gmail
// reader: MIME walk, every href kept (a "click to confirm" anchor survives
// without a plain part), a text fallback from HTML, lowercased headers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePayload } from "../lib/gmail-parsed.mjs";

const b64u = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("plain part wins for text; hrefs come from the HTML part, &amp; decoded", () => {
  const r = parsePayload({
    headers: [{ name: "Subject", value: "Confirm" }, { name: "From", value: "Box Office <tickets@example.com>" }],
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64u("Click to confirm: https://example.com/c?id=1088924") } },
      { mimeType: "text/html", body: { data: b64u('<a href="https://example.com/c?id=1088924&amp;t=2">Confirm</a><a href=\'https://example.com/x\'>x</a>') } },
    ],
  });
  assert.equal(r.text, "Click to confirm: https://example.com/c?id=1088924");
  assert.deepEqual(r.hrefs, ["https://example.com/c?id=1088924&t=2", "https://example.com/x"]);
  assert.equal(r.headers.subject, "Confirm");
  assert.equal(r.headers.from, "Box Office <tickets@example.com>");
});

test("no plain part: text is the HTML with style/script and tags stripped", () => {
  const r = parsePayload({ mimeType: "text/html", body: { data: b64u("<style>p{}</style><p>Hello&nbsp;there &amp; welcome</p><script>x()</script>") } });
  assert.equal(r.text.replace(/\s+/g, " ").trim(), "Hello there & welcome");
  assert.deepEqual(r.hrefs, []);
});

test("an empty payload is empty, not an error", () => {
  assert.deepEqual(parsePayload(undefined), { text: "", hrefs: [], headers: {} });
});
