#!/usr/bin/env python3
"""hum-metrics-collect-accountability.test.py — unit tests for the
accountability-lane handling in bin/hum-metrics-collect:

  - exercise_outcome_signal(): did a logged workout finish inside the local
    day window (mirrors exercise.mjs's own "exercisedToday" check), read from
    the configured workout source (hum-metrics `workout_recent_cmd`).
  - collect_for_day(): the new signal_per_surfaced_discretionary /
    surfaced_discretionary fields exclude accountability-lane (exercise,
    health) contributions from the tapback-based aggregate.
  - compute_rolling(): carries a discretionary rolling mean, tolerating
    legacy rows written before this field existed.
  - detect_decay(): suppresses lane_decay_silent for an accountability lane
    on a day its outcome_signal is True; unaffected otherwise, and
    unaffected for non-accountability lanes.

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` rather than `node --test`. It never calls a real
workout tracker -- subprocess.run is monkeypatched (or the call site is
simply unreached) in every test.

Run: python3 -m unittest tests/hum-metrics-collect-accountability.test.py -v
"""

import importlib.machinery
import importlib.util
import json
import os
import unittest
from datetime import date, timedelta
from unittest import mock

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(REPO_ROOT, "bin", "hum-metrics-collect")

# hum-metrics-collect has no .py suffix (it's a `#!/usr/bin/env python3` CLI
# entrypoint under bin/), so spec_from_file_location can't infer a
# loader from the extension -- give it one explicitly.
_loader = importlib.machinery.SourceFileLoader("hum_metrics_collect", SCRIPT_PATH)
_spec = importlib.util.spec_from_loader("hum_metrics_collect", _loader)
hmc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hmc)  # module-level code only defines funcs/consts; __name__ != "__main__"


def _fake_run(sessions=None, raise_exc=None, bad_json=False):
    def fake(*args, **kwargs):
        if raise_exc:
            raise raise_exc
        result = mock.Mock()
        result.stdout = "not json" if bad_json else json.dumps(sessions or [])
        result.returncode = 0
        return result
    return fake


class ExerciseOutcomeSignalTest(unittest.TestCase):
    def setUp(self):
        tz = hmc.get_local_tz()
        self.start, self.end = hmc.et_day_window(date(2026, 8, 24), tz)
        # A synthetic workout source; the installation's own lives in
        # agent/local/config/hum-metrics.json.
        patcher = mock.patch.object(
            hmc, "CFG", {"workout_recent_cmd": ["bin/workout-log", "recent", "--json"]})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_relative_command_resolves_against_the_checkout(self):
        captured = {}

        def fake(args, **kwargs):
            captured["args"] = args
            result = mock.Mock()
            result.stdout = "[]"
            return result
        with mock.patch.object(hmc.subprocess, "run", fake):
            hmc.exercise_outcome_signal(self.start, self.end)
        self.assertEqual(captured["args"][0], os.path.join(hmc.TOOLS, "bin", "workout-log"))
        self.assertEqual(captured["args"][1:], ["recent", "--json"])

    def test_none_without_a_configured_source(self):
        # A fresh install has no workout source: unknown, and nothing is run.
        with mock.patch.object(hmc, "CFG", {"workout_recent_cmd": []}), \
                mock.patch.object(hmc.subprocess, "run",
                                  side_effect=AssertionError("must not run")):
            self.assertIsNone(hmc.exercise_outcome_signal(self.start, self.end))

    def test_true_when_finished_session_in_window(self):
        sessions = [{
            "id": "s1", "started_at": "2026-08-24T15:00:00+00:00",
            "finished_at": "2026-08-24T15:30:00+00:00", "workout_type": "strengthA",
        }]
        with mock.patch.object(hmc.subprocess, "run", _fake_run(sessions)):
            self.assertIs(hmc.exercise_outcome_signal(self.start, self.end), True)

    def test_false_when_no_session_in_window(self):
        sessions = [{
            "id": "s1", "started_at": "2026-08-20T15:00:00+00:00",
            "finished_at": "2026-08-20T15:30:00+00:00", "workout_type": "strengthA",
        }]
        with mock.patch.object(hmc.subprocess, "run", _fake_run(sessions)):
            self.assertIs(hmc.exercise_outcome_signal(self.start, self.end), False)

    def test_false_when_only_unfinished_session_in_window(self):
        # Started today but never finished -- not evidence the nudge worked.
        sessions = [{
            "id": "s1", "started_at": "2026-08-24T15:00:00+00:00",
            "finished_at": None, "workout_type": "strengthA",
        }]
        with mock.patch.object(hmc.subprocess, "run", _fake_run(sessions)):
            self.assertIs(hmc.exercise_outcome_signal(self.start, self.end), False)

    def test_none_on_subprocess_failure(self):
        with mock.patch.object(hmc.subprocess, "run", _fake_run(raise_exc=RuntimeError("boom"))):
            self.assertIsNone(hmc.exercise_outcome_signal(self.start, self.end))

    def test_none_on_malformed_json(self):
        with mock.patch.object(hmc.subprocess, "run", _fake_run(bad_json=True)):
            self.assertIsNone(hmc.exercise_outcome_signal(self.start, self.end))

    def test_none_when_payload_is_not_a_list(self):
        def fake(*args, **kwargs):
            result = mock.Mock()
            result.stdout = json.dumps({"unexpected": "shape"})
            return result
        with mock.patch.object(hmc.subprocess, "run", fake):
            self.assertIsNone(hmc.exercise_outcome_signal(self.start, self.end))


class DiscretionaryAggregateTest(unittest.TestCase):
    def setUp(self):
        self.tz = hmc.get_local_tz()
        self.target_date = date(2026, 8, 24)
        self.start, self.end = hmc.et_day_window(self.target_date, self.tz)
        self.ts = self.start.isoformat()
        # collect_for_day() calls derive_context_flags(), which now shells out
        # to `home-presence` to resolve the traveling flag -- stub it so this
        # suite stays hermetic (no live Supabase/network dependency) and
        # focused on the discretionary-aggregate fields it actually asserts
        # on. Coverage for derive_context_flags() itself lives in
        # hum-metrics-collect-traveling-flag.test.py.
        patcher = mock.patch.object(
            hmc, "derive_context_flags",
            return_value={"traveling": None, "hum_paused_hours": None,
                          "calendar_density": None})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_excludes_accountability_lane_from_global_discretionary_aggregate(self):
        runs = [
            # exercise: 1 surfaced ping, 0 reactions -- the exact pattern the
            # hypothesis is about.
            {"ts": self.ts, "sonnet": {"decision": "info", "based_on_topic": "exercise"},
             "outcome": {"sent": True, "ping_id": "p-ex-1"},
             "harvest": {"candidates": [{"topic": "exercise"}]}},
            # dining: 1 surfaced ping that DID get a reaction.
            {"ts": self.ts, "sonnet": {"decision": "info", "based_on_topic": "dining"},
             "outcome": {"sent": True, "ping_id": "p-din-1"},
             "harvest": {"candidates": [{"topic": "dining"}]}},
        ]
        history = [
            {"kind": "reaction", "ts": self.ts, "subject_key": "dining:abc",
             "reaction_token": "love", "message_id": "m1"},
        ]
        with mock.patch.object(hmc, "exercise_outcome_signal", return_value=False):
            row = hmc.collect_for_day(self.target_date, self.tz, runs, [], history)

        # Global metric still includes exercise's 0-reaction surfaced ping.
        self.assertEqual(row["surfaced"], 2)
        self.assertAlmostEqual(row["signal_per_surfaced"], 1.0)  # (love=2.0) / 2 surfaced

        # Discretionary metric excludes exercise entirely.
        self.assertEqual(row["surfaced_discretionary"], 1)
        self.assertAlmostEqual(row["signal_per_surfaced_discretionary"], 2.0)  # 2.0 / 1

        self.assertEqual(row["lane_yield"]["exercise"]["outcome_signal"], False)
        self.assertNotIn("outcome_signal", row["lane_yield"]["dining"])

    def test_health_lane_outcome_signal_is_none_not_reused_from_exercise(self):
        runs = [
            {"ts": self.ts, "sonnet": {"decision": "info", "based_on_topic": "health"},
             "outcome": {"sent": True, "ping_id": "p-health-1"},
             "harvest": {"candidates": [{"topic": "health"}]}},
        ]
        # No exercise activity this day, so exercise_outcome_signal must not
        # even be invoked -- assert that by NOT patching it and letting a real
        # call blow up the test if it's ever reached.
        with mock.patch.object(hmc, "exercise_outcome_signal",
                                side_effect=AssertionError("must not be called for health-only day")):
            row = hmc.collect_for_day(self.target_date, self.tz, runs, [], [])
        self.assertIsNone(row["lane_yield"]["health"]["outcome_signal"])
        self.assertNotIn("exercise", row["lane_yield"])

    def test_discretionary_equals_global_when_no_accountability_lanes_present(self):
        runs = [
            {"ts": self.ts, "sonnet": {"decision": "info", "based_on_topic": "music"},
             "outcome": {"sent": True, "ping_id": "p-mu-1"},
             "harvest": {"candidates": [{"topic": "music"}]}},
        ]
        history = [
            {"kind": "reaction", "ts": self.ts, "subject_key": "music:xyz",
             "reaction_token": "up", "message_id": "m2"},
        ]
        row = hmc.collect_for_day(self.target_date, self.tz, runs, [], history)
        self.assertEqual(row["signal_per_surfaced"], row["signal_per_surfaced_discretionary"])
        self.assertEqual(row["surfaced"], row["surfaced_discretionary"])
        self.assertNotIn("outcome_signal", row["lane_yield"]["music"])


class ComputeRollingDiscretionaryTest(unittest.TestCase):
    def test_rolling_includes_discretionary_mean(self):
        target = date(2026, 8, 24)
        rows = [
            {"date": (target - timedelta(days=1)).isoformat(), "signal_per_surfaced": 1.0,
             "signal_per_surfaced_discretionary": 2.0, "surface_rate": 0.1},
            {"date": target.isoformat(), "signal_per_surfaced": 0.5,
             "signal_per_surfaced_discretionary": 1.0, "surface_rate": 0.2},
        ]
        result = hmc.compute_rolling(rows, target, 7)
        self.assertAlmostEqual(result["signal_per_surfaced_discretionary"], 1.5)

    def test_rolling_tolerates_missing_discretionary_field_on_legacy_rows(self):
        target = date(2026, 8, 24)
        rows = [{"date": target.isoformat(), "signal_per_surfaced": 0.5, "surface_rate": 0.2}]
        result = hmc.compute_rolling(rows, target, 7)
        self.assertIsNone(result["signal_per_surfaced_discretionary"])


class DecaySuppressionTest(unittest.TestCase):
    """detect_decay's per-lane lane_decay_silent walk, isolated from every
    other decay-event type by keeping surface_rate/ticks in a range that
    never trips the surface-rate-anomaly or global-drop branches."""

    @staticmethod
    def _row(iso_date, lane_yield):
        return {"date": iso_date, "lane_yield": lane_yield, "ticks": 40, "surface_rate": 0.1}

    def _five_silent_days(self, base, today_outcome_signal):
        # 4 prior silent days + today = 5, matching DECAY_DAYS_SILENT and the
        # real-world observed shape (days_silent=5, surfaced_in_window>=3).
        daily = []
        for i in range(4, 0, -1):
            d = (base - timedelta(days=i)).isoformat()
            daily.append(self._row(d, {
                "exercise": {"surfaced": 1, "reactions": {}, "outcome_signal": None}}))
        today_row = self._row(base.isoformat(), {
            "exercise": {"surfaced": 1, "reactions": {}, "outcome_signal": today_outcome_signal}})
        return {"daily": daily}, today_row

    def test_suppressed_when_todays_outcome_signal_is_true(self):
        base = date(2026, 8, 25)
        state, today_row = self._five_silent_days(base, today_outcome_signal=True)
        events = hmc.detect_decay(state, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_silent" for e in events))

    def test_still_fires_when_todays_outcome_signal_is_false(self):
        base = date(2026, 8, 25)
        state, today_row = self._five_silent_days(base, today_outcome_signal=False)
        events = hmc.detect_decay(state, today_row)
        self.assertTrue(any(e["type"] == "lane_decay_silent" and e["lane"] == "exercise"
                             for e in events))

    def test_still_fires_when_todays_outcome_signal_is_none_unknown(self):
        base = date(2026, 8, 25)
        state, today_row = self._five_silent_days(base, today_outcome_signal=None)
        events = hmc.detect_decay(state, today_row)
        self.assertTrue(any(e["type"] == "lane_decay_silent" and e["lane"] == "exercise"
                             for e in events))

    def test_non_accountability_lane_unaffected_by_outcome_signal_key(self):
        base = date(2026, 8, 25)
        daily = []
        for i in range(4, 0, -1):
            d = (base - timedelta(days=i)).isoformat()
            daily.append(self._row(d, {"music": {"surfaced": 1, "reactions": {}}}))
        # Even if something upstream ever stamped outcome_signal=True on a
        # non-accountability lane, suppression must not apply to it.
        today_row = self._row(base.isoformat(),
                               {"music": {"surfaced": 1, "reactions": {}, "outcome_signal": True}})
        state = {"daily": daily}
        events = hmc.detect_decay(state, today_row)
        self.assertTrue(any(e["type"] == "lane_decay_silent" and e["lane"] == "music"
                             for e in events))


if __name__ == "__main__":
    unittest.main()
