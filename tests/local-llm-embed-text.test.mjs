// local-llm-embed-text.test.mjs — embedText normalises for uncased embedders.
// Run: node --test tests/local-llm-embed-text.test.mjs
//
// Ollama sends nomic-embed-text (an uncased model) raw text, so every
// capitalised word became [UNK] and two different names embedded the same.
// embedText applies the reference tokenizer's normalisation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { embedText } from "../lib/local-llm.mjs";

test("uncased models get lowercased, accent-stripped text", () => {
  assert.equal(embedText("Dana Levi — Relations", "nomic-embed-text"), "dana levi — relations");
  assert.equal(embedText("Café Ö", "nomic-embed-text:latest"), "cafe o");
  assert.equal(embedText("Dog", "all-minilm"), "dog");
});

test("names that differ only in letters stay different after normalising", () => {
  assert.notEqual(embedText("Dana Levi", "nomic-embed-text"), embedText("Dana Cohen", "nomic-embed-text"));
});

test("cased or unknown models get the text unchanged", () => {
  assert.equal(embedText("Dana Levi", "mxbai-embed-large"), "Dana Levi");
  assert.equal(embedText("Dana Levi", "my-nomic-embed-text"), "Dana Levi");
  assert.equal(embedText(null, "nomic-embed-text"), "");
});

test("an over-long input is halved and retried instead of failing", async () => {
  const { localLlmEmbed } = await import("../lib/local-llm.mjs");
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const { prompt } = JSON.parse(init.body);
    seen.push(prompt.length);
    if (prompt.length > 1000) return new Response('{"error":"the input length exceeds the context length"}', { status: 500 });
    return new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 });
  };
  try {
    assert.deepEqual(await localLlmEmbed("x".repeat(4000)), [0.1, 0.2]);
    assert.deepEqual(seen, [4000, 2000, 1000]);
    globalThis.fetch = async () => new Response("boom", { status: 500 });
    await assert.rejects(localLlmEmbed("short"), /500/);
  } finally {
    globalThis.fetch = real;
  }
});
