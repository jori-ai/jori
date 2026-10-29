#!/usr/bin/env python3
"""hum-metrics-collect-calendar-density.test.py -- unit tests for the
`calendar_density` context flag in derive_context_flags()
(bin/hum-metrics-collect).

Prior behavior (hum-i-20260927-01): derive_context_flags() initialised
calendar_density to None and never assigned it, so every daily row since
launch carried `calendar_density: null` -- the confounder flag that
hum-improvement-ideation reads to tell "hum broke" from "context was
unfavourable" was dead.

Now it is the day's timed, non-free event count from one read-only
`gog calendar list`, bucketed light (<3) / normal (3-6) / dense (>6), and it
stays None on ANY failure to read the calendar (the flag is best-effort and
must never raise or stall the collector).

hum-metrics-collect is Python, not Node, so this suite runs under plain
python3 rather than `node --test`. Nothing here shells out to gog:
fetch_calendar_events is substituted, or subprocess.run is monkeypatched.

Run: python3 tests/hum-metrics-collect-calendar-density.test.py -v
"""

import importlib.machinery
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from datetime import date, datetime, time, timedelta
from unittest import mock
from zoneinfo import ZoneInfo

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(REPO_ROOT, "bin", "hum-metrics-collect")

# hum-metrics-collect has no .py suffix (it's a `#!/usr/bin/env python3` CLI
# entrypoint under bin/), so give spec_from_loader an explicit loader.
_loader = importlib.machinery.SourceFileLoader("hum_metrics_collect", SCRIPT_PATH)
_spec = importlib.util.spec_from_loader("hum_metrics_collect", _loader)
hmc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hmc)  # module-level code only defines funcs/consts

ET = ZoneInfo("America/New_York")  # any DST-observing zone; the DST tests below use its offsets
TARGET = date(2026, 9, 27)


def setUpModule():
    # Synthetic installation settings (the real ones live in agent/local):
    # the calendar account and the prefix that marks someone else's events.
    for name, value in (("GOG_CALENDAR_ACCOUNT", "user@example.com"),
                        ("CALENDAR_IGNORE_PREFIXES", ("[Partner]",))):
        p = mock.patch.object(hmc, name, value)
        p.start()
        _PATCHES.append(p)


def tearDownModule():
    for p in _PATCHES:
        p.stop()


_PATCHES = []


def timed(summary="Meeting", hour=10, day=TARGET, **extra):
    """A timed event starting at `hour`:00 ET on `day` (offset-aware ISO, the
    shape gog returns)."""
    start = datetime.combine(day, time(hour, 0), tzinfo=ET)
    end = start + timedelta(hours=1)
    e = {"summary": summary,
         "start": {"dateTime": start.isoformat()},
         "end": {"dateTime": end.isoformat()}}
    e.update(extra)
    return e


def all_day(summary="Birthday", day=TARGET):
    return {"summary": summary,
            "start": {"date": day.isoformat()},
            "end": {"date": day.isoformat()}}


def fake_run(payload=None, returncode=0, raise_exc=None, raw_stdout=None):
    """subprocess.run stand-in returning `payload` as gog's JSON stdout."""
    def fake(*args, **kwargs):
        if raise_exc:
            raise raise_exc
        result = mock.Mock()
        result.returncode = returncode
        result.stdout = raw_stdout if raw_stdout is not None else json.dumps(payload)
        result.stderr = ""
        return result
    return fake


class BucketBoundariesTest(unittest.TestCase):
    def test_light_below_three(self):
        for n in (0, 1, 2):
            self.assertEqual(hmc.bucket_calendar_density(n), "light", n)

    def test_normal_three_through_six(self):
        for n in (3, 4, 5, 6):
            self.assertEqual(hmc.bucket_calendar_density(n), "normal", n)

    def test_dense_above_six(self):
        for n in (7, 8, 25):
            self.assertEqual(hmc.bucket_calendar_density(n), "dense", n)


class CountEventsTest(unittest.TestCase):
    def count(self, events):
        return hmc.count_calendar_density_events(events, TARGET, ET)

    def test_counts_plain_timed_events(self):
        self.assertEqual(self.count([timed(hour=9), timed(hour=13), timed(hour=17)]), 3)

    def test_transparent_events_are_ignored(self):
        events = [timed(hour=9), timed("Workout", hour=12, transparency="transparent")]
        self.assertEqual(self.count(events), 1)

    def test_opaque_transparency_value_still_counts(self):
        self.assertEqual(self.count([timed(transparency="opaque")]), 1)

    def test_all_day_events_are_ignored(self):
        self.assertEqual(self.count([all_day(), all_day("Trip to Paris"), timed()]), 1)

    def test_configured_prefix_events_are_ignored(self):
        events = [timed("[Partner] Pilates", hour=8), timed("Call with Sam", hour=11)]
        self.assertEqual(self.count(events), 1)

    def test_no_prefix_configured_counts_everything(self):
        events = [timed("[Partner] Pilates", hour=8), timed("Call with Sam", hour=11)]
        with mock.patch.object(hmc, "CALENDAR_IGNORE_PREFIXES", ()):
            self.assertEqual(self.count(events), 2)

    def test_events_starting_outside_the_local_day_are_ignored(self):
        events = [
            timed(hour=10),                                   # in
            timed(hour=23, day=TARGET - timedelta(days=1)),   # started yesterday
            timed(hour=0, day=TARGET + timedelta(days=1)),    # starts tomorrow 00:00
        ]
        self.assertEqual(self.count(events), 1)

    def test_local_midnight_start_counts_for_that_day(self):
        self.assertEqual(self.count([timed(hour=0)]), 1)

    def test_malformed_entries_are_skipped_not_fatal(self):
        events = ["nope", None, 7, {}, {"start": None},
                  {"start": {"dateTime": "garbage"}}, {"start": {}}, timed()]
        self.assertEqual(self.count(events), 1)

    def test_naive_start_is_read_in_the_local_tz(self):
        e = {"summary": "x", "start": {"dateTime": "2026-09-27T10:00:00"}}
        self.assertEqual(self.count([e]), 1)

    def test_none_and_empty_are_zero(self):
        self.assertEqual(self.count(None), 0)
        self.assertEqual(self.count([]), 0)


class FetchCalendarEventsTest(unittest.TestCase):
    def fetch(self, run, target=TARGET):
        with mock.patch.object(hmc.subprocess, "run", run):
            return hmc.fetch_calendar_events(target, ET)

    def test_reads_events_key(self):
        evs = [timed()]
        self.assertEqual(self.fetch(fake_run({"events": evs})), evs)

    def test_reads_items_key(self):
        evs = [timed()]
        self.assertEqual(self.fetch(fake_run({"items": evs})), evs)

    def test_reads_bare_list(self):
        evs = [timed()]
        self.assertEqual(self.fetch(fake_run(evs)), evs)

    def test_empty_events_is_an_empty_list_not_none(self):
        # A successful read of an empty calendar is real data ("light"),
        # distinct from "could not read".
        self.assertEqual(self.fetch(fake_run({"events": []})), [])

    def test_none_when_gog_missing(self):
        self.assertIsNone(self.fetch(fake_run(raise_exc=FileNotFoundError("gog"))))

    def test_none_on_timeout(self):
        exc = subprocess.TimeoutExpired(cmd="gog", timeout=15)
        self.assertIsNone(self.fetch(fake_run(raise_exc=exc)))

    def test_none_on_nonzero_exit_even_with_json_body(self):
        self.assertIsNone(self.fetch(fake_run({"events": [timed()]}, returncode=1)))

    def test_none_on_auth_failure_style_exit(self):
        self.assertIsNone(self.fetch(fake_run(raw_stdout="", returncode=4)))

    def test_none_on_malformed_json(self):
        self.assertIsNone(self.fetch(fake_run(raw_stdout="not json {")))

    def test_none_on_empty_stdout(self):
        self.assertIsNone(self.fetch(fake_run(raw_stdout="")))

    def test_none_when_json_is_not_a_calendar_shape(self):
        # e.g. another CLI's payload (home-presence's {"at_home": ...}) or a
        # bare scalar -- must not be mistaken for an empty calendar.
        self.assertIsNone(self.fetch(fake_run({"at_home": True})))
        self.assertIsNone(self.fetch(fake_run(42)))
        self.assertIsNone(self.fetch(fake_run(None)))
        self.assertIsNone(self.fetch(fake_run({"events": "nope"})))

    def test_none_on_unexpected_exception(self):
        self.assertIsNone(self.fetch(fake_run(raise_exc=RuntimeError("boom"))))

    def test_invocation_is_scoped_to_the_target_day_not_now(self):
        captured = {}

        def fake(args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            result = mock.Mock()
            result.returncode = 0
            result.stdout = json.dumps({"events": []})
            return result

        # 2026-03-01 is standard time (EST, UTC-5): local midnight = 05:00Z.
        with mock.patch.object(hmc.subprocess, "run", fake):
            hmc.fetch_calendar_events(date(2026, 3, 1), ET)
        args = captured["args"]
        self.assertEqual(args[0], hmc.GOG_BIN)
        self.assertEqual(args[1:3], ["calendar", "list"])
        self.assertEqual(args[args.index("--account") + 1], hmc.GOG_CALENDAR_ACCOUNT)
        self.assertEqual(args[args.index("--from") + 1], "2026-03-01T05:00:00Z")
        self.assertEqual(args[args.index("--to") + 1], "2026-03-02T05:00:00Z")
        self.assertIn("--json", args)
        self.assertIn("--no-input", args)

    def test_no_account_flag_without_an_owner_email(self):
        captured = {}

        def fake(args, **kwargs):
            captured["args"] = args
            result = mock.Mock()
            result.returncode = 0
            result.stdout = "[]"
            return result

        with mock.patch.object(hmc, "GOG_CALENDAR_ACCOUNT", ""), \
                mock.patch.object(hmc.subprocess, "run", fake):
            hmc.fetch_calendar_events(TARGET, ET)
        self.assertNotIn("--account", captured["args"])

    def test_window_follows_dst_transition_day(self):
        captured = {}

        def fake(args, **kwargs):
            captured["args"] = args
            result = mock.Mock()
            result.returncode = 0
            result.stdout = "[]"
            return result

        # 2026-03-08: clocks spring forward. Midnight is still EST (05:00Z) but
        # the next local midnight is EDT (04:00Z) -- a 23-hour day.
        with mock.patch.object(hmc.subprocess, "run", fake):
            hmc.fetch_calendar_events(date(2026, 3, 8), ET)
        args = captured["args"]
        self.assertEqual(args[args.index("--from") + 1], "2026-03-08T05:00:00Z")
        self.assertEqual(args[args.index("--to") + 1], "2026-03-09T04:00:00Z")

    def test_subprocess_is_time_bounded_and_never_prompts(self):
        captured = {}

        def fake(args, **kwargs):
            captured["kwargs"] = kwargs
            result = mock.Mock()
            result.returncode = 0
            result.stdout = "[]"
            return result

        with mock.patch.object(hmc.subprocess, "run", fake):
            hmc.fetch_calendar_events(TARGET, ET)
        kw = captured["kwargs"]
        self.assertLessEqual(kw["timeout"], 15)
        self.assertGreater(kw["timeout"], 0)
        self.assertIs(kw["stdin"], subprocess.DEVNULL)


class DeriveCalendarDensityTest(unittest.TestCase):
    def derive(self, events):
        with mock.patch.object(hmc, "fetch_calendar_events", return_value=events):
            return hmc.derive_calendar_density(TARGET, ET)

    def test_zero_events_is_light(self):
        self.assertEqual(self.derive([]), "light")

    def test_two_events_light_three_normal(self):
        self.assertEqual(self.derive([timed(hour=9), timed(hour=10)]), "light")
        self.assertEqual(self.derive([timed(hour=h) for h in (9, 10, 11)]), "normal")

    def test_six_normal_seven_dense(self):
        self.assertEqual(self.derive([timed(hour=h) for h in range(8, 14)]), "normal")
        self.assertEqual(self.derive([timed(hour=h) for h in range(8, 15)]), "dense")

    def test_filtered_events_do_not_push_a_day_over_a_boundary(self):
        # 6 real events + 3 that must not count = still normal, not dense.
        events = [timed(hour=h) for h in range(8, 14)]
        events += [timed("Gym", hour=6, transparency="transparent"),
                   timed("[Partner] Dinner", hour=19),
                   all_day()]
        self.assertEqual(self.derive(events), "normal")

    def test_none_when_calendar_unreadable(self):
        self.assertIsNone(self.derive(None))

    def test_none_when_fetch_raises(self):
        with mock.patch.object(hmc, "fetch_calendar_events",
                               side_effect=RuntimeError("boom")):
            self.assertIsNone(hmc.derive_calendar_density(TARGET, ET))


class DeriveContextFlagsCalendarDensityTest(unittest.TestCase):
    def setUp(self):
        # Keep derive_context_flags hermetic: no reads of the real hum-state /
        # confirmed-stops files.
        self._tmp = tempfile.mkdtemp()
        p1 = mock.patch.object(hmc, "DATA", self._tmp)
        p2 = mock.patch.object(hmc, "HUM_STATE", os.path.join(self._tmp, "hum-state.json"))
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)

    def test_populated_from_the_calendar(self):
        with mock.patch.object(hmc, "fetch_calendar_events",
                               return_value=[timed(hour=h) for h in range(8, 12)]):
            flags = hmc.derive_context_flags(TARGET, ET)
        self.assertEqual(flags["calendar_density"], "normal")

    def test_flag_keys_unchanged(self):
        with mock.patch.object(hmc, "fetch_calendar_events", return_value=[]):
            flags = hmc.derive_context_flags(TARGET, ET)
        self.assertEqual(set(flags), {"traveling", "hum_paused_hours", "calendar_density"})
        self.assertEqual(flags["calendar_density"], "light")

    def test_none_when_calendar_unreadable(self):
        with mock.patch.object(hmc, "fetch_calendar_events", return_value=None):
            flags = hmc.derive_context_flags(TARGET, ET)
        self.assertIsNone(flags["calendar_density"])

    def test_gog_failure_leaves_flag_none_end_to_end(self):
        # No fetch stub: exercise the real fetch path with gog "missing".
        with mock.patch.object(hmc.subprocess, "run",
                               fake_run(raise_exc=FileNotFoundError("gog"))):
            flags = hmc.derive_context_flags(TARGET, ET)
        self.assertIsNone(flags["calendar_density"])

    def test_escaped_exception_never_propagates(self):
        # Belt and braces: even if derive_calendar_density itself blew up, the
        # day's row must still be written.
        with mock.patch.object(hmc, "derive_calendar_density",
                               side_effect=RuntimeError("boom")):
            flags = hmc.derive_context_flags(TARGET, ET)
        self.assertIsNone(flags["calendar_density"])
        self.assertIn("traveling", flags)
        self.assertIn("hum_paused_hours", flags)

    def test_other_flags_are_unaffected_by_the_calendar_lookup(self):
        with open(hmc.HUM_STATE, "w") as f:
            json.dump({"pause": {"until": "2026-09-27T12:00:00-04:00"}}, f)
        with mock.patch.object(hmc, "fetch_calendar_events", return_value=None):
            flags = hmc.derive_context_flags(TARGET, ET)
        self.assertEqual(flags["hum_paused_hours"], 12.0)
        self.assertIsNone(flags["calendar_density"])


if __name__ == "__main__":
    unittest.main()
