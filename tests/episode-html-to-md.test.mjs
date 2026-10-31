// episode-html-to-md.test.mjs — unit tests for the HTML→markdown converter
// that ingests daily_summaries.narrative into the wiki.
// Run: node --test tests/episode-html-to-md.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { htmlToMarkdown, inlineToMd, decodeEntities } = require(
  "../lib/episode-html-to-md.js",
);

test("plain prose passes through unchanged", () => {
  const md = htmlToMarkdown("Just plain prose, no HTML.\n");
  assert.equal(md.trim(), "Just plain prose, no HTML.");
});

test("decodes common HTML entities", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeEntities("&quot;hi&quot;"), '"hi"');
  assert.equal(decodeEntities("Stop &amp; Shop"), "Stop & Shop");
});

test("strips outer styled div wrapper", () => {
  const html = `<div style="font-family:sans-serif;max-width:600px">
  <h1>Day of Test</h1>
  <p>Body line.</p>
</div>`;
  const md = htmlToMarkdown(html);
  assert.match(md, /^# Day of Test\n\nBody line\.\n$/);
});

test("promotes h1/h2/h3 to markdown headings", () => {
  const html = `<h1 style="x">Title</h1><h2 style="y">Section</h2><h3>Sub</h3>`;
  const md = htmlToMarkdown(html);
  assert.match(md, /^# Title/);
  assert.match(md, /\n## Section/);
  assert.match(md, /\n### Sub/);
});

test("visit-card div is unwrapped, h3 + p kept", () => {
  const html = `<div class="visit" style="x">
  <h3>10:00–11:00 · <b>Coffee shop</b> · 1h · with Sam</h3>
  <p>Morning stop.</p>
</div>`;
  const md = htmlToMarkdown(html);
  assert.match(md, /### 10:00–11:00 · \*\*Coffee shop\*\* · 1h · with Sam/);
  assert.match(md, /Morning stop\./);
});

test("inline tags become markdown", () => {
  assert.equal(inlineToMd("<b>bold</b>"), "**bold**");
  assert.equal(inlineToMd("<strong>also bold</strong>"), "**also bold**");
  assert.equal(inlineToMd("<em>italic</em>"), "*italic*");
  assert.equal(inlineToMd("<i>also italic</i>"), "*also italic*");
  assert.equal(inlineToMd("<code>x</code>"), "`x`");
});

test("img becomes markdown image", () => {
  const html = `<img src="https://example.com/a.jpg" alt="caption" style="x">`;
  const md = htmlToMarkdown(html);
  assert.equal(md.trim(), "![caption](https://example.com/a.jpg)");
});

test("ul/li becomes markdown list", () => {
  const html = `<ul><li>First</li><li><b>Second</b> item</li></ul>`;
  const md = htmlToMarkdown(html);
  assert.match(md, /^- First\n- \*\*Second\*\* item/);
});

test("a href becomes markdown link", () => {
  const html = `<p>See <a href="https://example.com">this</a>.</p>`;
  const md = htmlToMarkdown(html);
  assert.match(md, /See \[this\]\(https:\/\/example\.com\)\./);
});

test("matunuck day round-trip: yields scannable markdown", () => {
  // Use the actual 2026-05-09 narrative shape — outer div + heading +
  // subtitle div + alternating travel-narration p / visit-card div +
  // bottom h2 + ul sections.
  const html = `<div style="font-family:sans-serif;max-width:600px">
<h1 style="font-size:22px">Day of Saturday, May 9, 2026</h1>
<div style="color:#888">Riverside → Lakeview — a day-trip.</div>
<p style="color:#888"><em>Last-night until 07:34.</em></p>
<div class="visit" style="x">
<h3>00:05–07:34 · <b>Home (Riverside)</b> · 7h29m</h3>
<p>Overnight.</p>
</div>
<p style="color:#888;font-size:13px"><em>train to Lakeview.</em></p>
<div class="visit" style="y">
<h3>10:53–11:42 · <b>Budget Lakeview</b> · 49m · with Sam</h3>
<p>Rental car pickup.</p>
<img src="https://x.test/a.jpg" alt="thumb">
</div>
<h2 style="z">Day's other anchors</h2>
<ul style="padding-left:20px">
<li><b>Lottery win:</b> 2 tickets to claim.</li>
<li><b>Host app:</b> A guest booked checkout.</li>
</ul>
</div>`;
  const md = htmlToMarkdown(html);
  assert.match(md, /^# Day of Saturday, May 9, 2026/);
  assert.match(md, /Riverside → Lakeview — a day-trip\./);
  assert.match(md, /\*Last-night until 07:34\.\*/);
  assert.match(md, /### 00:05–07:34 · \*\*Home \(Riverside\)\*\* · 7h29m\n\nOvernight\./);
  assert.match(md, /\*train to Lakeview\.\*/);
  assert.match(md, /### 10:53–11:42 · \*\*Budget Lakeview\*\* · 49m · with Sam/);
  assert.match(md, /!\[thumb\]\(https:\/\/x\.test\/a\.jpg\)/);
  assert.match(md, /## Day's other anchors/);
  assert.match(md, /- \*\*Lottery win:\*\* 2 tickets to claim\./);
  assert.match(md, /- \*\*Host app:\*\* A guest booked checkout\./);
  // No raw HTML tags should survive.
  assert.doesNotMatch(md, /<\/?(?:div|p|h[1-6]|ul|li|b|em|i|strong|img|span)\b/i);
});

test("paragraph with no tags survives", () => {
  const html = `Hello world, no HTML here.`;
  const md = htmlToMarkdown(html);
  assert.match(md, /^Hello world, no HTML here\./);
});
