#!/usr/bin/env python3
"""hum-metrics-collect-zero-ticks.test.py — unit tests for hum-i-20260823-03:
the zero-tick-day log line in main(), distinct from detect_daily_gap()
(hum-i-20260816-04, tested in hum-metrics-collect-daily-gap.test.py).

Background: 2026-08-20 had zero hum-runs.jsonl rows for the entire calendar
day. The collector itself ran clean (early morning, "no decay events today;
collect-only complete") and WROTE a daily[] row (ticks:0, surfaced:0) --
so detect_daily_gap() found nothing missing, because nothing was missing.
The failure mode this suite covers is the opposite of the 08-14 gap: not
"no row was written" but "a row was written, and it says nothing ticked all
day", which under the 2026-08-02 event-driven redesign is plausible on a
quiet day but has no precedent across the daily[] history as a FULL day.

This is a distinct, additive log line -- it must not fire on/duplicate the
gap-detection message, and it must not fire on a real ticks>0 day.

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` (or directly as a script) rather than `node --test`.

Run: python3 tests/hum-metrics-collect-zero-ticks.test.py -v
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
from datetime import date
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


class _PatchedPathsMixin:
    """Redirects every module-level data-file constant hum-metrics-collect
    reads/writes to a scratch temp dir, so main() never touches real state."""

    CONSTS = ("HUM_RUNS", "HUM_FEEDBACK", "SUGG_HISTORY", "HUM_STATE",
              "TZ_FILE", "METRICS_STATE", "QUAL_QUEUE", "QUAL_COOLDOWN")

    def setUp(self):
        super().setUp()
        self._tmp = tempfile.mkdtemp()
        self._orig = {}
        for const in self.CONSTS:
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


class ZeroTickLoggingTest(_PatchedPathsMixin, unittest.TestCase):
    """Confirms main() prints a distinct zero-tick message when today's
    collected row has ticks==0, and doesn't print it (or confuses it with
    the gap message) otherwise."""

    def _row(self, iso_date, ticks, paused_hours=None):
        row = {
            "date": iso_date,
            "ticks": ticks,
            "lane_yield": {},
            "context_flags": {"traveling": None, "hum_paused_hours": paused_hours,
                               "calendar_density": None},
        }
        return row

    def _run(self, target_iso, row):
        self._seed_state([])  # no prior history -> gap check is a no-op
        buf = io.StringIO()
        with mock.patch.object(hmc, "collect_for_day", return_value=row):
            with mock.patch.object(sys, "argv",
                                    ["hum-metrics-collect", "--date", target_iso]):
                with contextlib.redirect_stderr(buf):
                    hmc.main()
        return buf.getvalue()

    def test_zero_ticks_prints_distinct_message(self):
        target = date(2026, 8, 20)
        printed = self._run(target.isoformat(),
                             self._row(target.isoformat(), ticks=0))
        self.assertIn("zero ticks", printed)
        self.assertIn("2026-08-20", printed)
        self.assertNotIn("gap detected", printed)

    def test_nonzero_ticks_prints_nothing(self):
        target = date(2026, 8, 21)
        printed = self._run(target.isoformat(),
                             self._row(target.isoformat(), ticks=42))
        self.assertNotIn("zero ticks", printed)

    def test_zero_ticks_explained_by_pause_notes_it_instead_of_warning(self):
        target = date(2026, 8, 22)
        printed = self._run(target.isoformat(),
                             self._row(target.isoformat(), ticks=0,
                                       paused_hours=hmc.DECAY_PAUSE_MIN_HOURS))
        self.assertIn("zero ticks", printed)
        self.assertIn("explained by hum_paused_hours", printed)
        # The unexplained-case hint text must not also appear.
        self.assertNotIn("check the trigger cron", printed)

    def test_zero_ticks_with_partial_pause_still_warns(self):
        # A pause shorter than DECAY_PAUSE_MIN_HOURS doesn't explain a full
        # zero-tick day, so this should fall through to the warning branch,
        # same as no pause at all.
        target = date(2026, 8, 23)
        printed = self._run(target.isoformat(),
                             self._row(target.isoformat(), ticks=0,
                                       paused_hours=hmc.DECAY_PAUSE_MIN_HOURS - 1))
        self.assertIn("zero ticks", printed)
        self.assertIn("check the trigger cron", printed)
        self.assertNotIn("explained by hum_paused_hours", printed)

    def test_missing_ticks_key_treated_as_zero(self):
        # Defensive: .get("ticks", 0) should degrade a row missing the key
        # to zero rather than raising.
        target = date(2026, 8, 24)
        row = self._row(target.isoformat(), ticks=0)
        del row["ticks"]
        printed = self._run(target.isoformat(), row)
        self.assertIn("zero ticks", printed)


if __name__ == "__main__":
    unittest.main()
