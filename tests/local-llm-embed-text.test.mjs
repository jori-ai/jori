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
