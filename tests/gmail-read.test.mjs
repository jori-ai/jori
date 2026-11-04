// lib/gmail-read.mjs — the read-only Gmail helpers: pagination, MIME walking,
// HTML flattening and story-link extraction. The transport is a stub; no
// network, no mailbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTransport, searchIds, getMessage, header, bodies, htmlToText, storyLinks, gmailLink } from "../lib/gmail-read.mjs";

const b64u = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("searchIds follows nextPageToken and stops at max", async () => {
  const calls = [];
  setTransport(async (p) => {
    calls.push(p);
    if (!p.includes("pageToken")) return { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "T2" };
    return { messages: [{ id: "c" }, { id: "d" }] };
  });
  try {
    assert.deepEqual(await searchIds("from:x subject:\"a b\""), ["a", "b", "c", "d"]);
    assert.match(calls[0], /q=from%3Ax%20subject%3A%22a%20b%22/);
    assert.match(calls[1], /pageToken=T2/);
    assert.deepEqual(await searchIds("q", { max: 3 }), ["a", "b", "c"]);
  } finally { setTransport(null); }
});

test("searchIds on an empty result is []", async () => {
  setTransport(async () => ({ resultSizeEstimate: 0 }));
  try { assert.deepEqual(await searchIds("nothing"), []); } finally { setTransport(null); }
});

test("getMessage asks for the full format", async () => {
  let asked = "";
  setTransport(async (p) => { asked = p; return { id: "m1" }; });
  try { assert.equal((await getMessage("m1")).id, "m1"); assert.equal(asked, "/messages/m1?format=full"); } finally { setTransport(null); }
});

const MSG = {
  payload: {
    headers: [{ name: "Subject", value: "Your itinerary" }, { name: "From", value: "Air <no-reply@example-air.test>" }],
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64u("Plain ±body") } },
      { mimeType: "multipart/related", parts: [{ mimeType: "text/html", body: { data: b64u("<p>Hi&nbsp;there</p><br>Flight&amp;more") } }] },
      { mimeType: "text/plain", body: { data: b64u("second plain, ignored") } },
    ],
  },
};

test("header is case-insensitive; a missing header is null", () => {
  assert.equal(header(MSG, "subject"), "Your itinerary");
  assert.equal(header(MSG, "X-Nope"), null);
  assert.equal(header({}, "Subject"), null);
});

test("bodies takes the first html and plain part, decoding base64url", () => {
  const { html, plain } = bodies(MSG);
  assert.equal(plain, "Plain ±body");
  assert.match(html, /^<p>Hi&nbsp;there/);
  assert.deepEqual(bodies({ payload: { mimeType: "text/plain" } }), { html: null, plain: null });
});

test("htmlToText drops script/style, breaks blocks, decodes entities", () => {
  const t = htmlToText("<head><title>x</title></head><style>.a{}</style><div>One</div><p>Two &amp; &lt;3&gt; &#39;q&#39;</p>   <span>  three </span>");
  assert.equal(t, "One\n Two & <3> 'q'\n three");
  assert.equal(htmlToText(null), "");
});

test("storyLinks keeps real anchors in order, deduped, plumbing and images removed", () => {
  const html = [
    '<a href="https://news.example.test/story-1?a=1&amp;b=2">First <b>story</b></a>',
    '<a href="https://news.example.test/unsubscribe?u=1">Unsubscribe</a>',
    '<a href="mailto:x@example.test">mail</a>',
    '<a href="https://cdn.example.test/pic.png">img</a>',
    '<a href="https://news.example.test/story-1?a=1&amp;b=2">dup</a>',
    '<a href="https://news.example.test/empty"><img src="x"></a>',
    '<a href="/relative">rel</a>',
    '<a class="x" href="https://news.example.test/story-2">Second</a>',
  ].join("");
  assert.deepEqual(storyLinks(html), [
    { url: "https://news.example.test/story-1?a=1&b=2", text: "First story" },
    { url: "https://news.example.test/story-2", text: "Second" },
  ]);
  assert.equal(storyLinks(html, { max: 1 }).length, 1);
});

test("gmailLink defaults to the first signed-in account", () => {
  assert.equal(gmailLink("abc"), "https://mail.google.com/mail/u/0/#inbox/abc");
  assert.equal(gmailLink("abc", { account: 2 }), "https://mail.google.com/mail/u/2/#inbox/abc");
});
