#!/usr/bin/env python3
"""hum-metrics-collect-lane-decay-negative.test.py — unit tests for
hum-i-20260712-03: the lane_decay_negative decay type in detect_decay()
(bin/hum-metrics-collect), plus the per-(lane, event_type) cooldown
keying in dispatch_qualitative_question() that this change introduced.

Background: detect_decay()'s pre-existing lane_decay_silent walk only fires
when a lane accumulates 5+ consecutive days of ZERO reactions. A lane that
gets reacted to every time it surfaces, but always negatively (down / snooze
/ freeform_neg), never has a zero-reaction day, so it can run in persistent
rejection indefinitely without ever tripping that walk -- even though
sustained rejection is a worse signal than silence. lane_decay_negative
closes that gap: it fires when a lane has surfaced >=3 times over the
trailing 7 days (DECAY_NEGATIVE_WINDOW_DAYS) and its mean daily
signal_per_surfaced across those surfaced days is <= -0.5
(DECAY_NEGATIVE_THRESHOLD).

A prior attempt at this same idea was reverted by the critic because it
shared the bare `cooldown[lane]` slot with lane_decay_silent: answering one
kind of decay question about a lane would silently block the other kind for
QUAL_COOLDOWN_DAYS. This version keys the cooldown by `f"{lane}:{event_type}"`
instead, with a bare-lane-key read fallback for cooldown entries written
before this change. Both halves are covered below.

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` rather than `node --test`.

Run: python3 -m unittest tests/hum-metrics-collect-lane-decay-negative.test.py -v
"""

import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(REPO_ROOT, "bin", "hum-metrics-collect")

# hum-metrics-collect has no .py suffix (it's a `#!/usr/bin/env python3` CLI
# entrypoint under bin/), so spec_from_file_location can't infer a
# loader from the extension -- give it one explicitly.
_loader = importlib.machinery.SourceFileLoader("hum_metrics_collect", SCRIPT_PATH)
_spec = importlib.util.spec_from_loader("hum_metrics_collect", _loader)
hmc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hmc)  # module-level code only defines funcs/consts; __name__ != "__main__"


class DetectDecayNegativeTest(unittest.TestCase):
    """Isolated from every other decay-event type the same way
    DecaySuppressionTest (hum-metrics-collect-accountability.test.py) is:
    ticks/surface_rate held in a range that never trips the surface-rate or
    global-drop branches, and rows omit top-level signal_per_surfaced so
    compute_rolling degrades global_decay_drop out entirely."""

    @staticmethod
    def _row(iso_date, lane_yield):
        return {"date": iso_date, "lane_yield": lane_yield, "ticks": 40, "surface_rate": 0.1}

    def test_fires_when_threshold_met_single_day(self):
        # 3 surfaced, 3 "down" reactions -> lane_signal = -3.0 / 3 = -1.0,
        # at/below DECAY_NEGATIVE_THRESHOLD (-0.5); surfaced_in_window == 3
        # meets DECAY_NEGATIVE_MIN_SURFACED.
        base = date(2026, 8, 25)
        today_row = self._row(base.isoformat(), {
            "tasks": {"surfaced": 3, "reactions": {"down": 3},
                      "signal_per_surfaced": -1.0}})
        events = hmc.detect_decay({"daily": []}, today_row)
        neg = [e for e in events if e["type"] == "lane_decay_negative"]
        self.assertEqual(len(neg), 1)
        self.assertEqual(neg[0]["lane"], "tasks")
        self.assertEqual(neg[0]["surfaced_in_window"], 3)
        self.assertAlmostEqual(neg[0]["mean_signal_per_surfaced"], -1.0)
        self.assertEqual(neg[0]["window_days"], hmc.DECAY_NEGATIVE_WINDOW_DAYS)

    def test_fires_across_multiple_days_in_window(self):
        # Mirrors the tasks-lane 2026-07-10 shape from the hypothesis: 1
        # surfaced + 1 down reaction per day, spread over 3 non-consecutive
        # entries within the trailing week (a quiet day sits between them,
        # unlike the contiguous-only silent walk).
        base = date(2026, 8, 25)
        daily = [
            self._row((base - timedelta(days=4)).isoformat(),
                      {"tasks": {"surfaced": 1, "reactions": {"down": 1},
                                 "signal_per_surfaced": -1.0}}),
            self._row((base - timedelta(days=3)).isoformat(),
                      {"tasks": {"surfaced": 0, "reactions": {}}}),  # quiet day
            self._row((base - timedelta(days=1)).isoformat(),
                      {"tasks": {"surfaced": 1, "reactions": {"freeform_neg": 1},
                                 "signal_per_surfaced": -0.5}}),
        ]
        today_row = self._row(base.isoformat(), {
            "tasks": {"surfaced": 1, "reactions": {"down": 1},
                      "signal_per_surfaced": -1.0}})
        events = hmc.detect_decay({"daily": daily}, today_row)
        neg = [e for e in events if e["type"] == "lane_decay_negative"]
        self.assertEqual(len(neg), 1)
        self.assertEqual(neg[0]["surfaced_in_window"], 3)
        # detect_decay rounds to 3dp, same as every other decay-event metric
        # in this file -- compare against the identically-rounded expectation
        # rather than the raw fraction (-2.5/3 == -0.8333...).
        self.assertAlmostEqual(neg[0]["mean_signal_per_surfaced"],
                                round((-1.0 + -0.5 + -1.0) / 3, 3), places=3)

    def test_does_not_fire_below_min_surfaced(self):
        # Only 2 surfaced (< DECAY_NEGATIVE_MIN_SURFACED of 3), even though
        # every one of them was maximally negative.
        base = date(2026, 8, 25)
        today_row = self._row(base.isoformat(), {
            "tasks": {"surfaced": 2, "reactions": {"down": 2},
                      "signal_per_surfaced": -1.0}})
        events = hmc.detect_decay({"daily": []}, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_negative" for e in events))

    def test_does_not_fire_when_mean_above_threshold(self):
        # 3 surfaced, 1 down -> lane_signal = -1.0 / 3 = -0.333, above (less
        # negative than) the -0.5 threshold.
        base = date(2026, 8, 25)
        today_row = self._row(base.isoformat(), {
            "tasks": {"surfaced": 3, "reactions": {"down": 1},
                      "signal_per_surfaced": -1.0 / 3}})
        events = hmc.detect_decay({"daily": []}, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_negative" for e in events))

    def test_days_outside_trailing_window_not_counted(self):
        # A heavily-negative row 8 days back (older than
        # DECAY_NEGATIVE_WINDOW_DAYS=7) must not count toward the total --
        # only 2 surfacings fall inside the trailing window, below the
        # min-surfaced floor.
        base = date(2026, 8, 25)
        daily = [
            self._row((base - timedelta(days=8)).isoformat(),
                      {"tasks": {"surfaced": 5, "reactions": {"down": 5},
                                 "signal_per_surfaced": -1.0}}),
            self._row((base - timedelta(days=1)).isoformat(),
                      {"tasks": {"surfaced": 1, "reactions": {"down": 1},
                                 "signal_per_surfaced": -1.0}}),
        ]
        today_row = self._row(base.isoformat(), {
            "tasks": {"surfaced": 1, "reactions": {"down": 1},
                      "signal_per_surfaced": -1.0}})
        events = hmc.detect_decay({"daily": daily}, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_negative" for e in events))

    def test_fully_silent_lane_does_not_trip_negative_detector(self):
        # Zero reactions -> lane_signal 0.0, signal_per_surfaced 0.0 (NOT
        # None -- None only happens when surfaced==0). mean_sps == 0.0 is
        # well above the -0.5 threshold, so a purely silent lane (already
        # covered by lane_decay_silent) is not double-flagged here.
        base = date(2026, 8, 25)
        today_row = self._row(base.isoformat(), {
            "tasks": {"surfaced": 3, "reactions": {}, "signal_per_surfaced": 0.0}})
        events = hmc.detect_decay({"daily": []}, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_negative" for e in events))

    def test_accountability_lane_still_fires_on_active_rejection(self):
        # Unlike lane_decay_silent, the negative-reception walk is NOT gated
        # on ACCOUNTABILITY_LANES -- an accountability lane getting explicit
        # thumbs-down reactions (not just silence) is still a real signal.
        base = date(2026, 8, 25)
        today_row = self._row(base.isoformat(), {
            "exercise": {"surfaced": 3, "reactions": {"down": 3},
                         "signal_per_surfaced": -1.0, "outcome_signal": True}})
        events = hmc.detect_decay({"daily": []}, today_row)
        self.assertTrue(any(e["type"] == "lane_decay_negative" and e["lane"] == "exercise"
                             for e in events))


class QualCooldownKeyingTest(unittest.TestCase):
    """dispatch_qualitative_question()'s per-(lane, event_type) cooldown key
    (hum-i-20260712-03), and the bare-lane-key migration fallback."""

    def setUp(self):
        fd, queue_path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(queue_path)
        self._orig_queue = hmc.QUAL_QUEUE
        hmc.QUAL_QUEUE = queue_path
        self.addCleanup(self._cleanup_path, hmc, "QUAL_QUEUE", self._orig_queue, queue_path)

        fd, cooldown_path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(cooldown_path)
        self._orig_cooldown = hmc.QUAL_COOLDOWN
        hmc.QUAL_COOLDOWN = cooldown_path
        self.addCleanup(self._cleanup_path, hmc, "QUAL_COOLDOWN", self._orig_cooldown, cooldown_path)

        self.queue_path = queue_path
        self.cooldown_path = cooldown_path

    @staticmethod
    def _cleanup_path(module, attr, orig, path):
        setattr(module, attr, orig)
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass

    @staticmethod
    def _negative_event(lane):
        return {"type": "lane_decay_negative", "lane": lane, "surfaced_in_window": 4,
                "mean_signal_per_surfaced": -0.75, "window_days": 7,
                "ts": datetime.now(timezone.utc).isoformat()}

    @staticmethod
    def _silent_event(lane):
        return {"type": "lane_decay_silent", "lane": lane, "days_silent": 6,
                "surfaced_in_window": 4, "ts": datetime.now(timezone.utc).isoformat()}

    def test_negative_question_uses_expected_shape(self):
        row = {"lane_yield": {"tasks": {"signal_per_surfaced": -0.75}}}
        result = hmc.dispatch_qualitative_question(self._negative_event("tasks"), row)
        self.assertIn("queued", result)
        with open(self.queue_path) as f:
            queued = json.load(f)
        self.assertEqual(queued["trigger_event"]["type"], "lane_decay_negative")
        self.assertIn("thumbs-down", queued["question"])
        self.assertEqual(queued["metric_snapshot"]["mean_signal_per_surfaced"], -0.75)
        cooldown = hmc.load_json(self.cooldown_path, {})
        self.assertIn("tasks:lane_decay_negative", cooldown)

    def test_silent_and_negative_cooldowns_are_independent(self):
        # A lane_decay_silent question about 'tasks' gets asked and its
        # cooldown stamped...
        row = {"lane_yield": {"tasks": {"signal_per_surfaced": -1.0}}}
        first = hmc.dispatch_qualitative_question(self._silent_event("tasks"), row)
        self.assertIn("queued", first)

        # ...then hum-deliver-qual consumes/clears the queue (simulated by
        # removing the file, matching what that binary does on delivery)...
        os.unlink(self.queue_path)

        # ...and a lane_decay_negative event for the SAME lane on the same
        # day must still be free to queue -- it has its own clock, and must
        # NOT be blocked by the lane_decay_silent cooldown just stamped.
        second = hmc.dispatch_qualitative_question(self._negative_event("tasks"), row)
        self.assertIn("queued", second, "lane_decay_negative must not share "
                       "lane_decay_silent's cooldown slot for the same lane")

        cooldown = hmc.load_json(self.cooldown_path, {})
        self.assertIn("tasks:lane_decay_silent", cooldown)
        self.assertIn("tasks:lane_decay_negative", cooldown)

    def test_same_event_type_still_honors_its_own_cooldown(self):
        row = {"lane_yield": {"tasks": {"signal_per_surfaced": -1.0}}}
        first = hmc.dispatch_qualitative_question(self._negative_event("tasks"), row)
        self.assertIn("queued", first)
        os.unlink(self.queue_path)  # clear the single-slot guard, isolate cooldown

        second = hmc.dispatch_qualitative_question(self._negative_event("tasks"), row)
        self.assertEqual(second.get("skipped"), "cooldown")

    def test_legacy_bare_lane_key_still_blocks_during_migration_window(self):
        # A cooldown.json written before this change (bare lane name, no
        # event-type suffix) must still be honored as a fallback, so a lane
        # already cooling down on ship day doesn't immediately re-fire under
        # the new keying scheme.
        now = datetime.now(timezone.utc)
        with open(self.cooldown_path, "w") as f:
            json.dump({"tasks": now.isoformat()}, f)
        row = {"lane_yield": {"tasks": {"signal_per_surfaced": -1.0}}}

        result = hmc.dispatch_qualitative_question(self._negative_event("tasks"), row)
        self.assertEqual(result.get("skipped"), "cooldown")

    def test_legacy_bare_lane_key_expired_does_not_block(self):
        # A stale legacy entry (older than QUAL_COOLDOWN_DAYS) must not block
        # -- same aging-out behavior the keyed format gets.
        stale = datetime.now(timezone.utc) - timedelta(days=hmc.QUAL_COOLDOWN_DAYS + 1)
        with open(self.cooldown_path, "w") as f:
            json.dump({"tasks": stale.isoformat()}, f)
        row = {"lane_yield": {"tasks": {"signal_per_surfaced": -1.0}}}

        result = hmc.dispatch_qualitative_question(self._negative_event("tasks"), row)
        self.assertIn("queued", result)


if __name__ == "__main__":
    unittest.main()
