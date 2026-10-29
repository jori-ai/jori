#!/usr/bin/env python3
"""places-check.test.py — `places check`'s date/day-of-week arithmetic.

Pure geometry (Rule #0b): given Places API periods[] (day/hour/minute, with
Google's Sunday=0 numbering) and a requested local datetime, does it fall
inside an opening period? Covers the overnight span (a bar open past
midnight) and the week-boundary wrap (Saturday night into Sunday) that a
naive same-day comparison gets wrong, plus the currentOpeningHours vs
regularOpeningHours diff not false-firing on Google's per-occurrence `date`
annotation (confirmed live against Omar Khayyam's real API response,
2026-09-25 — the motivating incident for this CLI mode).

Run: python3 tests/places-check.test.py
"""
import os, sys, unittest
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
mod = type(sys)("places_check_mod")
mod.__file__ = os.path.join(REPO, "bin", "places")
exec(compile(open(os.path.join(REPO, "bin", "places")).read(), "places", "exec"),
     mod.__dict__)


class ParseAt(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(mod.parse_at("2026-09-29T13:00:00"), datetime(2026, 9, 29, 13, 0, 0))

    def test_z_suffix_dropped(self):
        self.assertEqual(mod.parse_at("2026-09-29T13:00:00Z"), datetime(2026, 9, 29, 13, 0, 0))

    def test_offset_with_colon_dropped(self):
        self.assertEqual(mod.parse_at("2026-09-29T13:00:00-04:00"), datetime(2026, 9, 29, 13, 0, 0))

    def test_offset_without_colon_dropped(self):
        self.assertEqual(mod.parse_at("2026-09-29T13:00:00-0400"), datetime(2026, 9, 29, 13, 0, 0))

    def test_no_seconds(self):
        self.assertEqual(mod.parse_at("2026-09-29T13:00"), datetime(2026, 9, 29, 13, 0))

    def test_date_only(self):
        self.assertEqual(mod.parse_at("2026-09-29"), datetime(2026, 9, 29, 0, 0))


class ParseDateTime(unittest.TestCase):
    def test_with_time(self):
        self.assertEqual(mod.parse_date_time("2026-09-29", "13:00"), datetime(2026, 9, 29, 13, 0))

    def test_time_defaults_to_noon(self):
        self.assertEqual(mod.parse_date_time("2026-09-29", None), datetime(2026, 9, 29, 12, 0))


class GoogleWeekday(unittest.TestCase):
    def test_sunday_is_zero(self):
        # 2026-09-27 is a Sunday.
        self.assertEqual(mod.google_weekday(datetime(2026, 9, 27)), 0)

    def test_tuesday_is_two(self):
        # 2026-09-29 is a Tuesday.
        self.assertEqual(mod.google_weekday(datetime(2026, 9, 29)), 2)

    def test_saturday_is_six(self):
        # 2026-10-03 is a Saturday.
        self.assertEqual(mod.google_weekday(datetime(2026, 10, 3)), 6)


class MatchPeriods(unittest.TestCase):
    # Closed Tuesday, open Mon/Wed noon-10pm — the real Omar Khayyam shape.
    WEEKDAY_LUNCH = [
        {"open": {"day": 1, "hour": 12, "minute": 0}, "close": {"day": 1, "hour": 22, "minute": 0}},
        {"open": {"day": 3, "hour": 12, "minute": 0}, "close": {"day": 3, "hour": 22, "minute": 0}},
    ]

    def test_closed_day_not_in_periods(self):
        self.assertFalse(mod.match_periods(self.WEEKDAY_LUNCH, datetime(2026, 9, 29, 13, 0)))  # Tue

    def test_open_within_period(self):
        self.assertTrue(mod.match_periods(self.WEEKDAY_LUNCH, datetime(2026, 9, 28, 13, 0)))  # Mon

    def test_before_opening_is_closed(self):
        self.assertFalse(mod.match_periods(self.WEEKDAY_LUNCH, datetime(2026, 9, 28, 11, 0)))  # Mon 11am

    def test_at_close_boundary_is_closed(self):
        self.assertFalse(mod.match_periods(self.WEEKDAY_LUNCH, datetime(2026, 9, 28, 22, 0)))  # Mon 10pm exactly

    def test_overnight_span_same_night(self):
        # Fri 18:00 -> Sat 02:00
        periods = [{"open": {"day": 5, "hour": 18, "minute": 0}, "close": {"day": 6, "hour": 2, "minute": 0}}]
        self.assertTrue(mod.match_periods(periods, datetime(2026, 10, 2, 23, 0)))  # Fri 11pm

    def test_overnight_span_after_midnight(self):
        periods = [{"open": {"day": 5, "hour": 18, "minute": 0}, "close": {"day": 6, "hour": 2, "minute": 0}}]
        self.assertTrue(mod.match_periods(periods, datetime(2026, 10, 3, 1, 0)))  # Sat 1am, before close

    def test_overnight_span_past_close(self):
        periods = [{"open": {"day": 5, "hour": 18, "minute": 0}, "close": {"day": 6, "hour": 2, "minute": 0}}]
        self.assertFalse(mod.match_periods(periods, datetime(2026, 10, 3, 3, 0)))  # Sat 3am, past close

    def test_week_boundary_wrap_saturday_into_sunday(self):
        # Sat 23:00 -> Sun 02:00 — this is the case a naive same-day compare misses.
        periods = [{"open": {"day": 6, "hour": 23, "minute": 0}, "close": {"day": 0, "hour": 2, "minute": 0}}]
        self.assertTrue(mod.match_periods(periods, datetime(2026, 10, 4, 1, 0)))  # Sun 1am

    def test_open_24_hours_no_close_key(self):
        periods = [{"open": {"day": 0, "hour": 0, "minute": 0}}]
        self.assertTrue(mod.match_periods(periods, datetime(2026, 9, 29, 13, 0)))

    def test_no_periods_is_unknown(self):
        self.assertIsNone(mod.match_periods([], datetime(2026, 9, 29, 13, 0)))
        self.assertIsNone(mod.match_periods(None, datetime(2026, 9, 29, 13, 0)))


class HoursLineForDay(unittest.TestCase):
    WEEKDAY_DESCRIPTIONS = [
        "Monday: 12:00 - 10:00 PM", "Tuesday: Closed", "Wednesday: 12:00 - 10:00 PM",
        "Thursday: 12:00 - 10:00 PM", "Friday: 12:00 - 11:00 PM", "Saturday: 12:00 - 11:00 PM",
        "Sunday: 12:00 - 9:00 PM",
    ]

    def test_tuesday_google_day_2_maps_to_index_1(self):
        self.assertEqual(mod.hours_line_for_day(self.WEEKDAY_DESCRIPTIONS, 2), "Tuesday: Closed")

    def test_sunday_google_day_0_maps_to_index_6(self):
        self.assertEqual(mod.hours_line_for_day(self.WEEKDAY_DESCRIPTIONS, 0), "Sunday: 12:00 - 9:00 PM")

    def test_monday_google_day_1_maps_to_index_0(self):
        self.assertEqual(mod.hours_line_for_day(self.WEEKDAY_DESCRIPTIONS, 1), "Monday: 12:00 - 10:00 PM")

    def test_missing_or_short_list_returns_none(self):
        self.assertIsNone(mod.hours_line_for_day(None, 2))
        self.assertIsNone(mod.hours_line_for_day(["Monday: 9-5"], 2))


class NormalizePeriodsForDiff(unittest.TestCase):
    def test_strips_per_occurrence_date_so_identical_hours_dont_false_positive(self):
        # This is the exact shape Google returns for currentOpeningHours: the
        # same weekly pattern as regularOpeningHours, but every open/close
        # carries a concrete upcoming calendar `date`. A raw == comparison
        # of the two periods lists would report a difference every single
        # time even though the hours pattern is identical.
        regular = [{"open": {"day": 1, "hour": 11, "minute": 0}, "close": {"day": 1, "hour": 23, "minute": 0}}]
        current = [{
            "open": {"day": 1, "hour": 11, "minute": 0, "date": {"year": 2026, "month": 9, "day": 28}},
            "close": {"day": 1, "hour": 23, "minute": 0, "date": {"year": 2026, "month": 9, "day": 28}},
        }]
        self.assertEqual(mod._normalize_periods_for_diff(regular), mod._normalize_periods_for_diff(current))

    def test_an_actual_hours_difference_still_shows(self):
        regular = [{"open": {"day": 1, "hour": 11, "minute": 0}, "close": {"day": 1, "hour": 23, "minute": 0}}]
        current = [{
            "open": {"day": 1, "hour": 11, "minute": 0, "date": {"year": 2026, "month": 9, "day": 28}},
            "close": {"day": 1, "hour": 15, "minute": 0, "date": {"year": 2026, "month": 9, "day": 28}},
        }]
        self.assertNotEqual(mod._normalize_periods_for_diff(regular), mod._normalize_periods_for_diff(current))


if __name__ == "__main__":
    unittest.main(verbosity=2)
