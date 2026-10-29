#!/usr/bin/env python3
"""hum-metrics-collect-lane-scoped-measurement.test.py — unit tests for
measure_open_interventions() in bin/hum-metrics-collect.

Covers hum-i-20260705-03: a lane-scoped intervention (r["lane"] set, e.g.
"exercise") must be measured against that lane's OWN
lane_yield[lane].signal_per_surfaced, not the top-level (all-lanes)
signal_per_surfaced -- otherwise a lane-specific fix's real effect is
diluted by every other lane's noise and two exercise-scoped interventions
can end up with byte-identical measurement blocks to two global (lane:None)
ones (the exact bug observed in hum-interventions.jsonl before this fix).

Also covers the un-shipped-commit guard (MeasureOpenInterventionsCommitGuardTest
below): a row whose commit is still "pending" or None must never be measured,
even once applied_at + measure_at have passed -- regression for
hum-i-20260520-02/03/04, which picked up a measurement block from ambient
drift despite never having a real commit sha land.

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` rather than `node --test`.

Run: python3 -m unittest tests/hum-metrics-collect-lane-scoped-measurement.test.py -v
"""

import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(REPO_ROOT, "bin", "hum-metrics-collect")

# hum-metrics-collect has no .py suffix (it's a `#!/usr/bin/env python3` CLI
# entrypoint under bin/), so spec_from_file_location can't infer a
# loader from the extension -- give it one explicitly.
_loader = importlib.machinery.SourceFileLoader("hum_metrics_collect", SCRIPT_PATH)
_spec = importlib.util.spec_from_loader("hum_metrics_collect", _loader)
hmc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hmc)  # module-level code only defines funcs/consts; __name__ != "__main__"


def _daily_row(iso_date, global_sps, exercise_sps="__unset__"):
    """Build a daily row with a top-level signal_per_surfaced and, unless
    exercise_sps is the sentinel "__unset__", a lane_yield["exercise"] entry
    carrying its own signal_per_surfaced. Passing exercise_sps=None models a
    lane_yield entry that exists but has no scorable signal (0 surfaced that
    day); omitting the key entirely models a day the lane never appeared."""
    row = {"date": iso_date, "signal_per_surfaced": global_sps, "lane_yield": {}}
    if exercise_sps != "__unset__":
        row["lane_yield"]["exercise"] = {"signal_per_surfaced": exercise_sps}
    return row


def _iso_dates(start, n):
    return [(start + timedelta(days=i)).isoformat() for i in range(n)]


class MeasureOpenInterventionsLaneScopeTest(unittest.TestCase):
    def setUp(self):
        # Redirect INTERVENTIONS to a scratch file for the duration of each
        # test so this suite never touches the real hum-interventions.jsonl.
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd)
        self.addCleanup(os.unlink, path)
        self._orig_interventions = hmc.INTERVENTIONS
        hmc.INTERVENTIONS = path
        self.addCleanup(setattr, hmc, "INTERVENTIONS", self._orig_interventions)
        self.interventions_path = path

        self.applied_date = hmc.date(2026, 5, 20)
        before_dates = _iso_dates(self.applied_date - timedelta(days=7), 7)  # 05-13..05-19
        after_dates = _iso_dates(self.applied_date, 7)                       # 05-20..05-26

        # Global signal is FLAT (0.5 every day, before and after) -- a
        # lane:None intervention over this window must land "neutral".
        # The exercise lane's own signal trends sharply UP (0.1 -> 0.9) --
        # a lane:exercise intervention over the same window must land
        # "positive", and must NOT reuse the flat global trend.
        self.daily = (
            [_daily_row(d, 0.5, exercise_sps=0.1) for d in before_dates]
            + [_daily_row(d, 0.5, exercise_sps=0.9) for d in after_dates]
        )
        self.state = {"daily": self.daily}

    def _write_intervention(self, **overrides):
        applied = datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc)
        measure_at = applied + timedelta(days=1)  # already past "now" in every test
        row = {
            "id": "hum-i-test",
            "lane": None,
            # Default to a real (fake) commit sha so these fixtures model a
            # properly-shipped intervention -- tests that specifically want
            # to exercise the unshipped-commit guard (see
            # MeasureOpenInterventionsCommitGuardTest below) override this.
            "commit": "abc1234f",
            "applied_at": applied.isoformat(),
            "measure_at": measure_at.isoformat(),
            "measurement": None,
        }
        row.update(overrides)
        with open(self.interventions_path, "w") as f:
            f.write(json.dumps(row) + "\n")
        return row

    def _measured_row(self):
        with open(self.interventions_path) as f:
            lines = [json.loads(line) for line in f if line.strip()]
        self.assertEqual(len(lines), 1)
        return lines[0]

    def test_lane_scoped_intervention_reflects_lanes_own_trend(self):
        self._write_intervention(id="hum-i-20260520-03", lane="exercise")
        hmc.measure_open_interventions({}, self.state)
        m = self._measured_row()["measurement"]
        self.assertIsNotNone(m)
        self.assertAlmostEqual(m["before_signal_per_surfaced"], 0.1)
        self.assertAlmostEqual(m["after_signal_per_surfaced"], 0.9)
        self.assertAlmostEqual(m["delta_signal_per_surfaced"], 0.8)
        self.assertEqual(m["verdict"], "positive")
        # Distinct from the flat global trend -- proves it did NOT read the
        # top-level signal_per_surfaced (which would have scored 0.5/0.5,
        # delta 0.0, verdict "neutral", identical to the lane:None case).
        self.assertNotEqual(m["before_signal_per_surfaced"], 0.5)
        self.assertNotEqual(m["after_signal_per_surfaced"], 0.5)

    def test_lane_none_intervention_matches_pre_change_top_level_behavior(self):
        self._write_intervention(id="hum-i-20260520-01", lane=None)
        hmc.measure_open_interventions({}, self.state)
        m = self._measured_row()["measurement"]
        self.assertIsNotNone(m)
        # Flat top-level signal_per_surfaced (0.5 throughout): before==after,
        # delta 0.0, verdict neutral -- byte-identical to what the old
        # key="signal_per_surfaced" top-level lookup would have produced.
        self.assertAlmostEqual(m["before_signal_per_surfaced"], 0.5)
        self.assertAlmostEqual(m["after_signal_per_surfaced"], 0.5)
        self.assertAlmostEqual(m["delta_signal_per_surfaced"], 0.0)
        self.assertEqual(m["verdict"], "neutral")

    def test_lane_scoped_intervention_degrades_gracefully_on_sparse_lane_yield(self):
        # Rebuild the window so the exercise lane is missing entirely on some
        # before-days and present-but-signal-less (0 surfaced that day) on
        # some after-days -- the mean must skip those days (None-tolerant),
        # not crash and not silently coerce a missing day to 0.
        before_dates = _iso_dates(self.applied_date - timedelta(days=7), 7)
        after_dates = _iso_dates(self.applied_date, 7)
        daily = []
        for i, d in enumerate(before_dates):
            # First 3 days: no exercise lane_yield entry at all that day.
            exercise_sps = "__unset__" if i < 3 else 0.2
            daily.append(_daily_row(d, 0.5, exercise_sps=exercise_sps))
        for i, d in enumerate(after_dates):
            # First 2 after-days: lane present but signal_per_surfaced is
            # None (lane surfaced nothing that day).
            exercise_sps = None if i < 2 else 0.6
            daily.append(_daily_row(d, 0.5, exercise_sps=exercise_sps))
        state = {"daily": daily}

        self._write_intervention(id="hum-i-20260520-04", lane="exercise")
        # Must not raise.
        hmc.measure_open_interventions({}, state)
        m = self._measured_row()["measurement"]
        self.assertIsNotNone(m)
        # before mean = avg of the 4 days with exercise_sps=0.2 -> 0.2
        self.assertAlmostEqual(m["before_signal_per_surfaced"], 0.2)
        # after mean = avg of the 5 days with exercise_sps=0.6 -> 0.6
        self.assertAlmostEqual(m["after_signal_per_surfaced"], 0.6)
        self.assertEqual(m["verdict"], "positive")

    def test_two_exercise_scoped_interventions_no_longer_byte_identical_to_global(self):
        # Regression shape for the exact incident in evidence.metric_snapshot:
        # write one lane:None and one lane:exercise intervention in the same
        # run and confirm their measurement blocks now diverge.
        applied = datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc)
        measure_at = applied + timedelta(days=1)
        rows = [
            {"id": "hum-i-20260520-01", "lane": None, "commit": "7013a1d",
             "applied_at": applied.isoformat(),
             "measure_at": measure_at.isoformat(), "measurement": None},
            {"id": "hum-i-20260520-03", "lane": "exercise", "commit": "def5678a",
             "applied_at": applied.isoformat(),
             "measure_at": measure_at.isoformat(), "measurement": None},
        ]
        with open(self.interventions_path, "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        hmc.measure_open_interventions({}, self.state)
        with open(self.interventions_path) as f:
            measured = [json.loads(line) for line in f if line.strip()]
        by_id = {r["id"]: r["measurement"] for r in measured}
        self.assertNotEqual(by_id["hum-i-20260520-01"], by_id["hum-i-20260520-03"])
        self.assertEqual(by_id["hum-i-20260520-01"]["verdict"], "neutral")
        self.assertEqual(by_id["hum-i-20260520-03"]["verdict"], "positive")


class MeasureOpenInterventionsCommitGuardTest(unittest.TestCase):
    """Covers the un-shipped-commit guard added alongside the lane-scoping
    fix above: a row whose commit is still "pending" (or None, though in
    practice those also lack applied_at and get caught by that guard first)
    must never be measured, even when applied_at + measure_at have both
    passed and the window would otherwise produce a strong, real signal.
    Regression for hum-i-20260520-02/03/04, which shipped applied_at without
    a real commit sha ever landing and picked up a measurement block
    byte-identical to -01's (which did ship) purely from ambient drift."""

    def setUp(self):
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd)
        self.addCleanup(os.unlink, path)
        self._orig_interventions = hmc.INTERVENTIONS
        hmc.INTERVENTIONS = path
        self.addCleanup(setattr, hmc, "INTERVENTIONS", self._orig_interventions)
        self.interventions_path = path

        applied_date = hmc.date(2026, 5, 20)
        before_dates = _iso_dates(applied_date - timedelta(days=7), 7)
        after_dates = _iso_dates(applied_date, 7)
        # A strongly positive trend (0.1 -> 0.9) so a wrongly-measured row
        # would come back with an unmistakable non-neutral verdict rather
        # than something that could pass for "just happened to be neutral".
        self.daily = (
            [_daily_row(d, 0.1) for d in before_dates]
            + [_daily_row(d, 0.9) for d in after_dates]
        )
        self.state = {"daily": self.daily}

    def _write_row(self, **overrides):
        applied = datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc)
        measure_at = applied + timedelta(days=1)  # already past "now"
        row = {
            "id": "hum-i-test",
            "lane": None,
            "applied_at": applied.isoformat(),
            "measure_at": measure_at.isoformat(),
            "measurement": None,
        }
        row.update(overrides)
        with open(self.interventions_path, "w") as f:
            f.write(json.dumps(row) + "\n")
        return row

    def _row_after_run(self):
        hmc.measure_open_interventions({}, self.state)
        with open(self.interventions_path) as f:
            lines = [json.loads(line) for line in f if line.strip()]
        self.assertEqual(len(lines), 1)
        return lines[0]

    def test_commit_pending_row_is_never_measured(self):
        # The exact shape of hum-i-20260520-02/03/04: applied_at is set,
        # measure_at has passed, commit is the literal string "pending".
        self._write_row(id="hum-i-20260520-03", lane="exercise", commit="pending")
        row = self._row_after_run()
        self.assertIsNone(row.get("measurement"))

    def test_commit_none_row_is_never_measured(self):
        self._write_row(id="hum-i-test-nocommit", lane=None, commit=None)
        row = self._row_after_run()
        self.assertIsNone(row.get("measurement"))

    def test_commit_missing_entirely_is_never_measured(self):
        # Same as commit=None but the key is absent altogether -- r.get()
        # must degrade the same way for both shapes. _write_row's base row
        # (unlike _write_intervention's) carries no "commit" key unless an
        # override supplies one, so omitting the override already models this.
        self.assertNotIn("commit", self._write_row(id="hum-i-test-missingcommit", lane=None))
        result = self._row_after_run()
        self.assertIsNone(result.get("measurement"))

    def test_real_commit_sha_row_is_measured_normally(self):
        # Control: a real commit sha over the same strongly-trending window
        # must still be measured, and must reflect the real trend rather
        # than being silently swallowed by the new guard.
        self._write_row(id="hum-i-20260520-01", lane=None, commit="7013a1d")
        row = self._row_after_run()
        m = row.get("measurement")
        self.assertIsNotNone(m)
        self.assertAlmostEqual(m["before_signal_per_surfaced"], 0.1)
        self.assertAlmostEqual(m["after_signal_per_surfaced"], 0.9)
        self.assertEqual(m["verdict"], "positive")


if __name__ == "__main__":
    unittest.main()
