#!/usr/bin/env python3
"""hum-metrics-collect-daily-gap.test.py — unit tests for hum-i-20260816-04:
detect_daily_gap() (silent-collection-gap detection) and the --backfill
flag's qualitative-dispatch skip.

Background: the 2026-08-14 daily[] row was never written because that day's
collector run crashed on a malformed harvest.candidates element and exited
before its write step (fixed separately, see the isinstance(cand, dict)
guard in collect_for_day). Nothing else noticed for weeks -- every
rolling_7d/rolling_30d/decay computation since then silently averaged across
the hole. This suite covers the two additions that address it:

  1. detect_daily_gap() -- a pure function that, given the daily[] rows on
     file and the date about to be collected, reports any missing day(s)
     immediately preceding it. Wired into main() right before the write
     step so a future silent skip surfaces in data/logs/hum-metrics.log
     (via trigger-hum-metrics-collect.sh's stdout/stderr redirect) instead
     of vanishing.

  2. --backfill -- lets a historical gap be filled through the same
     collection code path (collect_for_day + detect_decay) without letting a
     stale day's decay_events reach the live qualitative-question pipeline
     (QUAL_QUEUE/QUAL_COOLDOWN), which would otherwise eventually surface to
     the user via hum-deliver-qual framed as a fresh diagnosis question about
     ancient data.

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` (or directly as a script) rather than `node --test`.

Run: python3 tests/hum-metrics-collect-daily-gap.test.py -v
"""

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
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


class DetectDailyGapTest(unittest.TestCase):
    """Pure unit tests for detect_daily_gap() -- no file I/O."""

    def test_no_gap_when_prior_day_present(self):
        daily = [{"date": "2025-06-09"}, {"date": "2025-06-10"}]
        gap = hmc.detect_daily_gap(daily, date(2025, 6, 11))
        self.assertEqual(gap, [])

    def test_single_missing_day_reported(self):
        # 06-09 present, 06-10 missing, target is 06-11 -> gap = [06-10].
        daily = [{"date": "2025-06-09"}]
        gap = hmc.detect_daily_gap(daily, date(2025, 6, 11))
        self.assertEqual(gap, ["2025-06-10"])

    def test_multi_day_gap_reported_in_chronological_order(self):
        daily = [{"date": "2025-06-05"}]
        gap = hmc.detect_daily_gap(daily, date(2025, 6, 9))
        self.assertEqual(gap, ["2025-06-06", "2025-06-07", "2025-06-08"])

    def test_no_history_at_all_is_not_a_gap(self):
        # An empty daily[] means the series hasn't started yet -- nothing to
        # be missing relative to.
        self.assertEqual(hmc.detect_daily_gap([], date(2025, 6, 11)), [])

    def test_target_at_start_of_history_is_not_a_gap(self):
        # Walking back from the very first date on file must stop instead of
        # reporting every day since the dawn of time as "missing".
        daily = [{"date": "2025-06-10"}]
        gap = hmc.detect_daily_gap(daily, date(2025, 6, 10))
        self.assertEqual(gap, [])

    def test_ignores_non_dict_and_dateless_rows(self):
        daily = [{"date": "2025-06-09"}, "not a dict", {"no_date": True}]
        gap = hmc.detect_daily_gap(daily, date(2025, 6, 11))
        self.assertEqual(gap, ["2025-06-10"])

    def test_matches_the_08_14_incident_shape(self):
        # 08-13 present, 08-14 missing -- 08-15's own run (target=08-15) is
        # the one that would have caught it. This is the real shape of
        # hum-i-20260816-04 before this fix.
        daily = [{"date": "2026-08-13"}, {"date": "2026-08-12"}]
        gap = hmc.detect_daily_gap(daily, date(2026, 8, 15))
        self.assertEqual(gap, ["2026-08-14"])

    def test_gap_is_reported_exactly_once(self):
        # Simulates two consecutive daily runs: the 06-11 run notices 06-10
        # is missing; after that gap gets backfilled, the NEXT run (target
        # 06-11's own successor, i.e. the run whose target is 06-11 itself
        # having already happened, so this checks the run that targets
        # 06-11 again is moot -- what matters is that a run whose
        # predecessor is the now-filled date no longer reports it) must not
        # re-report the same date.
        daily = [{"date": "2025-06-09"}]  # 06-10 still missing at this point
        gap_day1 = hmc.detect_daily_gap(daily, date(2025, 6, 11))
        self.assertEqual(gap_day1, ["2025-06-10"])
        # Simulate the gap getting backfilled, then a later run whose own
        # predecessor (06-10) is now present.
        daily_after_backfill = daily + [{"date": "2025-06-10"}]
        gap_day2 = hmc.detect_daily_gap(daily_after_backfill, date(2025, 6, 11))
        self.assertEqual(gap_day2, [])


class _PatchedPathsMixin:
    """Redirects every module-level data-file constant hum-metrics-collect
    reads/writes to a scratch temp dir, so main() never touches real state.
    Note: derive_context_flags() (inside collect_for_day) still reads the
    real data/confirmed-stops.json via the module's own DATA constant
    -- that's a read-only lookup unrelated to what these tests assert on, so
    it's left unpatched rather than widening this mixin's scope."""

    CONSTS = ("HUM_RUNS", "HUM_FEEDBACK", "SUGG_HISTORY", "HUM_STATE",
              "TZ_FILE", "METRICS_STATE", "QUAL_QUEUE", "QUAL_COOLDOWN")

    def setUp(self):
        super().setUp()
        self._tmp = tempfile.mkdtemp()
        self._orig = {}
        for i, const in enumerate(self.CONSTS):
            path = os.path.join(self._tmp, f"{const.lower()}.json")
            self._orig[const] = getattr(hmc, const)
            setattr(hmc, const, path)
        self.addCleanup(self._restore)

    def _restore(self):
        for const, orig in self._orig.items():
            setattr(hmc, const, orig)

    def _seed_state(self, daily_rows):
        with open(hmc.METRICS_STATE, "w") as f:
            json.dump({"schema_version": 1, "daily": daily_rows, "decay_events": []}, f)


class MainGapLoggingTest(_PatchedPathsMixin, unittest.TestCase):
    """Confirms main() actually calls detect_daily_gap() and prints a
    message when a gap is found, end to end through the real CLI entry
    point."""

    def _run(self, target_iso):
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", ["hum-metrics-collect", "--date", target_iso]):
            with contextlib.redirect_stderr(buf):
                hmc.main()
        return buf.getvalue()

    def test_gap_message_printed_when_predecessor_missing(self):
        self._seed_state([{"date": "2026-08-13", "lane_yield": {}}])
        printed = self._run("2026-08-15")
        self.assertIn("gap detected", printed)
        self.assertIn("2026-08-14", printed)

    def test_no_gap_message_when_predecessor_present(self):
        self._seed_state([{"date": "2026-08-14", "lane_yield": {}}])
        printed = self._run("2026-08-15")
        self.assertNotIn("gap detected", printed)


class BackfillSkipsDispatchTest(_PatchedPathsMixin, unittest.TestCase):
    """The safety-critical half: --backfill must still write the row (with
    its own decay_events, computed via the same detect_decay() every normal
    run uses) but must never let a decay event reach the live
    qualitative-question queue. QUAL_QUEUE is consumed by
    bin/hum-deliver-qual and eventually reaches the user as a real
    message -- letting a backfill occupy it would misrepresent a stale
    historical day as a live diagnosis question."""

    def _dark_lane_row(self, iso_date):
        return {"date": iso_date,
                "lane_yield": {"testlane": {"candidates": 5, "surfaced": 0}}}

    def _seed_dark_window(self, target):
        # DECAY_DARK_WINDOW_DAYS - 1 prior days, each with candidate volume
        # and zero surfacing for "testlane" -- enough to trip lane_decay_dark
        # once today's own (mocked) row supplies the final day of the window.
        rows = [self._dark_lane_row((target - timedelta(days=n)).isoformat())
                for n in range(1, hmc.DECAY_DARK_WINDOW_DAYS)]
        self._seed_state(rows)

    def test_normal_run_dispatches_qualitative_question(self):
        target = date(2025, 7, 20)
        self._seed_dark_window(target)
        with mock.patch.object(hmc, "collect_for_day",
                                return_value=self._dark_lane_row(target.isoformat())):
            with mock.patch.object(sys, "argv",
                                    ["hum-metrics-collect", "--date", target.isoformat()]):
                hmc.main()
        self.assertTrue(os.path.exists(hmc.QUAL_QUEUE),
                         "normal run should queue a qualitative question for the dark lane")
        with open(hmc.QUAL_QUEUE) as f:
            queued = json.load(f)
        self.assertEqual(queued["trigger_event"]["type"], "lane_decay_dark")

    def test_backfill_run_writes_row_but_skips_dispatch(self):
        target = date(2025, 7, 20)
        self._seed_dark_window(target)
        with mock.patch.object(hmc, "collect_for_day",
                                return_value=self._dark_lane_row(target.isoformat())):
            with mock.patch.object(sys, "argv",
                                    ["hum-metrics-collect", "--date", target.isoformat(),
                                     "--backfill"]):
                hmc.main()
        self.assertFalse(os.path.exists(hmc.QUAL_QUEUE),
                          "--backfill must never occupy the live qualitative-question slot")
        with open(hmc.METRICS_STATE) as f:
            state = json.load(f)
        row = next(r for r in state["daily"] if r["date"] == target.isoformat())
        self.assertTrue(any(e["type"] == "lane_decay_dark" for e in row["decay_events"]),
                         "the row itself must still record its own decay_events")


if __name__ == "__main__":
    unittest.main()
