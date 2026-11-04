#!/usr/bin/env python3
"""day-path-walked-out.test.py — a visit row ends where the trace walked out of it.

The case (synthetic places): iOS wrote a 15:45:55 visit on a side street with its departure at
17:13:17. The fixes: 15:50 near the row, 16:02 (3.9 m) 181 m from it and 98 m from the
flat, the phone quiet, then 17:18 at the flat, where it sat all evening. The 16:02 fix
fell in the 150-400 m band that counts for neither side, so the row kept the silence and
the summary's walk home ran to 5:13pm, though at 4:16pm the user wrote of having walked
back to the apartment. Now the row ends at 16:02 and the flat begins at about 16:04.
Run: python3 tests/day-path-walked-out.test.py
"""
import os, sys, unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "fixtures"))
from fake_geo import at as G, load_rows  # noqa: E402,F401
mod = type(sys)("daypath")
exec(compile(open(os.path.join(REPO, "bin", "day-path")).read(), "day-path", "exec"), mod.__dict__)

T0 = datetime(2026, 10, 21, 12, 45, 55, tzinfo=timezone.utc)     # 15:45:55 Israel
ROW = G(0.0, 0.0)                         # where iOS saw the user slow down
NEAR = G(34.81, -32.49)                                        # 15:50, 47 m from the row
OUT = G(-0.06, -181.49)                                         # 16:02, 181 m from it, 98 m from the flat
FLAT = G(-97.13, -191.5)


def fix(sec, pos, acc=15.0):
    return dict(t=T0 + timedelta(seconds=sec), lat=pos[0], lon=pos[1], acc=acc)


def afternoon(out=OUT, out_acc=3.9, back_sec=5541, home=FLAT):
    """15:44 approach, 15:50 near the row, 16:02 out, quiet, then the evening at `home`."""
    approach = G(74.39, 157.65)
    fixes = [fix(-99, approach, 36.5), fix(301, NEAR, 16.4), fix(1021, out, out_acc)]
    fixes += [fix(back_sec, home, 23.5), fix(back_sec + 197, home, 11.5),
              fix(back_sec + 1300, home, 12.0), fix(back_sec + 3100, home, 14.0)]
    return fixes


def row(end_sec=5242, ptype="address"):                            # 17:13:17
    return dict(start=T0, end=T0 + timedelta(seconds=end_sec), lat=ROW[0], lon=ROW[1], ptype=ptype)


def reconcile(fixes, **kw):
    stays = mod.stay_points(fixes)
    stays += mod.silence_stays(fixes, stays)
    spans, why = mod.reconcile_visit(row(**kw), fixes, stays)
    return spans, stays


def home_stay(stays, home=FLAT):
    return next(s for s in stays if not s.get("silence") and mod.haversine((s["lat"], s["lon"]), home) < 30)


class WalkedOut(unittest.TestCase):
    def test_precondition_the_last_fix_is_in_the_neutral_band(self):
        d = mod.haversine(ROW, OUT)
        self.assertGreater(d, mod.CORROB_M)
        self.assertLess(d, mod.CONTRA_M, "a fix here counted as neither for nor against the row")
        self.assertGreater(mod.haversine(ROW, FLAT), mod.STAY_SPLIT_M)
        self.assertLess(mod.haversine(OUT, FLAT), mod.haversine(OUT, ROW))

    def test_the_row_ends_at_the_fix_that_had_him_beyond_it(self):
        spans, stays = reconcile(afternoon())
        self.assertEqual(len(spans), 1, spans)
        s, e, _w, _c = spans[0]
        self.assertEqual(s, T0)
        self.assertEqual(e, T0 + timedelta(seconds=1021), "16:02:56, not iOS's 17:13:17")

    def test_the_flat_begins_when_the_walk_there_ended(self):
        _spans, stays = reconcile(afternoon())
        st = home_stay(stays)
        walk = mod.haversine(OUT, (st["lat"], st["lon"])) / mod.SILENCE_WALK_MPS
        self.assertEqual(st["start"], T0 + timedelta(seconds=1021 + walk))
        self.assertEqual(st["walked_in_from"], T0 + timedelta(seconds=5541), "the first fix that saw him there")

    def test_a_loose_last_fix_is_not_evidence(self):
        spans, stays = reconcile(afternoon(out_acc=60.0))
        self.assertEqual(spans[0][1], T0 + timedelta(seconds=5242))
        self.assertNotIn("walked_in_from", home_stay(stays))

    def test_a_short_quiet_is_not_a_departure(self):
        """The next fix 20 minutes on: that is the phone sampling, not him gone quiet elsewhere."""
        spans, _ = reconcile(afternoon(back_sec=2221), end_sec=1500)
        self.assertEqual(spans[0][1], T0 + timedelta(seconds=1500))

    def test_heading_away_from_where_he_was_found_does_not_cut(self):
        """The last fix is nearer the row than the place the phone next found him."""
        elsewhere = G(204.44, 271.07)                           # ~330 m north of the row
        spans, stays = reconcile(afternoon(home=elsewhere))
        self.assertEqual(spans[0][1], T0 + timedelta(seconds=5242))

    def test_no_stay_where_the_phone_woke_keeps_the_row(self):
        fixes = afternoon()[:4]                                    # one fix at the flat, then nothing
        spans, _ = reconcile(fixes)
        self.assertEqual(spans[0][1], T0 + timedelta(seconds=5242))

    def test_a_row_he_answered_for_is_never_cut(self):
        spans, _ = reconcile(afternoon(), ptype="user-confirmed")
        self.assertEqual(spans[0][1], T0 + timedelta(seconds=5242))

    def test_kill_switch(self):
        os.environ["JORI_WALKED_OUT"] = "0"
        try:
            spans, stays = reconcile(afternoon())
            self.assertEqual(spans[0][1], T0 + timedelta(seconds=5242))
            self.assertNotIn("walked_in_from", home_stay(stays))
        finally:
            del os.environ["JORI_WALKED_OUT"]


def fix_row(f, i):
    return dict(id=f"f{i}", segment_type="transit", latitude=f["lat"], longitude=f["lon"],
                accuracy_m=f["acc"], arrived_at=f["t"].isoformat(), departed_at=None, activity="walking",
                place_name=None, place_type="transit", city=None)


class WalkedOutOnTheSpine(unittest.TestCase):
    def test_the_spine_reads_pause_short_walk_flat(self):
        rows = [fix_row(f, i) for i, f in enumerate(afternoon())]
        rows.append(dict(id="v-row", segment_type="visit", latitude=ROW[0], longitude=ROW[1], accuracy_m=15.7,
                         arrived_at=T0.isoformat(), departed_at=(T0 + timedelta(seconds=5242)).isoformat(),
                         activity="stationary", place_name="Example Street", place_type="address", city=None))
        day = mod.build("2026-10-21", "Asia/Jerusalem", rows, do_match=False)
        dwells = [n for n in day["spine"] if n["type"] == "dwell"]
        self.assertEqual([(n["start"], n["end"]) for n in dwells], [("15:45", "16:02"), ("16:04", "18:09")],
                         dwells)
        self.assertEqual(dwells[1]["witnessed_min"], 52, "the quiet before 17:18 was not seen")


if __name__ == "__main__":
    unittest.main()
