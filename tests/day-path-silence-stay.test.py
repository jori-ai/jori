#!/usr/bin/env python3
"""day-path-silence-stay.test.py — one fix and a quiet phone is where the user stopped.

The case (synthetic places): the flat's row ran 20:13 to morning; one fix 5 m from
the restaurant at 20:38 (the dinner the user named), 66 silent minutes, then a walking fix 166 m
away. The lone fix was a glitch and the dinner vanished; now it is a stay, cut out.
Another evening, same flat: no fix saw the walk to the restaurant, so the stay counts
only because the user confirmed it during it (AnchoredSilenceStay).
Run: python3 tests/day-path-silence-stay.test.py
"""
import os, sys, unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "fixtures"))
from fake_geo import at as G, load_rows  # noqa: E402,F401
mod = type(sys)("daypath")
exec(compile(open(os.path.join(REPO, "bin", "day-path")).read(), "day-path", "exec"), mod.__dict__)

T0 = datetime(2026, 10, 16, 17, 13, tzinfo=timezone.utc)      # 20:13 Israel
FLAT = G(0.0, 0.0)
OUT = G(192.14, 12.5)                                     # walking, ~190 m east
DINNER = G(157.26, 194.86)                                  # ~250 m, 5 m from the restaurant
BACK = G(108.26, 40.3)                                    # walking home, ~115 m


def fix(minute, pos, acc=15.0):
    return dict(t=T0 + timedelta(minutes=minute), lat=pos[0], lon=pos[1], acc=acc)


def evening(dinner_acc=20.0, silence_min=66, back=BACK, walked_there=True):
    fixes = [fix(5, FLAT), fix(13, OUT if walked_there else FLAT), fix(25, DINNER, dinner_acc)]
    fixes += [fix(25 + silence_min, back), fix(123, FLAT), fix(157, FLAT), fix(202, FLAT)]
    return fixes


def row(end_min=700, ptype="named"):
    return dict(start=T0, end=T0 + timedelta(minutes=end_min), lat=FLAT[0], lon=FLAT[1], ptype=ptype)


def reconcile(fixes, **kw):
    stays = mod.stay_points(fixes)
    stays += mod.silence_stays(fixes, stays)
    spans, why = mod.reconcile_visit(row(**kw), fixes, stays)
    return spans, stays


class SilenceStay(unittest.TestCase):
    def test_precondition_the_dinner_is_in_the_neutral_band(self):
        d = mod.haversine(FLAT, DINNER)
        self.assertGreater(d, mod.STAY_SPLIT_M)
        self.assertLess(d, mod.CONTRA_M, "a lone fix here counted as neither near nor far")

    def test_the_dinner_is_a_stay_and_cuts_the_row(self):
        spans, stays = reconcile(evening())
        # the walk home ends in a quiet phone too, but 115 m out it is the flat's own
        # doorstep (inside STAY_SPLIT_M), so only the dinner cuts the row
        cut = [s for s in stays if s.get("split_row")]
        self.assertEqual(len(cut), 1, stays)
        st = cut[0]
        self.assertEqual(st["start"], T0 + timedelta(minutes=25))
        # it lasts until he walked from the restaurant to the 21:44 fix (~2 min)
        self.assertGreater(st["end"], T0 + timedelta(minutes=88))
        self.assertLess(st["end"], T0 + timedelta(minutes=91))
        self.assertEqual(len(spans), 2, spans)
        (s1, e1, _w1, _c1), (s2, e2, _w2, _c2) = spans
        self.assertEqual(s1, T0)
        self.assertEqual(e1, T0 + timedelta(minutes=5), "the flat ends at the last fix that had him there")
        self.assertEqual(s2, T0 + timedelta(minutes=91), "and resumes at the first fix that has him back")
        self.assertEqual(e2, T0 + timedelta(minutes=700))

    def dinner_stays(self, stays):
        return [s for s in stays if s.get("silence") and mod.haversine((s["lat"], s["lon"]), DINNER) < 10]

    def test_a_short_silence_is_still_a_glitch(self):
        spans, stays = reconcile(evening(silence_min=20))
        self.assertFalse(self.dinner_stays(stays))
        self.assertEqual(len(spans), 1)

    def test_a_loose_fix_is_not_a_place(self):
        spans, stays = reconcile(evening(dinner_acc=60.0))
        self.assertFalse(self.dinner_stays(stays))
        self.assertEqual(len(spans), 1)

    def test_a_silence_that_ends_far_away_is_travel(self):
        far = G(1482.19, 1028.93)                               # ~1.8 km
        spans, stays = reconcile(evening(back=far))
        self.assertFalse(self.dinner_stays(stays))

    def test_a_phone_that_jumped_from_the_flat_does_not_cut_it(self):
        """The fix before the lone one is at the flat: he did not walk there."""
        spans, stays = reconcile(evening(walked_there=False))
        self.assertEqual(len(spans), 1, spans)
        self.assertFalse(any(s.get("split_row") for s in stays))

    def test_a_quiet_visit_never_seen_at_its_place_keeps_its_row(self):
        """An address row ('7-11 Example Street'): no fix ever had the user at the row's point, so a
        lone fix 250 m out is a mid fix, not a departure; the row must not be dropped."""
        fixes = [fix(-40, OUT), fix(25, DINNER), fix(91, BACK)]
        spans, stays = reconcile(fixes, end_min=80)
        self.assertEqual(spans, [(T0, T0 + timedelta(minutes=80), 0, None)])
        self.assertFalse(any(s.get("split_row") for s in stays))

    def test_a_row_he_answered_for_is_never_cut(self):
        spans, _ = reconcile(evening(), ptype="user-confirmed")
        self.assertEqual(len(spans), 1)

    def test_kill_switch(self):
        os.environ["JORI_SILENCE_STAY"] = "0"
        try:
            spans, stays = reconcile(evening())
            self.assertEqual(len(spans), 1)
            self.assertFalse([s for s in stays if s.get("silence")])
        finally:
            del os.environ["JORI_SILENCE_STAY"]


def fix_row(minute, pos, acc=15.0, activity="walking"):
    t = (T0 + timedelta(minutes=minute)).isoformat()
    return dict(id=f"f{minute}", segment_type="transit", latitude=pos[0], longitude=pos[1],
                accuracy_m=acc, arrived_at=t, departed_at=None, activity=activity,
                place_name=None, place_type="transit", city=None)


class SilenceStayOnTheSpine(unittest.TestCase):
    def build(self, with_row=True):
        rows = [fix_row(int((f["t"] - T0).total_seconds() // 60), (f["lat"], f["lon"]), f["acc"])
                for f in evening()]
        if with_row:
            rows.append(dict(id="v-flat", segment_type="visit", latitude=FLAT[0], longitude=FLAT[1],
                             accuracy_m=30.0, arrived_at=T0.isoformat(),
                             departed_at=(T0 + timedelta(minutes=500)).isoformat(), activity="stationary",
                             place_name="The Harbor Flat", place_type="named", city=None))
        return mod.build("2026-10-16", "Asia/Jerusalem", rows, do_match=False)

    def test_the_spine_reads_flat_walk_dinner_walk_flat(self):
        day = self.build()
        dwells = [n for n in day["spine"] if n["type"] == "dwell"]
        names = [(n["place"]["name"], n["place"]["tier"]) for n in dwells]
        self.assertEqual([t for _n, t in names], ["corroborated", "stay-point", "corroborated"], names)
        dinner = dwells[1]
        self.assertEqual(dinner["start"], "20:38")
        self.assertEqual(dinner["witnessed_min"], 0, "one fix saw him arrive, nothing saw him sit")
        self.assertEqual(dinner["corroborated_by"], "silence")
        kinds = [n["type"] for n in day["spine"]]
        for a, b in zip(kinds, kinds[1:]):
            self.assertNotEqual(a, b, f"two {a}s in a row: {kinds}")

    def test_without_a_row_to_cut_no_dwell_is_invented(self):
        day = self.build(with_row=False)
        self.assertFalse([n for n in day["spine"] if n["type"] == "dwell"
                          and n.get("corroborated_by") == "silence"])


# Another evening: the flat's row ran 19:12 to the next morning (the phone reported
# leaving 14 h late, over the sweeper's 20:06 close). Its last fix at the flat was
# 19:15; the phone was quiet until one precise fix at the restaurant at 20:06, quiet again
# until a fix on the walk home at 22:09, then back at the flat from 22:16. The restaurant
# is the dinner the user confirmed (its row 21:56-22:09). No fix saw the walk there.
T1 = datetime(2026, 10, 20, 16, 12, 36, tzinfo=timezone.utc)     # 19:12:36 Israel
FLAT2 = G(13.54, 13.34)
DINNER2 = G(187.37, -11.96)                                   # ~176 m east
HOMEWARD = G(113.91, 32.51)                                # 86 m from the restaurant, 102 m from the flat
AT_FLAT = G(2.7, 9.16)


def fix2(sec, pos, acc=15.0):
    return dict(t=T1 + timedelta(seconds=sec), lat=pos[0], lon=pos[1], acc=acc)


def dinner_evening():
    return [fix2(18, AT_FLAT), fix2(180, AT_FLAT), fix2(3217, DINNER2, 12.0), fix2(10622, HOMEWARD),
            fix2(11036, AT_FLAT), fix2(11500, AT_FLAT), fix2(12000, AT_FLAT), fix2(12506, AT_FLAT)]


def dinner_row(at=DINNER2):
    return dict(id="v-dinner", segment_type="visit", latitude=at[0], longitude=at[1],
                arrived_at=(T1 + timedelta(seconds=9851)).isoformat(),
                departed_at=(T1 + timedelta(seconds=10622)).isoformat(),
                place_name="Restaurant Example", place_type="user-confirmed")


def reconcile_dinner(rows=None):
    fixes = dinner_evening()
    stays = mod.stay_points(fixes)
    stays += mod.silence_stays(fixes, stays)
    mod.anchor_silence_stays(stays, rows or [])
    flat = dict(start=T1, end=T1 + timedelta(minutes=905), lat=FLAT2[0], lon=FLAT2[1], ptype="named")
    spans, _why = mod.reconcile_visit(flat, fixes, stays)
    return spans, stays


class AnchoredSilenceStay(unittest.TestCase):
    def test_precondition_the_phone_was_at_the_flat_before_the_lone_fix(self):
        self.assertLess(mod.haversine(FLAT2, AT_FLAT), mod.CORROB_M)
        self.assertGreater(mod.haversine(FLAT2, DINNER2), mod.STAY_SPLIT_M)
        self.assertLess(mod.haversine(FLAT2, DINNER2), mod.CONTRA_M)

    def test_without_his_answer_it_reads_as_a_phone_that_jumped(self):
        spans, _ = reconcile_dinner()
        self.assertEqual(len(spans), 1, spans)

    def test_his_confirmed_dinner_cuts_the_flat_around_it(self):
        spans, stays = reconcile_dinner([dinner_row()])
        self.assertEqual(len(spans), 2, spans)
        (s1, e1, _w1, _c1), (s2, e2, _w2, _c2) = spans
        self.assertEqual(s1, T1)
        # quiet at the flat until the ~2.5 min walk to the 20:06 fix, not cut at 19:15
        self.assertGreater(e1, T1 + timedelta(seconds=3217 - 180))
        self.assertLess(e1, T1 + timedelta(seconds=3217 - 120))
        # back at the 22:16 fix: the 22:09 one stood nearer the restaurant, on the walk home
        self.assertEqual(s2, T1 + timedelta(seconds=11036))
        self.assertEqual(e2, T1 + timedelta(minutes=905))
        self.assertTrue(any(st.get("anchored_by") == "v-dinner" and st.get("split_row") for st in stays))

    def test_a_confirmed_place_away_from_the_fix_does_not_anchor_it(self):
        spans, stays = reconcile_dinner([dinner_row(at=G(539.88, 361.66))])   # ~450 m off
        self.assertEqual(len(spans), 1, spans)
        self.assertFalse(any(st.get("anchored_by") for st in stays))

    def test_a_named_row_there_is_not_his_answer(self):
        row = dict(dinner_row(), place_type="named")
        spans, _ = reconcile_dinner([row])
        self.assertEqual(len(spans), 1, spans)

    def test_kill_switch(self):
        os.environ["JORI_SILENCE_ANCHOR"] = "0"
        try:
            spans, _ = reconcile_dinner([dinner_row()])
            self.assertEqual(len(spans), 1, spans)
        finally:
            del os.environ["JORI_SILENCE_ANCHOR"]


if __name__ == "__main__":
    unittest.main()
