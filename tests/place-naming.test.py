"""place_naming — homes are known, a home is found by its address, and a
second stay is remembered. Synthetic homes and coordinates (a temporary
installation under JORI_HOME); no network, no model.

  - data/named-locations.json is the one list of homes and family homes,
    read by place_naming (location-segment, location-current-stop,
    stop-identify), findme and resolve-day. Absent: no homes.
  - One earlier answer names a second STAY at the same spot
    (place_naming.repeat_stay_name), without undoing the rule that one answer
    about a passing walk is not "recurring".

Run: python3 tests/place-naming.test.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

HOME_DIR = tempfile.mkdtemp(prefix="place-naming-")
os.makedirs(os.path.join(HOME_DIR, "data"))
FAMILY = {"name": "Family home", "lat": 12.3456, "lon": -65.4321,
          "address": "Example Lane 9, Testville", "kind": "family"}
FLAT = {"name": "Home (flat)", "lat": 12.3987, "lon": -65.4123}
COUSIN = {"name": "Cousin's house", "address": "Example St 5, Othertown", "tz": "Etc/GMT+4"}
with open(os.path.join(HOME_DIR, "data", "named-locations.json"), "w") as fh:
    json.dump({"entries": [FAMILY, FLAT, COUSIN]}, fh)
os.environ["JORI_HOME"] = HOME_DIR
os.environ["JORI_LOCAL_DIR"] = os.environ.get("JORI_LOCAL_DIR") or os.path.join(HOME_DIR, "local")

sys.path.insert(0, os.path.join(REPO, "lib"))
import place_naming  # noqa: E402

FAMILY_STOP = (12.34562, -65.43208)  # ~3 m from the family home


def tearDownModule():
    shutil.rmtree(HOME_DIR, ignore_errors=True)


class OneListOfHomes(unittest.TestCase):
    def test_the_installation_file_is_read(self):
        self.assertEqual([e["name"] for e in place_naming.NAMED_LOCATIONS], ["Family home", "Home (flat)"])

    def test_a_stop_at_a_home_is_named(self):
        loc, d = place_naming.match_named_location(*FAMILY_STOP)
        self.assertEqual(loc["name"], "Family home")
        self.assertLess(d, 30)
        self.assertIsNone(place_naming.match_named_location(12.3496, -65.4321))  # ~445 m

    def test_missing_or_unreadable_file_reads_as_empty(self):
        self.assertEqual(place_naming.load_named_locations("/nonexistent/named.json"), [])


class ByAddress(unittest.TestCase):
    """The model lives in bin/address-match; here the CLI is replaced, and what
    is under test is when it is called and what comes back."""

    def test_calls_the_cli_with_the_geocoder_label_and_returns_its_match(self):
        seen = []

        def run(cmd):
            seen.append(cmd)
            return json.dumps({"match": {"name": FAMILY["name"], "address": FAMILY["address"],
                                         "distance_m": 250, "cached": False}})
        hit = place_naming.match_named_location_by_address(12.3478, -65.4321, ["12 Example Alley"],
                                                           homes=[FAMILY], run=run)
        self.assertEqual(hit["name"], "Family home")
        self.assertEqual(seen[0][0], place_naming.ADDRESS_MATCH_BIN)
        self.assertIn("12 Example Alley", seen[0])

    def test_no_home_in_range_means_no_call(self):
        def run(cmd):
            raise AssertionError("must not shell out")
        self.assertIsNone(place_naming.match_named_location_by_address(
            34.5678, 10.1234, ["1 Example Road"], homes=[FAMILY], run=run))

    def test_a_broken_cli_names_nothing(self):
        for out in ("", "not json", json.dumps({"match": None})):
            self.assertIsNone(place_naming.match_named_location_by_address(
                12.3478, -65.4321, [], homes=[FAMILY], run=lambda cmd, o=out: o))

    def test_address_only_homes_load_but_never_match_by_distance(self):
        self.assertEqual([e["name"] for e in place_naming.load_address_homes()],
                         ["Family home", "Cousin's house"])
        bad = {"name": "No bound", "address": "Somewhere 1"}
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            json.dump({"entries": [FAMILY, COUSIN, bad]}, fh)
        try:
            self.assertEqual([e["name"] for e in place_naming.load_address_homes(path)],
                             ["Family home", "Cousin's house"])
            self.assertEqual([e["name"] for e in place_naming.load_named_locations(path)], ["Family home"])
        finally:
            os.remove(path)

    def test_a_booking_is_named_only_when_the_cli_says_it_is_that_booking(self):
        run = lambda cmd: json.dumps({"match": {"name": "Example St 4, Old Town"}})
        self.assertEqual(place_naming.match_booking_by_address(12.3, -65.4, "Example St 4, Old Town", run=run),
                         "Example St 4, Old Town")
        self.assertIsNone(place_naming.match_booking_by_address(12.3, -65.4, "Listing title", run=run))
        self.assertIsNone(place_naming.match_booking_by_address(12.3, -65.4, "", run=run))


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

    def test_two_agreeing_answers_are_recurring_and_a_split_is_a_question(self):
        self.history([visit("Grocer", "2026-10-03T11:00:00+00:00", 20), visit("Grocer", "2026-10-01T11:00:00+00:00", 20),
                      visit("Mailbox + Grocer errand", "2026-09-20T11:00:00+00:00", 30)])
        v = place_naming.name_from_history(*FAMILY_STOP, key="k", saved=[])
        self.assertEqual((v["name"], v["rung"], v["visits"]), ("Grocer", "recurring", 2))
        self.history([visit("Cafe A", "2026-10-03T11:00:00+00:00", 20), visit("Cafe B", "2026-10-01T11:00:00+00:00", 20)])
        self.assertIsNone(place_naming.name_from_history(*FAMILY_STOP, key="k", saved=[]))

    def test_a_passing_stop_is_not_a_stay(self):
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
        self.history([visit("Corner cafe", "2026-10-11T06:20:46+00:00", 74, 14),
                      visit("Bakery", "2026-10-07T05:39:19+00:00", 44, 40)])
        self.assertIsNone(self.rep())

    def test_a_typed_sentence_is_not_a_label(self):
        self.history([visit("Breakfast at the stall by the flea market, not the one across the road",
                            "2026-10-03T07:00:00+00:00", 40)])
        self.assertIsNone(self.rep())

    def test_visits_are_deduped_and_keep_the_longest_row(self):
        rows = [
            {"id": "a", "place_name": "Family", "latitude": 12.3456, "longitude": -65.4321,
             "arrived_at": "2026-10-03T11:07:04+00:00", "departed_at": "2026-10-03T11:30:00+00:00"},
            {"id": "b", "place_name": "Family", "latitude": 12.3456, "longitude": -65.4321,
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


class Favorite(unittest.TestCase):
    def test_the_only_saved_place_in_radius_names_it_and_two_tie(self):
        place_naming.prior_confirmations, orig = (lambda *a, **k: []), place_naming.prior_confirmations
        try:
            one = [{"name": "Corner cafe", "lat": 12.34562, "lng": -65.43210}]
            v = place_naming.name_from_history(*FAMILY_STOP, key="k", saved=one)
            self.assertEqual((v["name"], v["rung"]), ("Corner cafe", "favorite"))
            two = one + [{"name": "Bakery", "lat": 12.34562, "lng": -65.43210}]
            self.assertIsNone(place_naming.name_from_history(*FAMILY_STOP, key="k", saved=two))
        finally:
            place_naming.prior_confirmations = orig

    def test_no_key_names_nothing(self):
        os.environ.pop("SUPABASE_SERVICE_ROLE_KEY", None)
        orig = place_naming.load_key
        place_naming.load_key = lambda: None
        try:
            self.assertIsNone(place_naming.name_from_history(*FAMILY_STOP))
        finally:
            place_naming.load_key = orig


if __name__ == "__main__":
    unittest.main()
