#!/usr/bin/env python3
"""places-ranking.test.py — which ranking `places` applies to a page, and what it does.

A page of restaurants, cafes and bars gets the restaurant ranking (a rating
shrunk toward a prior until enough reviews accumulate, plus a destination
bonus); every other page keeps the older composite score. These tests pin the
choice (made from Google's machine type ids, never from the words of the
query: Rule #0b) and the ordering. They need nothing but Python.

Run: python3 tests/places-ranking.test.py
"""
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))

mod = type(sys)("places_ranking_mod")
mod.__file__ = os.path.join(REPO, "bin", "places")
exec(compile(open(os.path.join(REPO, "bin", "places")).read(), "places", "exec"),
     mod.__dict__)

ORIGIN = (12.3456, -65.4321)
STEP = 0.0001  # degrees per offset unit (~11 m of latitude)


def place(pid, rating, count, dlat, dlng, ptype="restaurant", open_now=True):
    """dlat / dlng: offsets from ORIGIN in STEP units."""
    dlat, dlng = dlat * STEP, dlng * STEP
    return {
        "id": pid,
        "displayName": {"text": pid},
        "formattedAddress": f"{pid} St",
        "location": {"latitude": ORIGIN[0] + dlat, "longitude": ORIGIN[1] + dlng},
        "rating": rating,
        "userRatingCount": count,
        "primaryType": ptype,
        "currentOpeningHours": {"openNow": open_now},
    }


def page(ptype="restaurant"):
    """Six places within a few hundred metres of each other, so each one is judged
    against its neighbours. Under the older composite the 4.5-star place with 6,000
    reviews comes first; under the restaurant ranking the 4.7 with 800 does."""
    return [
        place("p0", 4.3, 300, 10, 0, ptype),
        place("p1", 4.4, 300, -8, 6, ptype),
        place("p2", 4.6, 120, 4, -12, ptype),
        place("p3", 4.5, 6000, -12, -4, ptype),
        place("p4", 4.8, 40, 13, 10, ptype),
        place("p5", 4.7, 800, -3, 13, ptype),
    ]


def run(places, rank="auto", limit=20):
    buf = io.StringIO()
    with redirect_stdout(buf):
        mod.process_results({"places": places}, ORIGIN[0], ORIGIN[1], limit, as_json=True, rank=rank)
    out = json.loads(buf.getvalue())
    return out["ranking"], [r["name"] for r in out["results"]]


class WhichRanking(unittest.TestCase):
    def test_a_page_of_restaurants_gets_the_restaurant_ranking(self):
        ranking, order = run(page("restaurant"))
        self.assertEqual(ranking, "restaurant")
        self.assertEqual(order[0], "p5")

    def test_the_same_numbers_on_a_non_food_page_keep_the_older_composite(self):
        ranking, order = run(page("art_gallery"))
        self.assertEqual(ranking, "default")
        self.assertEqual(order[0], "p3")

    def test_the_two_formulas_really_differ_on_this_page(self):
        self.assertNotEqual(run(page(), rank="restaurant")[1][0], run(page(), rank="default")[1][0])

    def test_rank_flag_overrides_the_page(self):
        self.assertEqual(run(page("art_gallery"), rank="restaurant")[0], "restaurant")
        self.assertEqual(run(page("restaurant"), rank="default")[0], "default")

    def test_a_strict_majority_of_food_decides(self):
        def mixed(food, other):
            ps = page()
            for i, p in enumerate(ps):
                p["primaryType"] = "cafe" if i < food else "park"
            return ps[:food + other]
        self.assertEqual(run(mixed(4, 2))[0], "restaurant")
        self.assertEqual(run(mixed(3, 3))[0], "default")     # half is not a majority
        self.assertEqual(run(mixed(2, 4))[0], "default")

    def test_a_page_with_no_type_ids_is_not_guessed_at(self):
        # An entry cached before primaryType was in the field mask.
        ps = page()
        for p in ps:
            del p["primaryType"]
        self.assertEqual(run(ps)[0], "default")

    def test_cuisine_ids_and_drink_places_count_as_food(self):
        for t in ("restaurant", "ramen_restaurant", "israeli_restaurant", "cafe", "coffee_shop",
                  "bakery", "bar", "pub", "wine_bar", "deli", "diner"):
            self.assertTrue(mod.is_food_type(t), t)
        for t in ("gas_station", "pharmacy", "park", "art_gallery", "lodging", "", None):
            self.assertFalse(mod.is_food_type(t), t)


class AppOrdering(unittest.TestCase):
    def test_open_places_come_before_closed_ones_whatever_their_rating(self):
        ps = page()
        ps[4]["currentOpeningHours"]["openNow"] = False       # p4, a 4.8
        ps[2]["currentOpeningHours"]["openNow"] = False       # p2, a 4.6
        _, order = run(ps, rank="restaurant")
        self.assertEqual(set(order[-2:]), {"p4", "p2"})

    def test_the_4_2_rating_floor_still_applies(self):
        ps = page() + [place("low", 3.9, 90000, 0.0, 0.0)]
        _, order = run(ps, rank="restaurant")
        self.assertNotIn("low", order)

    def test_order_follows_the_apps_score_with_the_page_bonus(self):
        ps = page()
        spots = [(p["location"]["latitude"], p["location"]["longitude"]) for p in ps]
        bonus = mod.destination_bonuses(spots, [p["userRatingCount"] for p in ps])
        expected = sorted((p["displayName"]["text"] for p in ps),
                          key=lambda n: -mod.app_ranking_score(
                              next(p["rating"] for p in ps if p["displayName"]["text"] == n),
                              next(p["userRatingCount"] for p in ps if p["displayName"]["text"] == n),
                              bonus[[p["displayName"]["text"] for p in ps].index(n)]))
        self.assertEqual(run(ps, rank="restaurant")[1], expected)


class Formula(unittest.TestCase):
    def test_shrunk_rating_known_values(self):
        self.assertAlmostEqual(mod.app_quality(4.5, 1000), (4.5 * 1000 + 40 * 4.0) / 1040)
        self.assertAlmostEqual(mod.app_quality(5.0, 1), (5.0 + 160) / 41)     # one review barely moves 4.0
        self.assertEqual(mod.app_quality(4.9, 0), 0.0)

    def test_score_is_zero_without_reviews_and_weights_the_two_terms(self):
        self.assertEqual(mod.app_ranking_score(4.9, 0, 1.5, 0.0), 0.0)
        base = mod.app_quality(4.4, 500)
        self.assertAlmostEqual(mod.app_ranking_score(4.4, 500, 1.5, 0.0), base + 0.15 * 1.5)
        self.assertAlmostEqual(mod.app_ranking_score(4.4, 500, 0.0, 1.0), base - 0.35)

    def test_popularity_saturates(self):
        # 20,000 reviews give almost no edge over 200 at the same rating.
        gap = mod.app_quality(4.5, 20000) - mod.app_quality(4.5, 200)
        self.assertLess(gap, 0.1)

    def test_destination_bonus_against_neighbours_and_against_the_page(self):
        near = [(ORIGIN[0] + i * 0.0003, ORIGIN[1]) for i in range(5)]
        counts = [100, 100, 100, 100, 5000]
        bonus = mod.destination_bonuses(near, counts)
        self.assertEqual(bonus[4], 1.5)                        # far above four close neighbours: clamped
        self.assertAlmostEqual(bonus[0], 0.0)                  # level with its neighbours' median
        # Fewer than three neighbours inside 500 m: the whole page is the baseline.
        spread = [(ORIGIN[0], ORIGIN[1]), (ORIGIN[0] + 0.02, ORIGIN[1]), (ORIGIN[0] + 0.04, ORIGIN[1])]
        b = mod.destination_bonuses(spread, [50, 400, 3000])
        self.assertAlmostEqual(b[1], 0.0)                      # the median of the page is itself
        self.assertLess(b[0], 0)
        self.assertGreater(b[2], 0)

    def test_a_place_without_coordinates_has_no_neighbours_and_breaks_nothing(self):
        b = mod.destination_bonuses([None, (ORIGIN[0], ORIGIN[1])], [100, 100])
        self.assertEqual(len(b), 2)


class Wiring(unittest.TestCase):
    def test_rank_flag_parses_and_rejects_nonsense(self):
        opts, positional = mod.parse_args(["sushi", "--rank", "restaurant"])
        self.assertEqual((opts["rank"], positional), ("restaurant", ["sushi"]))
        self.assertEqual(mod.parse_args(["sushi"])[0]["rank"], "auto")
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            mod.parse_args(["sushi", "--rank", "fastest"])

    def test_the_full_field_mask_asks_for_the_type_id(self):
        self.assertIn("places.primaryType", mod.FIELD_MASK.split(","))


if __name__ == "__main__":
    unittest.main(verbosity=2)
