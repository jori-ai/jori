#!/usr/bin/env python3
"""day-path-stay-split.test.py — a visit row is cut around a rest that is somewhere else.

The case (synthetic places). The phone filed one visit at the flat from 19:48 to past
midnight; the fixes show the user at the flat, then 67 minutes at a cafe 190 m away
(inside the 150-400 m band that reconcile_visit counted as neither near nor far),
then back. The spine drew one dwell, and resolve-day dropped the cafe as
"elsewhere: the flat". A stay (STAY_MIN minutes inside STAY_R_M, with tight fixes)
STAY_SPLIT_M or more from the row is now a departure.

Run: python3 tests/day-path-stay-split.test.py
"""
import os, sys, unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "fixtures"))
from fake_geo import at as G, load_rows  # noqa: E402,F401
mod = type(sys)("daypath")
exec(compile(open(os.path.join(REPO, "bin", "day-path")).read(), "day-path", "exec"), mod.__dict__)

T0 = datetime(2026, 10, 14, 16, 48, tzinfo=timezone.utc)      # 19:48 Israel
FLAT = G(0.0, 0.0)
CAFE = G(188.37, 28.07)                                     # ~190 m east


def fix(minute, pos, acc=8.0):
    return dict(t=T0 + timedelta(minutes=minute), lat=pos[0], lon=pos[1], acc=acc)


def evening(cafe_pos=CAFE, cafe_acc=8.0, cafe_fixes=6):
    fixes = [fix(0, FLAT), fix(5, FLAT), fix(12, FLAT)]
    fixes += [fix(25 + 10 * i, cafe_pos, cafe_acc) for i in range(cafe_fixes)]      # 25..75 min
    fixes += [fix(90, FLAT), fix(120, FLAT), fix(150, FLAT), fix(200, FLAT)]
    return fixes


def row(end_min=210, ptype="named"):
    return dict(start=T0, end=T0 + timedelta(minutes=end_min), lat=FLAT[0], lon=FLAT[1], ptype=ptype)


def reconcile(fixes, **kw):
    stays = mod.stay_points(fixes)
    spans, why = mod.reconcile_visit(row(**kw), fixes, stays)
    return spans, why, stays


class StaySplit(unittest.TestCase):
    def test_precondition_the_cafe_is_in_the_neutral_band(self):
        d = mod.haversine(FLAT, CAFE)
        self.assertGreater(d, mod.CORROB_M)
        self.assertLess(d, mod.CONTRA_M)
        self.assertGreater(d, mod.STAY_SPLIT_M)

    def test_without_stays_the_row_is_one_span(self):
        fixes = evening()
        spans, _ = mod.reconcile_visit(row(), fixes)
        self.assertEqual(len(spans), 1)

    def test_a_rest_elsewhere_splits_the_row(self):
        fixes = evening()
        spans, why, stays = reconcile(fixes)
        self.assertTrue(stays, "the cafe is a stay point")
        self.assertEqual(len(spans), 2, spans)
        (s1, e1, _w1, _c1), (s2, e2, _w2, _c2) = spans
        self.assertEqual(s1, T0)
        self.assertLessEqual(e1, T0 + timedelta(minutes=30), "the flat ends when the cafe rest begins")
        self.assertGreaterEqual(s2, T0 + timedelta(minutes=70), "and resumes after the last cafe fix")
        self.assertEqual(e2, T0 + timedelta(minutes=210))

    def test_a_rest_inside_the_building_footprint_does_not_split(self):
        near = G(75.27, 0.0)               # ~75 m
        self.assertLess(mod.haversine(FLAT, near), mod.STAY_SPLIT_M)
        spans, _, _ = reconcile(evening(cafe_pos=near))
        self.assertEqual(len(spans), 1)

    def test_loose_fixes_cannot_split_on_their_own_noise(self):
        spans, _, stays = reconcile(evening(cafe_acc=60.0))
        self.assertEqual(len(spans), 1, "a drifting indoor phone (acc 60 m) is not a departure")

    def test_two_precise_fixes_are_not_enough(self):
        fixes = [fix(0, FLAT), fix(5, FLAT),
                 fix(25, CAFE), fix(40, CAFE, acc=60.0), fix(55, CAFE, acc=60.0), fix(70, CAFE),
                 fix(90, FLAT), fix(150, FLAT), fix(200, FLAT)]
        spans, _, _ = reconcile(fixes)
        self.assertEqual(len(spans), 1)

    def test_a_row_he_answered_for_is_never_cut(self):
        """2026-10-11 Hatikva Market, 2026-10-12 National Library: user-confirmed, stay 187 m away inside the venue."""
        spans, _, stays = reconcile(evening(), ptype="user-confirmed")
        self.assertTrue(stays)
        self.assertEqual(len(spans), 1)

    def test_kill_switch(self):
        os.environ["JORI_STAY_SPLIT"] = "0"
        try:
            spans, _, _ = reconcile(evening())
            self.assertEqual(len(spans), 1)
        finally:
            del os.environ["JORI_STAY_SPLIT"]


if __name__ == "__main__":
    unittest.main()
