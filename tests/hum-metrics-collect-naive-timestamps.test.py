#!/usr/bin/env python3
"""hum-metrics-collect-naive-timestamps.test.py -- regression tests for the
system-channel alert

    "hum-metrics-collect failed (exit 1) — see data/logs/hum-metrics.log"

whose log read

    measure_open_interventions: if not measure_at or now < measure_at:
    TypeError: can't compare offset-naive and offset-aware datetimes

A hum-interventions.jsonl row carried a bare-date measure_at ("YYYY-MM-DD",
no time, no offset). parse_iso returned a NAIVE datetime for it, the
comparison against the aware `now` raised, and the exception escaped the
loop before its single write -- so no intervention was measured that run,
and every daily run after it failed the same way.

Covers:
  * parse_iso always returns an aware datetime (bare date, offset-less
    datetime), read in the local timezone;
  * a bare-date measure_at in the future neither raises nor measures;
  * a bare-date / offset-less measure_at in the past is measured;
  * the silent half of the same defect: a shipped row (real commit sha)
    with applied_at but no measure_at is measured once applied_at + 7 days
    has passed, and a shipped row with no applied_at falls back to the
    commit's committer time (commit_time, monkeypatched -- no git needed);
  * commit_time's own best-effort contract (non-hex, git failure, timeout).

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` rather than `node --test`.

Run: python3 -m unittest tests/hum-metrics-collect-naive-timestamps.test.py -v
"""

import importlib.machinery
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from zoneinfo import ZoneInfo

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(REPO_ROOT, "bin", "hum-metrics-collect")

# hum-metrics-collect has no .py suffix (it's a `#!/usr/bin/env python3` CLI
# entrypoint under bin/), so give spec_from_loader an explicit loader.
_loader = importlib.machinery.SourceFileLoader("hum_metrics_collect", SCRIPT_PATH)
_spec = importlib.util.spec_from_loader("hum_metrics_collect", _loader)
hmc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hmc)  # module-level code only defines funcs/consts; __name__ != "__main__"

LOCAL = ZoneInfo("America/New_York")  # any non-UTC zone


def _daily_row(iso_date, sps):
    return {"date": iso_date, "signal_per_surfaced": sps, "lane_yield": {}}


def _iso_dates(start, n):
    return [(start + timedelta(days=i)).isoformat() for i in range(n)]


class ParseIsoAwareTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(hmc, "get_local_tz", return_value=LOCAL)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_bare_date_is_aware_local_midnight(self):
        dt = hmc.parse_iso("2026-11-08")
        self.assertIsNotNone(dt.tzinfo)
        self.assertEqual(dt, datetime(2026, 11, 8, 0, 0, tzinfo=LOCAL))

    def test_offsetless_datetime_is_aware_in_local_tz(self):
        dt = hmc.parse_iso("2026-10-25T10:15:57")
        self.assertIsNotNone(dt.tzinfo)
        self.assertEqual(dt, datetime(2026, 10, 25, 10, 15, 57, tzinfo=LOCAL))

    def test_explicit_tz_argument_wins_for_offsetless_values(self):
        utc_dt = hmc.parse_iso("2026-10-25T10:00:00", timezone.utc)
        self.assertEqual(utc_dt.utcoffset(), timedelta(0))

    def test_offset_and_z_values_keep_their_own_offset(self):
        self.assertEqual(hmc.parse_iso("2026-10-09T14:17:46.192Z"),
                         datetime(2026, 10, 9, 14, 17, 46, 192000, tzinfo=timezone.utc))
        self.assertEqual(hmc.parse_iso("2026-10-25T10:15:57-04:00").utcoffset(),
                         timedelta(hours=-4))

    def test_result_compares_against_aware_now_without_raising(self):
        now = datetime.now(timezone.utc)
        for s in ("2026-11-08", "2026-10-25T10:15:57", "2026-10-25T10:15:57Z"):
            (now < hmc.parse_iso(s))  # must not raise TypeError

    def test_empty_and_garbage_are_none(self):
        for s in (None, "", "garbage", 7):
            self.assertIsNone(hmc.parse_iso(s))


class MeasureNaiveAndMissingTimestampsTest(unittest.TestCase):
    def setUp(self):
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd)
        self.addCleanup(os.unlink, path)
        self._orig_interventions = hmc.INTERVENTIONS
        hmc.INTERVENTIONS = path
        self.addCleanup(setattr, hmc, "INTERVENTIONS", self._orig_interventions)
        self.interventions_path = path

        patcher = mock.patch.object(hmc, "get_local_tz", return_value=LOCAL)
        patcher.start()
        self.addCleanup(patcher.stop)
        # No test here may reach a real git: a test that needs the commit
        # time patches its own value over this one.
        git_guard = mock.patch.object(hmc, "commit_time", return_value=None)
        self.commit_time = git_guard.start()
        self.addCleanup(git_guard.stop)

        self.applied = datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc)
        applied_date = hmc.date(2026, 5, 20)
        # Strong positive trend so a measured row has an unmistakable verdict.
        self.state = {"daily": (
            [_daily_row(d, 0.1) for d in _iso_dates(applied_date - timedelta(days=7), 7)]
            + [_daily_row(d, 0.9) for d in _iso_dates(applied_date, 7)]
        )}

    def _write(self, *rows):
        with open(self.interventions_path, "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")

    def _run(self):
        hmc.measure_open_interventions({}, self.state)
        with open(self.interventions_path) as f:
            return {r["id"]: r for r in (json.loads(l) for l in f if l.strip())}

    def test_future_bare_date_measure_at_does_not_raise_and_is_not_measured(self):
        future = (datetime.now(timezone.utc) + timedelta(days=12)).date().isoformat()
        self._write({"id": "hum-i-future", "lane": None, "commit": "fc578bc7",
                     "applied_at": self.applied.isoformat(),
                     "measure_at": future, "measurement": None})
        rows = self._run()  # must not raise TypeError
        self.assertIsNone(rows["hum-i-future"].get("measurement"))
        self.assertEqual(rows["hum-i-future"]["measure_at"], future)

    def test_past_bare_date_and_naive_measure_at_are_measured(self):
        self._write(
            {"id": "hum-i-bare", "lane": None, "commit": "7013a1d",
             "applied_at": self.applied.isoformat(),
             "measure_at": "2026-05-27", "measurement": None},
            {"id": "hum-i-naive", "lane": None, "commit": "7013a1e",
             "applied_at": "2026-05-20T08:00:00",
             "measure_at": "2026-05-27T08:00:00", "measurement": None},
        )
        rows = self._run()
        for rid in ("hum-i-bare", "hum-i-naive"):
            m = rows[rid].get("measurement")
            self.assertIsNotNone(m, rid)
            self.assertEqual(m["verdict"], "positive", rid)
            self.assertAlmostEqual(m["before_signal_per_surfaced"], 0.1)
            self.assertAlmostEqual(m["after_signal_per_surfaced"], 0.9)

    def test_one_future_bare_date_row_no_longer_blocks_the_others(self):
        # The incident shape: the bare-date row sat in the ledger ahead of a
        # row that was due, and its exception stopped the due row from ever
        # being written.
        future = (datetime.now(timezone.utc) + timedelta(days=12)).date().isoformat()
        self._write(
            {"id": "hum-i-future", "lane": None, "commit": "fc578bc7",
             "measure_at": future, "measurement": None},
            {"id": "hum-i-due", "lane": None, "commit": "1c5c4af6",
             "applied_at": self.applied.isoformat(),
             "measure_at": (self.applied + timedelta(days=7)).isoformat(),
             "measurement": None},
        )
        rows = self._run()
        self.assertIsNone(rows["hum-i-future"].get("measurement"))
        self.assertEqual(rows["hum-i-due"]["measurement"]["verdict"], "positive")

    def test_applied_at_without_measure_at_measured_after_seven_days(self):
        self._write({"id": "hum-i-nomeasure", "lane": None, "commit": "fa13816a",
                     "applied_at": self.applied.isoformat(),
                     "measure_at": None, "measurement": None})
        row = self._run()["hum-i-nomeasure"]
        self.assertEqual(row["measurement"]["verdict"], "positive")
        # The row's own fields are read, never rewritten.
        self.assertIsNone(row["measure_at"])
        self.assertEqual(row["applied_at"], self.applied.isoformat())

    def test_applied_at_without_measure_at_waits_out_the_window(self):
        recent = datetime.now(timezone.utc) - timedelta(days=2)
        self._write({"id": "hum-i-recent", "lane": None, "commit": "fa13816a",
                     "applied_at": recent.isoformat(),
                     "measure_at": None, "measurement": None})
        self.assertIsNone(self._run()["hum-i-recent"].get("measurement"))

    def test_missing_applied_at_falls_back_to_commit_time(self):
        self.commit_time.return_value = self.applied
        self._write({"id": "hum-i-noapplied", "lane": None, "commit": "c8c294b6",
                     "applied_at": None, "measure_at": None, "measurement": None})
        row = self._run()["hum-i-noapplied"]
        self.commit_time.assert_called_with("c8c294b6")
        self.assertEqual(row["measurement"]["verdict"], "positive")
        self.assertEqual(row["measurement"]["after_window"]["start"], "2026-05-20")
        self.assertIsNone(row["applied_at"])

    def test_missing_applied_at_and_unknown_commit_is_skipped(self):
        self.commit_time.return_value = None
        self._write({"id": "hum-i-unknown", "lane": None, "commit": "c8c294b6",
                     "measure_at": "2026-05-27", "measurement": None})
        self.assertIsNone(self._run()["hum-i-unknown"].get("measurement"))

    def test_unshipped_rows_never_reach_the_commit_lookup(self):
        self._write({"id": "hum-i-pending", "lane": None, "commit": "pending",
                     "measurement": None},
                    {"id": "hum-i-null", "lane": None, "commit": None,
                     "measurement": None})
        rows = self._run()
        self.commit_time.assert_not_called()
        self.assertIsNone(rows["hum-i-pending"].get("measurement"))
        self.assertIsNone(rows["hum-i-null"].get("measurement"))


class CommitTimeTest(unittest.TestCase):
    def _ran(self, stdout="", returncode=0):
        return subprocess.CompletedProcess(args=[], returncode=returncode,
                                           stdout=stdout, stderr="")

    def test_reads_committer_time_as_aware_datetime(self):
        with mock.patch.object(hmc.subprocess, "run",
                               return_value=self._ran("2026-10-25T10:15:57-04:00\n")) as run:
            dt = hmc.commit_time("fc578bc7")
        self.assertEqual(dt, datetime(2026, 10, 25, 14, 15, 57, tzinfo=timezone.utc))
        argv = run.call_args.args[0]
        self.assertEqual(argv[-1], "fc578bc7")
        self.assertIn(hmc.REPO_ROOT, argv)

    def test_git_failure_and_timeout_are_none(self):
        with mock.patch.object(hmc.subprocess, "run",
                               return_value=self._ran("", returncode=128)):
            self.assertIsNone(hmc.commit_time("deadbeef"))
        with mock.patch.object(hmc.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired("git", 5)):
            self.assertIsNone(hmc.commit_time("deadbeef"))
        with mock.patch.object(hmc.subprocess, "run", side_effect=FileNotFoundError()):
            self.assertIsNone(hmc.commit_time("deadbeef"))

    def test_non_hex_values_never_reach_git(self):
        with mock.patch.object(hmc.subprocess, "run") as run:
            for v in (None, "", "pending", "--help", "abc", "g" * 8, "a" * 41, 1234567):
                self.assertIsNone(hmc.commit_time(v), v)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
