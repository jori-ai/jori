#!/usr/bin/env python3
"""hum-metrics-collect-lane-decay-dark.test.py — unit tests for
hum-i-20260816-01: the lane_decay_dark decay type in detect_decay()
(bin/hum-metrics-collect), plus its dispatch_qualitative_question()
wiring.

Background: detect_decay()'s pre-existing per-lane walks
(lane_decay_silent, lane_decay_negative) both key off `surfaced` /
`reactions` -- they can only ever consider a lane once something was
actually delivered to the user. A lane that generates real candidate volume
but is surfaced ZERO times trips neither: it never has a surfaced-then-
silent day to start the DECAY_DAYS_SILENT clock, and it never has a
reaction to score negatively. Measured 2026-08-15 (trailing 14d): six lanes
hit exactly this blind spot with real candidate volume and zero decay
alerts (13-106 candidates each, 0 surfaced). lane_decay_dark closes that gap by reading
`candidates` instead: it fires when a lane's trailing
DECAY_DARK_WINDOW_DAYS (7) average candidates/day is at least
DECAY_DARK_MIN_AVG_CANDIDATES (3.0) and it surfaced NOTHING across that
same window.

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` rather than `node --test`.

Run: python3 -m unittest tests/hum-metrics-collect-lane-decay-dark.test.py -v
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


class DetectDecayDarkTest(unittest.TestCase):
    """Isolated from every other decay-event type the same way
    DecaySuppressionTest (hum-metrics-collect-accountability.test.py) and
    DetectDecayNegativeTest (hum-metrics-collect-lane-decay-negative.test.py)
    are: ticks/surface_rate held in a range that never trips the
    surface-rate or global-drop branches, and rows omit top-level
    signal_per_surfaced so compute_rolling degrades global_decay_drop out
    entirely."""

    @staticmethod
    def _row(iso_date, lane_yield):
        return {"date": iso_date, "lane_yield": lane_yield, "ticks": 40, "surface_rate": 0.1}

    @staticmethod
    def _dark_lane(candidates, surfaced=0):
        return {"candidates": candidates, "surfaced": surfaced, "reactions": {},
                "signal_per_surfaced": None, "yield_rate": (surfaced / candidates
                                                             if candidates else None)}

    def _full_window(self, base, per_day_candidates, lane="music"):
        """Build DECAY_DARK_WINDOW_DAYS rows (today inclusive) each carrying
        `per_day_candidates` candidates and zero surfacing for `lane`."""
        daily = [
            self._row((base - timedelta(days=n)).isoformat(),
                       {lane: self._dark_lane(per_day_candidates)})
            for n in range(1, hmc.DECAY_DARK_WINDOW_DAYS)
        ]
        today_row = self._row(base.isoformat(), {lane: self._dark_lane(per_day_candidates)})
        return daily, today_row

    def test_fires_when_avg_at_threshold_across_full_window(self):
        # 7 days x 3 candidates/day, zero surfaced -> avg exactly 3.0, at
        # DECAY_DARK_MIN_AVG_CANDIDATES.
        base = date(2026, 8, 25)
        daily, today_row = self._full_window(base, 3, lane="music")
        events = hmc.detect_decay({"daily": daily}, today_row)
        dark = [e for e in events if e["type"] == "lane_decay_dark"]
        self.assertEqual(len(dark), 1)
        self.assertEqual(dark[0]["lane"], "music")
        self.assertEqual(dark[0]["candidates_in_window"], 3 * hmc.DECAY_DARK_WINDOW_DAYS)
        self.assertEqual(dark[0]["window_days"], hmc.DECAY_DARK_WINDOW_DAYS)
        self.assertAlmostEqual(dark[0]["avg_candidates_per_day"], 3.0)

    def test_matches_hypothesis_lanes_from_action_item(self):
        # hum-i-20260816-01's own evidence.metric_snapshot, scaled to a 7d
        # window: talks generated 79 candidates over 14d in the real
        # incident (~5.6/day) -- well above the 3.0 floor -- and surfaced
        # zero the whole time.
        base = date(2026, 8, 25)
        daily, today_row = self._full_window(base, 6, lane="talks")
        events = hmc.detect_decay({"daily": daily}, today_row)
        self.assertTrue(any(e["type"] == "lane_decay_dark" and e["lane"] == "talks"
                             for e in events))

    def test_does_not_fire_below_avg_threshold(self):
        # 7 days x 2 candidates/day -> avg 2.0, below the 3.0 floor.
        base = date(2026, 8, 25)
        daily, today_row = self._full_window(base, 2, lane="crossref")
        events = hmc.detect_decay({"daily": daily}, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_dark" for e in events))

    def test_does_not_fire_when_any_surfaced_in_window(self):
        # Same candidate volume as the firing case, but one day in the
        # window actually surfaced something for the lane -- this is
        # exactly the case lane_decay_silent already owns, so lane_decay_dark
        # must stay out of it.
        base = date(2026, 8, 25)
        daily, today_row = self._full_window(base, 3, lane="art")
        # Give the oldest row in the window one surfacing.
        daily[-1]["lane_yield"]["art"]["surfaced"] = 1
        events = hmc.detect_decay({"daily": daily}, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_dark" for e in events))

    def test_single_day_of_data_does_not_manufacture_a_false_trigger(self):
        # Fixed-window averaging (hum-i-20260816-01's design note): dividing
        # by DECAY_DARK_WINDOW_DAYS rather than by observed-row count means
        # a lane with just ONE day of history needs a very large single-day
        # spike to cross the threshold on its own, and a realistic one-off
        # spike (e.g. 5 candidates, well above a normal day but far short of
        # 21 = 3.0 * 7) must NOT fire.
        base = date(2026, 8, 25)
        today_row = self._row(base.isoformat(), {"email_followups": self._dark_lane(5)})
        events = hmc.detect_decay({"daily": []}, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_dark" for e in events))

    def test_days_outside_trailing_window_not_counted(self):
        # A heavy-candidate row 8 days back (older than
        # DECAY_DARK_WINDOW_DAYS=7) must not count toward the total.
        base = date(2026, 8, 25)
        daily = [
            self._row((base - timedelta(days=8)).isoformat(),
                       {"rentals": self._dark_lane(50)}),
        ] + [
            self._row((base - timedelta(days=n)).isoformat(),
                       {"rentals": self._dark_lane(1)})
            for n in range(1, hmc.DECAY_DARK_WINDOW_DAYS)
        ]
        today_row = self._row(base.isoformat(), {"rentals": self._dark_lane(1)})
        events = hmc.detect_decay({"daily": daily}, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_dark" for e in events))

    def test_lane_with_zero_candidates_never_fires(self):
        # A lane present in lane_yield (e.g. via a reaction-only row) but
        # with no candidates at all must never trip the avg-candidates
        # floor.
        base = date(2026, 8, 25)
        today_row = self._row(base.isoformat(), {
            "email_followups": {"candidates": 0, "surfaced": 0, "reactions": {},
                                 "signal_per_surfaced": None, "yield_rate": None}})
        events = hmc.detect_decay({"daily": []}, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_dark" for e in events))

    def test_does_not_double_fire_alongside_lane_decay_silent(self):
        # A lane that DOES surface (even once) in the window is scored by
        # lane_decay_silent's own machinery, not this one -- confirm the two
        # detectors partition cleanly rather than both firing for the same
        # lane on the same day.
        base = date(2026, 8, 25)
        daily = [
            self._row((base - timedelta(days=n)).isoformat(),
                       {"news": {"candidates": 5, "surfaced": (1 if n == 5 else 0),
                                 "reactions": {}, "signal_per_surfaced": None}})
            for n in range(1, hmc.DECAY_DARK_WINDOW_DAYS)
        ]
        today_row = self._row(base.isoformat(),
                               {"news": {"candidates": 5, "surfaced": 0, "reactions": {},
                                         "signal_per_surfaced": None}})
        events = hmc.detect_decay({"daily": daily}, today_row)
        self.assertFalse(any(e["type"] == "lane_decay_dark" and e["lane"] == "news"
                             for e in events))


class QualDispatchDarkTest(unittest.TestCase):
    """dispatch_qualitative_question()'s lane_decay_dark branch: distinct
    question wording from lane_decay_silent, its own cooldown key, and
    normal single-slot-queue behavior (already covered generically by
    hum-metrics-collect-lane-decay-negative.test.py's QualCooldownKeyingTest
    for the shared machinery; this class only checks what's new)."""

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
    def _dark_event(lane):
        return {"type": "lane_decay_dark", "lane": lane, "candidates_in_window": 42,
                "window_days": 7, "avg_candidates_per_day": 6.0,
                "ts": datetime.now(timezone.utc).isoformat()}

    @staticmethod
    def _silent_event(lane):
        return {"type": "lane_decay_silent", "lane": lane, "days_silent": 6,
                "surfaced_in_window": 4, "ts": datetime.now(timezone.utc).isoformat()}

    def test_dark_question_uses_expected_shape(self):
        row = {"lane_yield": {"music": {"signal_per_surfaced": None}}}
        result = hmc.dispatch_qualitative_question(self._dark_event("music"), row)
        self.assertIn("queued", result)
        with open(self.queue_path) as f:
            queued = json.load(f)
        self.assertEqual(queued["trigger_event"]["type"], "lane_decay_dark")
        self.assertIn("misfiring upstream", queued["question"])
        self.assertIn("42", queued["question"])
        self.assertEqual(queued["metric_snapshot"]["candidates_in_window"], 42)
        self.assertEqual(queued["metric_snapshot"]["avg_candidates_per_day"], 6.0)
        cooldown = hmc.load_json(self.cooldown_path, {})
        self.assertIn("music:lane_decay_dark", cooldown)

    def test_dark_and_silent_cooldowns_are_independent(self):
        row = {"lane_yield": {"music": {"signal_per_surfaced": None}}}
        first = hmc.dispatch_qualitative_question(self._silent_event("music"), row)
        self.assertIn("queued", first)
        os.unlink(self.queue_path)  # simulate hum-deliver-qual consuming the slot

        second = hmc.dispatch_qualitative_question(self._dark_event("music"), row)
        self.assertIn("queued", second, "lane_decay_dark must not share "
                       "lane_decay_silent's cooldown slot for the same lane")

        cooldown = hmc.load_json(self.cooldown_path, {})
        self.assertIn("music:lane_decay_silent", cooldown)
        self.assertIn("music:lane_decay_dark", cooldown)

    def test_same_event_type_still_honors_its_own_cooldown(self):
        row = {"lane_yield": {"music": {"signal_per_surfaced": None}}}
        first = hmc.dispatch_qualitative_question(self._dark_event("music"), row)
        self.assertIn("queued", first)
        os.unlink(self.queue_path)  # clear the single-slot guard, isolate cooldown

        second = hmc.dispatch_qualitative_question(self._dark_event("music"), row)
        self.assertEqual(second.get("skipped"), "cooldown")


if __name__ == "__main__":
    unittest.main()
