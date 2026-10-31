# Meal-offer reply (ask-first venue recommendations)

**The requirement:** ask generically ("would you like a restaurant recommendation for lunch?") and search for one only on a yes. Unprompted restaurant picks were mostly snoozed, deferred or ignored, and the Google Places searches behind them on every hum tick were most of the Places bill.

## How it flows

1. **Offer (no search).** Hum's `meal_offer` lane (`agent/scripts/hum-harvesters/meal_offer.mjs`) proposes an offer at most once per meal window per day (the windows and their wording are in `agent/local/config/meals.json` `windows`; default lunch 11:45–14:30 and dinner 18:00–20:30, local time), only when the user is out (not at a place matching `home_labels`) with a fix ≤45 min old. The ranker decides whether the moment is right; hum-ping sends it like any ping. No Google call has happened.
2. **The user's reply.** phone-channel's `[Hum state]` block lists the **Open meal offer** for an hour after it was sent, with the exact commands. Whether the user accepted is your judgment (Rule #0b).
3. **Yes → `meal-pick --ping-id <id>`.** The only hum-adjacent path allowed to search Places: the user's own tagged places within walking distance first (when the installation has a source for them, `meals.json` `tagged_places_cmd`; walking distance is `lib/walking.mjs`, 20 minutes ≈ 1,280 m by default), then ONE standard-tier text search (no reviews/overview — not the Atmosphere tier), cached, lane `hum-meal-offer`, with a daily cap in `lib/places-tier-policy.json`. It uses the user's newest fix if they have moved since the offer. Output: `picks` (ranked for local interest, not popularity), `rules`, and a `note` if Places refused (not set up, budget or policy).
4. **Reply** with one to three picks, warmest first: name, walking minutes, one specific reason. Apply every line of `rules` — the output carries the user's own meal preferences (`meals.json` `rules`), so follow them as written. If `picks` is empty or Places refused, say so plainly and offer the user's tagged places or nothing; never invent a venue.
5. **File the outcome:** `jori hum feedback <id> helpful` on a yes, `skip` on a no.

## Never

- Search for a meal the user did not say yes to.
- Run `places` directly for this; `meal-pick` carries the lane, tier and walking radius.
- Treat a reply to a different ping as a yes to the offer — the `[Hum routing]` / `[Hum open items]` rules in Hum Inbound Handling still decide which item a message answers.
