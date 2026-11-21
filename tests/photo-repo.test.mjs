// photo-repo: covers for card options, and decision cards carrying a picture. Run: node --test tests/photo-repo.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { renderQuestionChoices, renderDecision } from "../lib/decision-queue.mjs";
import { at } from "./fixtures/fake-geo.mjs";

const require = createRequire(import.meta.url);
const repo = require("../lib/photo-repo.js");

const PLACES = [
  { id: "pl_1", name: "Corner Coffee", page_id: "place_corner_coffee", cover_url: "https://s/thumbs/A.jpg", ...at(0, 0), norm_names: ["corner coffee", "corner coffee company"] },
  { id: "pl_2", name: "Corner Coffee", page_id: "place_corner_coffee_2", cover_url: "https://s/thumbs/B.jpg", ...at(2000, 4000), norm_names: ["corner coffee"] },
  { id: "pl_3", name: "Night Club", page_id: "place_night_club", cover_url: "https://s/thumbs/C.jpg", ...at(-300, -1500), norm_names: ["night club"] },
];
// The one query placeCovers makes: places with a page and a cover whose folded names overlap.
const request = async (pq) => {
  assert.match(pq, /^\/rest\/v1\/places\?/);
  const ov = decodeURIComponent(pq.split("norm_names=ov.")[1]).slice(1, -1).split(",").map((s) => s.replace(/^"|"$/g, ""));
  return PLACES.filter((p) => p.norm_names.some((n) => ov.includes(n)));
};

test("norm folds case, accents and punctuation only", () => {
  assert.equal(repo.norm("Café  Nine!"), "cafe nine");
  assert.equal(repo.norm("JOE—Coffee"), "joe coffee");
});

test("placeCovers: an option naming a place nearby gets that branch's cover; other options get nothing", async () => {
  const r = await repo.placeCovers({ ...at(8, 11), names: ["Corner Coffee", "Just driving", "night club"] }, { request });
  assert.equal(r["Corner Coffee"].url, "https://s/thumbs/A.jpg");
  assert.equal(r["Corner Coffee"].page_id, "place_corner_coffee");
  assert.equal(r["Just driving"], undefined);
  assert.equal(r["night club"], undefined); // 1.5 km away: outside the radius
});

test("placeCovers without a point names a place only when exactly one carries the name", async () => {
  const r = await repo.placeCovers({ names: ["Corner Coffee", "Night Club"] }, { request });
  assert.equal(r["Corner Coffee"], undefined); // two branches: ambiguous
  assert.equal(r["Night Club"].url, "https://s/thumbs/C.jpg");
});

test("a decision card carries the question's picture and per-option pictures; a hum question card its cover", () => {
  const card = { header: "Dinner", question: "How was Night Club?", options: [{ label: "Loved it", source_index: 0 }, { label: "Not for us", source_index: 1 }], recommended: null };
  const { choices } = renderDecision({ ref: "rst:1", q: { options: ["Loved it", "Not for us"], image_url: "https://s/thumbs/C.jpg", option_images: ["https://s/x.jpg"] } }, card);
  assert.equal(choices.image_url, "https://s/thumbs/C.jpg");
  assert.equal(choices.options[0].image_url, "https://s/x.jpg");
  assert.equal(choices.options[1].image_url, undefined);
  const plain = renderDecision({ ref: "rst:1", q: { options: ["Loved it", "Not for us"], image_url: "javascript:alert(1)" } }, card).choices;
  assert.equal(plain.image_url, undefined); // only https URLs ride on a card
  const hum = renderQuestionChoices({ question: "How was the lounge?", options: ["Great", "Meh"], imageUrl: "https://s/thumbs/L.jpg" });
  assert.equal(hum.choices.image_url, "https://s/thumbs/L.jpg");
  assert.equal(hum.choices.ref, undefined);
});
