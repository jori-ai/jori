"""named-locations — family homes are known, and a second stay is remembered.

Requirement: a 71-minute stop at a family home that came back as a geocoder
street ("12 Oak Alley") must be identified automatically — the wiki had the
address and the user had named the house on an earlier visit, but no resolver
read either.

  - data/named-locations.json is the one list of homes and family homes,
    read by place_naming (location-segment, location-current-stop,
    stop-identify), findme and resolve-day.
  - One earlier answer names a second STAY at the same spot
    (place_naming.repeat_stay_name), without undoing the 2026-10-05 rule that
    one answer about a passing walk is not "recurring".

Run: python3 tests/named-locations.test.py
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))
import place_naming  # noqa: E402

# Synthetic homes: offsets in metres from an obviously fake origin, so the
# geometry is real and the places are not.
ORIGIN = (12.3456, -65.4321)


def at(east_m, north_m):
    import math
    lat = ORIGIN[0] + north_m / 111320.0
    lon = ORIGIN[1] + east_m / (111320.0 * math.cos(math.radians(ORIGIN[0])))
    return (lat, lon)


FAMILY_AT = at(0, 0)
FAMILY = {"name": "Family home, Example Town", "lat": FAMILY_AT[0], "lon": FAMILY_AT[1],
          "address": "Rehov HaAlon 9, Example Town 10000, Israel", "kind": "family"}
HOME_AT = at(-5000, 3000)
HOME = {"name": "Home", "lat": HOME_AT[0], "lon": HOME_AT[1], "address": "1 Example Ave, Big City"}
RELATIVES = {"name": "Relatives' house", "address": "Example St 5, Other Town", "tz": "Asia/Jerusalem"}
FAMILY_STOP = at(0.4, 2.6)  # a 71-minute stop at the family home
OFF_DOOR = at(0, 250)       # outside the 150 m spot match, inside the address radius


def write_fixture(entries):
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w") as fh:
        json.dump({"entries": entries}, fh)
    return path


FILE = write_fixture([HOME, FAMILY, RELATIVES])


class OneListOfHomes(unittest.TestCase):
    def setUp(self):
        self._orig = place_naming.NAMED_LOCATIONS
        place_naming.NAMED_LOCATIONS = place_naming.load_named_locations(FILE)

    def tearDown(self):
        place_naming.NAMED_LOCATIONS = self._orig

    def test_file_parses_and_every_entry_is_a_place(self):
        with open(FILE) as fh:
            entries = json.load(fh)["entries"]
        self.assertGreaterEqual(len(entries), 3)
        for e in entries:
            self.assertTrue(e["name"])
            if "lat" not in e:
                # An address-only home: matched by address alone, inside its tz.
                self.assertTrue(e.get("address") and e.get("tz"), e["name"])
                continue
            self.assertIsInstance(e["lat"], float)
            self.assertIsInstance(e["lon"], float)
        self.assertEqual([e["name"] for e in place_naming.NAMED_LOCATIONS],
                         [e["name"] for e in entries if "lat" in e])

    def test_family_home_is_named_from_the_wiki_address(self):
        hit = place_naming.match_named_location(*FAMILY_STOP)
        self.assertIsNotNone(hit)
        loc, d = hit
        self.assertEqual(loc["name"], "Family home, Example Town")
        self.assertEqual(loc["address"], FAMILY["address"])
        self.assertLess(d, 30)

    def test_the_old_homes_still_match(self):
        self.assertEqual(place_naming.match_named_location(*HOME_AT)[0]["name"], "Home")
        self.assertIsNone(place_naming.match_named_location(*at(-130, 428)))  # an office 447 m away

    def test_findme_and_whereami_read_the_file_not_a_copy(self):
        with open(os.path.join(REPO, "bin", "findme")) as fh:
            src = fh.read()
        with open(place_naming.__file__) as fh:
            lib = fh.read()
        with open(os.path.join(REPO, "bin", "whereami")) as fh:
            wai = fh.read()
        for text in (src, wai):
            self.assertIn("named-locations.json", text)
            self.assertNotIn('NAMED_LOCATIONS = [', text)
        self.assertNotIn('NAMED_LOCATIONS = [', lib)

    def test_unreadable_file_reads_as_empty(self):
        self.assertEqual(place_naming.load_named_locations("/nonexistent/named.json"), [])


class ByAddress(unittest.TestCase):
    """A home is also recognised by its street address (a geocoder's English
    street name and the wiki's transliterated Hebrew one are the same street,
    and nearby house numbers on the same street count as the same home). The model lives in bin/address-match;
    here the CLI is replaced, and what is under test is when it is called and
    what comes back."""
    PARENTS = FAMILY

    def test_calls_the_cli_with_the_geocoder_label_and_returns_its_match(self):
        seen = []

        def run(cmd):
            seen.append(cmd)
            return json.dumps({"match": {"name": self.PARENTS["name"], "address": self.PARENTS["address"],
                                         "distance_m": 250, "cached": False}})
        hit = place_naming.match_named_location_by_address(*OFF_DOOR, ["12 Oak Alley"],
                                                           homes=[self.PARENTS], run=run)
        self.assertEqual(hit["name"], "Family home, Example Town")
        self.assertEqual(seen[0][0], place_naming.ADDRESS_MATCH_BIN)
        self.assertIn("12 Oak Alley", seen[0])

    def test_no_home_in_range_means_no_call(self):
        def run(cmd):
            raise AssertionError("must not shell out")
        self.assertIsNone(place_naming.match_named_location_by_address(
            *at(900_000, 4_000_000), ["1 Example Road"], homes=[self.PARENTS], run=run))

    def test_a_broken_cli_names_nothing(self):
        for out in ("", "not json", json.dumps({"match": None})):
            self.assertIsNone(place_naming.match_named_location_by_address(
                *OFF_DOOR, [], homes=[self.PARENTS], run=lambda cmd, o=out: o))

    def test_address_only_homes_load_but_never_match_by_distance(self):
        aunt = RELATIVES
        bad = {"name": "No bound", "address": "Somewhere 1"}
        import tempfile
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            json.dump({"entries": [self.PARENTS, aunt, bad]}, fh)
        try:
            self.assertEqual([e["name"] for e in place_naming.load_address_homes(path)],
                             ["Family home, Example Town", "Relatives' house"])
            self.assertEqual([e["name"] for e in place_naming.load_named_locations(path)],
                             ["Family home, Example Town"])
        finally:
            os.remove(path)

    def test_stop_identify_and_findme_try_the_address_after_the_spot(self):
        for rel in (("bin", "stop-identify"), ("bin", "findme")):
            with open(os.path.join(REPO, *rel)) as fh:
                self.assertIn("match_named_location_by_address", fh.read())


def visit(name, arrived, minutes, distance_m=10.0):
    return {"name": name, "arrived_at": arrived, "minutes": minutes, "distance_m": distance_m}


class RepeatStay(unittest.TestCase):
    def setUp(self):
        self._orig = place_naming.prior_confirmed_visits
        self._orig_names = place_naming.prior_confirmations

    def tearDown(self):
        place_naming.prior_confirmed_visits = self._orig
        place_naming.prior_confirmations = self._orig_names

    def history(self, visits):
        place_naming.prior_confirmed_visits = lambda *a, **k: list(visits)
        place_naming.prior_confirmations = lambda *a, **k: [
            v["name"] for v in visits if v["distance_m"] <= place_naming.RECUR_RADIUS_M]

    def rep(self, stop_min=71, arrived="2026-10-14T14:22:00+00:00"):
        return place_naming.repeat_stay_name(*FAMILY_STOP, "k", stop_min, stop_arrived=arrived)

    def test_one_answer_about_a_stay_names_a_second_stay(self):
        self.history([visit("Family", "2026-10-03T11:07:04+00:00", 203)])
        self.assertEqual(self.rep()["name"], "Family")
        v = place_naming.name_from_history(*FAMILY_STOP, key="k", saved=[], stop_min=71,
                                           stop_arrived="2026-10-14T14:22:00+00:00")
        self.assertEqual((v["name"], v["rung"], v["confidence"]), ("Family", "recurring", 0.9))

    def test_without_the_stop_one_answer_is_still_not_recurring(self):
        self.history([visit("Family", "2026-10-03T11:07:04+00:00", 203)])
        self.assertIsNone(place_naming.name_from_history(*FAMILY_STOP, key="k", saved=[]))

    def test_a_passing_stop_is_not_a_stay(self):
        # A 13-minute dog walk past a corner the user had answered about.
        self.history([visit("Just browsing the market", "2026-10-02T05:23:45+00:00", 186)])
        self.assertIsNone(self.rep(stop_min=13))

    def test_the_earlier_visit_must_have_been_a_stay(self):
        self.history([visit("Kiosk", "2026-10-03T11:07:04+00:00", 6)])
        self.assertIsNone(self.rep())
        self.history([visit("Kiosk", "2026-10-03T11:07:04+00:00", None)])
        self.assertIsNone(self.rep())

    def test_a_twin_row_of_this_stay_is_not_a_second_visit(self):
        self.history([visit("Family", "2026-10-14T14:22:31+00:00", 71)])
        self.assertIsNone(self.rep())

    def test_a_different_answer_nearby_makes_it_a_question(self):
        # Two cafes the user named, 40 m apart.
        self.history([visit("Boutique cafe", "2026-10-11T06:20:46+00:00", 74, 14),
                      visit("Example Bakery", "2026-10-07T05:39:19+00:00", 44, 40)])
        self.assertIsNone(self.rep())

    def test_a_typed_sentence_is_not_a_label(self):
        self.history([visit("Breakfast at the cafe (or the other one) in the flea market, not the stall",
                            "2026-10-03T07:00:00+00:00", 40)])
        self.assertIsNone(self.rep())

    def test_visits_are_deduped_and_keep_the_longest_row(self):
        rows = [
            {"id": "a", "place_name": "Family", "latitude": FAMILY_AT[0], "longitude": FAMILY_AT[1],
             "arrived_at": "2026-10-03T11:07:04+00:00", "departed_at": "2026-10-03T11:30:00+00:00"},
            {"id": "b", "place_name": "Family", "latitude": FAMILY_AT[0], "longitude": FAMILY_AT[1],
             "arrived_at": "2026-10-03T11:07:04+00:00", "departed_at": "2026-10-03T14:29:00+00:00"},
        ]
        orig_get = place_naming._get
        place_naming._get = lambda *a, **k: rows
        try:
            got = self._orig(*FAMILY_STOP, "k")
        finally:
            place_naming._get = orig_get
        self.assertEqual(len(got), 1)
        self.assertAlmostEqual(got[0]["minutes"], 201.9, places=0)
        self.assertLess(got[0]["distance_m"], 5)


if __name__ == "__main__":
    unittest.main()
