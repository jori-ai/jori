"""A stop the user named INSIDE a longer row is not a double booking of it.

A rented flat's 05:39-14:20 visit row carried the user's card answer naming the
flat, but confirming a café (10:18-10:57, inside it) renamed the flat row too,
and then `findme resolve` refused to give the flat row the user's answer back:
the café rows inside it counted as clashes. Two rows for one visit share its
minutes; a café inside a morning at the flat does not. A clash wholly inside
the row (by more than a minute at each end) under another name is an inner
stop. Same-window twins, clashes that only overlap an edge, and a confirmation
without a name still refuse. Synthetic places and coordinates.

Run: python3 tests/findme-inner-stop.test.py
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))

if "pyicloud" not in sys.modules:
    import types
    _fake = types.ModuleType("pyicloud")
    _fake.PyiCloudService = object
    sys.modules["pyicloud"] = _fake


import math

BASE_LAT, BASE_LON = 12.3456, -65.4321


def P(north_m, east_m):
    """(lat, lon) north_m / east_m metres from the fake base."""
    return (BASE_LAT + north_m / 111320.0,
            BASE_LON + east_m / (111320.0 * math.cos(math.radians(BASE_LAT))))


def load():
    path = os.path.join(REPO, "bin", "findme")
    mod = type(sys)("findme_inner")
    mod.__dict__["__name__"] = "findme_inner"
    mod.__dict__["__file__"] = path
    exec(compile(open(path).read(), "findme", "exec"), mod.__dict__)
    return mod


FLAT_NAME = "The rental"
FLAT = {"id": "7af07d6a", "segment_type": "visit", "place_name": "Example Cafe",
        **dict(zip(("latitude", "longitude"), P(-10.9, 33.5))),
        "arrived_at": "2026-10-16T02:39:30+00:00", "departed_at": "2026-10-16T11:20:09+00:00"}
CAFE = {"id": "e9b495dd", "place_name": "Example Cafe", **dict(zip(("latitude", "longitude"), P(-23.1, 73.1))),
        "arrived_at": "2026-10-16T07:18:57+00:00", "departed_at": "2026-10-16T07:57:21+00:00"}
PHOTOS = dict(CAFE, id="630e5912", arrived_at="2026-10-16T06:53:32+00:00", departed_at="2026-10-16T07:45:24+00:00")
WALK_OUT = {"id": "a527a01b", "place_name": FLAT_NAME, **dict(zip(("latitude", "longitude"), P(13.6, 155.2))),
            "arrived_at": "2026-10-16T11:17:05+00:00", "departed_at": "2026-10-16T11:24:45+00:00"}


class InnerStops(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fm = load()

    def blocker(self, clashes, name=FLAT_NAME):
        self.fm._fetch_location_row = lambda vid: dict(FLAT)
        self.fm._overlapping_confirmed_visits = lambda row: [dict(c) for c in clashes]
        return self.fm._confirm_blocker("7af07d6a", name=name)

    def test_the_answer_goes_back_on_the_flat_row_around_the_cafe(self):
        self.assertIsNone(self.blocker([CAFE, PHOTOS]))

    def test_a_clash_over_the_rows_edge_still_refuses(self):
        self.assertIn("overlaps already-confirmed visit", self.blocker([CAFE, PHOTOS, WALK_OUT]))

    def test_the_same_name_inside_is_not_another_place(self):
        inner = dict(CAFE, place_name=FLAT_NAME)
        self.assertIn("overlaps already-confirmed visit", self.blocker([inner]))

    def test_without_the_name_nothing_changes(self):
        self.assertIn("overlaps already-confirmed visit", self.blocker([CAFE], name=None))

    def test_a_twin_with_the_same_arrival_still_refuses(self):
        twin = dict(FLAT, id="c8bc97b1", place_name="Somewhere", departed_at="2026-10-16T09:00:00+00:00")
        self.assertIn("overlaps already-confirmed visit", self.blocker([twin]))

    def test_a_near_twin_covering_most_of_the_row_still_refuses(self):
        twin = dict(FLAT, id="near", place_name="Somewhere", **dict(zip(("latitude", "longitude"), P(15.8, 34.4))),
                    arrived_at="2026-10-16T02:41:00+00:00", departed_at="2026-10-16T11:18:00+00:00")
        self.assertIn("overlaps already-confirmed visit", self.blocker([twin]))

    def test_the_late_departure_trim_still_wins_when_the_later_stop_sits_inside(self):
        """Confirming the earlier flat row whose departure ran into a breakfast café
        (160 m) trims it to the café's arrival; the café inside it must not hide that."""
        flat = {"id": "47d351f6", "segment_type": "visit", "place_name": None,
                **dict(zip(("latitude", "longitude"), P(0, 0))),
                "arrived_at": "2026-10-02T20:18:27+00:00", "departed_at": "2026-10-03T08:41:42+00:00"}
        cafe = {"id": "6aec5c60", "place_name": "Example Breakfast", **dict(zip(("latitude", "longitude"), P(160.5, -3.3))),
                "arrived_at": "2026-10-03T07:21:45+00:00", "departed_at": "2026-10-03T07:40:00+00:00"}
        self.fm._fetch_location_row = lambda vid: dict(flat)
        self.fm._overlapping_confirmed_visits = lambda row: [dict(cafe)]
        self.assertIsNone(self.fm._confirm_blocker("47d351f6", name=FLAT_NAME))
        t = self.fm._lagging_departure_trim(flat, [cafe])
        self.assertEqual(t["new_departed"], cafe["arrived_at"], "the trim is still the path taken")

    def test_kill_switch(self):
        os.environ["FINDME_INNER_STOPS"] = "0"
        try:
            self.assertIn("overlaps already-confirmed visit", self.blocker([CAFE]))
        finally:
            del os.environ["FINDME_INNER_STOPS"]


# 2026-10-28: one stay arrives as two or three twin rows, and a save names all of
# them. A wrong name on every twin could not be corrected on any of them: each
# refused on the others, which still carried it. Twins carrying the row's own
# confirmed name are the same answer; correcting the row corrects them too.
BASE = {"id": "tw1", "segment_type": "visit", "place_type": "user-confirmed", "place_name": "The Cafe",
        "latitude": 10.0, "longitude": 20.0,
        "arrived_at": "2026-01-01T21:20:46+00:00", "departed_at": "2026-01-02T06:53:08+00:00"}
TW2 = dict(BASE, id="tw2", departed_at="2026-01-02T06:58:07+00:00")
TW3 = dict(BASE, id="tw3", departed_at="2026-01-02T06:58:07+00:00")


class ConfirmationTwins(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fm = load()

    def blocker(self, row, clashes, name="The Base"):
        self.fm._fetch_location_row = lambda vid: dict(row)
        self.fm._overlapping_confirmed_visits = lambda r: [dict(c) for c in clashes]
        return self.fm._confirm_blocker(row["id"], name=name)

    def test_twins_carrying_the_same_wrong_answer_do_not_block_its_correction(self):
        self.assertIsNone(self.blocker(BASE, [TW2, TW3]))

    def test_a_twin_under_another_name_still_refuses(self):
        self.assertIn("overlaps already-confirmed visit",
                      self.blocker(BASE, [TW2, dict(TW3, place_name="Elsewhere")]))

    def test_a_row_that_carries_no_confirmation_has_no_twins_to_correct(self):
        self.assertIn("overlaps already-confirmed visit",
                      self.blocker(dict(BASE, place_type="named"), [TW2]))

    def test_a_shorter_row_inside_is_not_a_twin(self):
        part = dict(TW2, arrived_at="2026-01-02T03:00:00+00:00")
        self.assertIn("overlaps already-confirmed visit", self.blocker(BASE, [part]))

    def test_resolve_carries_the_correction_to_the_twins(self):
        fm = self.fm
        rows = {r["id"]: dict(r) for r in (BASE, TW2, TW3)}
        fm._fetch_location_row = lambda vid: dict(rows[vid])
        fm._overlapping_confirmed_visits = lambda r: [dict(x) for k, x in rows.items() if k != r["id"]]
        written = []

        def upd(vid, fields):
            written.append((vid, fields.get("place_name")))
            rows[vid].update(fields)
            return True
        fm._update_location_row = upd
        fm._load_pending_enrich = lambda: {"pending": []}
        fm._save_pending_enrich = lambda state: None
        fm._promote_answer = lambda *a, **k: None
        fm.cmd_resolve(["tw1", "The Base"], as_json=True)
        self.assertEqual(sorted(written), [("tw1", "The Base"), ("tw2", "The Base"), ("tw3", "The Base")])


if __name__ == "__main__":
    unittest.main()
