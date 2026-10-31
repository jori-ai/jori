"use strict";
// reservoir-photo-policy — when to fetch, retry, or give up on an entry's photo.
//
// The reservoir photo pass re-tries every photo-less entry on every nightly run.
// That is right for a transient miss (Places hiccup, upload blip) and wrong for
// the permanent kind, which is what actually accumulates: an open-air market
// keyed on a square's street address ("Place du Martray, Lamballe"), or a food
// "dish" that is really a comma-joined menu blurb from the dining pass
// ("cuisine de saison en circuit court, produits locaux"). Neither Places nor
// the wiki nor Unsplash will grow a photo for those tomorrow, so the retry
// never succeeds — it just burns a lookup a night and pins the job's reported
// failure count at a number that can never reach zero (17, every night since
// the guides were built).
//
// So an entry that has missed MAX_PHOTO_ATTEMPTS times is dead-lettered: left
// alone by later runs and reported separately from live failures, which keeps
// the failure count meaningful as a signal that something is newly broken.
// `--refresh` / `--refresh-food` / `--retry-failed` revive dead-lettered
// entries, and any successful fetch clears the counter.
const MAX_PHOTO_ATTEMPTS = 3;

// "have" — already has the photo we want, nothing to do.
// "dead" — missed too many times, permanently skipped until explicitly revived.
// "fetch" — go look for a photo.
// What KIND of photo this entry is supposed to carry. Food splits in two
// (schema change 2026-07-21): a "dish" entry wants a picture of the food, a
// "table" entry is a restaurant recommended for itself and wants a picture of
// the restaurant. Anything else wants its own place photo.
function wantedKind(entry, isFood) {
  if (!isFood) return null;
  return entry.kind === "table" || !entry.dish ? "restaurant" : "dish";
}

function photoAction(entry, opts = {}) {
  const { isFood = false, forceRefresh = false, retryFailed = false } = opts;
  if (forceRefresh || retryFailed) return "fetch";
  // A food entry keeps its photo only if it's already the RIGHT KIND of photo.
  // The retroactive first pass gave foods restaurant photos with no
  // photo_kind at all, and the pass after it gave every food entry a "dish"
  // photo — including the ones that were really restaurants, which is how a
  // menu blurb ended up illustrated with a stock seafood platter.
  const want = wantedKind(entry, isFood);
  if (entry.photo_url && (!want || entry.photo_kind === want)) return "have";
  if ((entry.photo_attempts || 0) >= MAX_PHOTO_ATTEMPTS) return "dead";
  return "fetch";
}

// Stamp a miss onto the entry. Returns true if this miss is the one that
// dead-letters it, so the caller can say so in the log exactly once.
function recordPhotoFailure(entry, now = new Date()) {
  entry.photo_attempts = (entry.photo_attempts || 0) + 1;
  entry.photo_failed_at = now.toISOString();
  return entry.photo_attempts === MAX_PHOTO_ATTEMPTS;
}

// A photo landed — forget the misses, so a later gap starts from a clean slate.
function clearPhotoFailures(entry) {
  delete entry.photo_attempts;
  delete entry.photo_failed_at;
}

module.exports = { MAX_PHOTO_ATTEMPTS, photoAction, recordPhotoFailure, clearPhotoFailures, wantedKind };
