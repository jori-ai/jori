#!/usr/bin/env python3
"""hum-metrics-collect-pings-delivered.test.py — unit tests for the
`pings_delivered` instrumentation field in bin/hum-metrics-collect
(hum-i-20260628-02).

`surfaced` / `ticks_info` (and the `surface_rate` they feed) come from
hum-runs.jsonl tick *decisions* -- they answer "how often did a tick decide
to ship something", not "how many pushes actually reached the user" once
whatever send-time gate or cap sits between a decision and the real push has
run. `pings_delivered` is a distinct, additive count sourced from
hum-feedback.jsonl -- written by `hum-ping` only on an actual successful
send (jobs/hum-operations.md § Step 2 file shape) -- so it's a genuine
post-delivery count. This suite checks:

  - pings_delivered_for_day(): local-day window filtering, dedup by ping_id,
    fallback to message_id, fallback to counting rows outright when neither
    id is present.
  - collect_for_day(): `pings_delivered` is present and correct alongside
    the existing fields, and adding it changes nothing else in the row
    (surfaced / ticks_info / surface_rate / signal_per_surfaced are
    untouched by this field's presence).
  - The question accounting: `questions` from
    question-route-log.jsonl and `resolve_first` from
    hum-resolve-first-log.jsonl, on local-day boundaries, null (not 0) when a
    log is missing, unreadable or starts after the day.

Run: python3 -m unittest tests/hum-metrics-collect-pings-delivered.test.py -v
"""

import importlib.machinery
import importlib.util
import os
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


class PingsDeliveredForDayTest(unittest.TestCase):
    def setUp(self):
        self.tz = hmc.get_local_tz()
        self.target_date = date(2026, 6, 20)
        self.start, self.end = hmc.et_day_window(self.target_date, self.tz)
        self.in_day = self.start.isoformat()

    def test_counts_rows_sent_inside_window(self):
        feedback = [
            {"ping_id": "hum-1", "sent_at": self.in_day, "message_id": "m1"},
            {"ping_id": "hum-2", "sent_at": self.in_day, "message_id": "m2"},
        ]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 2)

    def test_excludes_rows_outside_window(self):
        other_day = hmc.et_day_window(date(2026, 6, 19), self.tz)[0].isoformat()
        feedback = [
            {"ping_id": "hum-1", "sent_at": self.in_day},
            {"ping_id": "hum-2", "sent_at": other_day},
        ]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 1)

    def test_dedups_by_ping_id(self):
        # Same ping_id logged twice (e.g. a retried write) must not double-count.
        feedback = [
            {"ping_id": "hum-1", "sent_at": self.in_day},
            {"ping_id": "hum-1", "sent_at": self.in_day},
        ]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 1)

    def test_falls_back_to_message_id_when_ping_id_missing(self):
        feedback = [
            {"sent_at": self.in_day, "message_id": "m1"},
            {"sent_at": self.in_day, "message_id": "m1"},
            {"sent_at": self.in_day, "message_id": "m2"},
        ]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 2)

    def test_counts_row_outright_when_no_id_present(self):
        # Neither id present -- degrade to counting the row rather than
        # silently dropping a real delivered ping because it can't be keyed.
        feedback = [
            {"sent_at": self.in_day},
            {"sent_at": self.in_day},
        ]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 2)

    def test_malformed_row_is_skipped_not_fatal(self):
        feedback = ["not-a-dict", {"ping_id": "hum-1", "sent_at": self.in_day}]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 1)

    def test_empty_feedback_is_zero(self):
        self.assertEqual(hmc.pings_delivered_for_day([], self.start, self.end), 0)


class CollectForDayPingsDeliveredTest(unittest.TestCase):
    """collect_for_day() wires pings_delivered in additively -- present and
    correct, without perturbing any pre-existing field."""

    def setUp(self):
        self.tz = hmc.get_local_tz()
        self.target_date = date(2026, 6, 20)
        self.start, self.end = hmc.et_day_window(self.target_date, self.tz)
        self.ts = self.start.isoformat()
        # collect_for_day() calls derive_context_flags(), which now shells out
        # to `home-presence` to resolve the traveling flag -- stub it so this
        # suite stays hermetic (no live Supabase/network dependency) and
        # focused on the pings_delivered fields it actually asserts on.
        # Coverage for derive_context_flags() itself lives in
        # hum-metrics-collect-traveling-flag.test.py.
        patcher = mock.patch.object(
            hmc, "derive_context_flags",
            return_value={"traveling": None, "hum_paused_hours": None,
                          "calendar_density": None})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_pings_delivered_present_and_independent_of_surfaced(self):
        # A day where hum-runs.jsonl shows one surfaced tick but
        # hum-feedback.jsonl shows more delivered pings than surfaced ticks --
        # exactly the discrepancy the action item hypothesizes.
        runs = [
            {"ts": self.ts, "sonnet": {"decision": "info", "based_on_topic": "ideas"},
             "outcome": {"sent": True, "ping_id": "p-1"},
             "harvest": {"candidates": [{"topic": "ideas"}]}},
        ]
        feedback = [
            {"ping_id": "hum-a", "sent_at": self.ts, "lane": "ideas"},
            {"ping_id": "hum-b", "sent_at": self.ts, "lane": "ideas"},
            {"ping_id": "hum-c", "sent_at": self.ts, "lane": "ideas"},
        ]
        row = hmc.collect_for_day(self.target_date, self.tz, runs, feedback, [])
        self.assertEqual(row["pings_delivered"], 3)
        # Existing fields untouched by this field's presence.
        self.assertEqual(row["surfaced"], 1)
        self.assertEqual(row["ticks_info"], 1)
        self.assertAlmostEqual(row["surface_rate"], 1.0)

    def test_pings_delivered_zero_when_no_feedback_rows(self):
        row = hmc.collect_for_day(self.target_date, self.tz, [], [], [])
        self.assertEqual(row["pings_delivered"], 0)

    def test_unrelated_fields_unchanged_from_pre_existing_behavior(self):
        # Same fixture shape as the accountability-suite's discretionary test,
        # to confirm this field's addition didn't perturb signal_per_surfaced
        # / signal_per_surfaced_discretionary computation at all.
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
        self.assertEqual(row["pings_delivered"], 0)



# ─── Question accounting ──────────────────────────────────────────────────
# `questions` (question-route-log.jsonl) and `resolve_first`
# (hum-resolve-first-log.jsonl) on the daily row: counts of structured fields
# on local-day boundaries; an unreadable log or one that starts after the day
# is null (unknown), never 0, and never costs the day's row.

import contextlib
import io
import json
import sys
import tempfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

QTZ = ZoneInfo("America/Chicago")  # any non-UTC zone: the boundary must be local


def _utc(local_iso):
    """A local wall-clock time in QTZ, written the way the logs write ts (UTC, Z)."""
    dt = datetime.fromisoformat(local_iso).replace(tzinfo=QTZ)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _window(d):
    return hmc.et_day_window(d, QTZ)


def _write_jsonl(path, rows, raw_lines=()):
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
        for line in raw_lines:
            f.write(line + "\n")


def _q(ts, intent, channel, urgent=False, lane=None, question=True, **kw):
    r = {"ts": ts, "intent": intent, "lane": lane, "text": "x", "channel": channel,
         "urgent": urgent, "question": question, "reason": "jev"}
    r.update(kw)
    return r


def _rf(ts, kind, verdict, action, lane="ideas", still_question=None, key=None, **kw):
    r = {"ts": ts, "decision_id": "hr-x", "intent": f"hum:{lane}:question", "lane": lane,
         "kind": kind, "dedup_key": key, "verdict": verdict, "action": action,
         "still_question": still_question}
    r.update(kw)
    return r


class QuestionsForDayTest(unittest.TestCase):
    def setUp(self):
        self.day = date(2026, 11, 9)
        self.next_day = date(2026, 11, 10)
        self.rows = [
            # 23:59 local on the 9th is already the 10th in UTC: belongs to the 9th.
            _q(_utc("2026-11-09T23:59:00"), "hum:ideas:question", "questions", lane="ideas"),
            # 00:01 local on the 10th: the 10th.
            _q(_utc("2026-11-10T00:01:00"), "decision:ask", "chat", urgent=True, detected="text"),
            # No intent: the family is the lane.
            _q(_utc("2026-11-09T12:00:00"), None, "chat", lane="music"),
            _q(_utc("2026-11-09T13:00:00"), "p1-email", "questions"),
            # The words check failed: stayed in chat as a non-question.
            _q(_utc("2026-11-09T14:00:00"), "daily-summary", "chat", question=None),
        ]

    def test_counts_on_the_local_day_boundary(self):
        q = hmc.questions_for_day(self.rows, *_window(self.day))
        self.assertEqual(q["total"], 3)
        self.assertEqual(q["by_channel"], {"chat": 1, "questions": 2})
        self.assertEqual(q["urgent"], 0)
        self.assertEqual(q["by_family"], {"hum": 1, "music": 1, "p1-email": 1})
        self.assertEqual(q["hum"], 1)
        self.assertEqual(q["hum_by_lane"], {"ideas": 1})
        self.assertEqual(q["found_by_words"], 0)
        self.assertEqual(q["check_failed"], 1)

        q2 = hmc.questions_for_day(self.rows, *_window(self.next_day))
        self.assertEqual(q2["total"], 1)
        self.assertEqual(q2["by_channel"], {"chat": 1, "questions": 0})
        self.assertEqual(q2["urgent"], 1)
        self.assertEqual(q2["by_family"], {"decision": 1})
        self.assertEqual(q2["hum"], 0)
        self.assertEqual(q2["found_by_words"], 1)

    def test_hum_lane_falls_back_to_the_intent(self):
        rows = [_q(_utc("2026-11-09T10:00:00"), "hum:dream_asks:question", "questions")]
        q = hmc.questions_for_day(rows, *_window(self.day))
        self.assertEqual(q["hum_by_lane"], {"dream_asks": 1})

    def test_unknown_when_rows_none(self):
        self.assertIsNone(hmc.questions_for_day(None, *_window(self.day)))

    def test_unknown_when_log_starts_after_the_day(self):
        rows = [_q(_utc("2026-11-12T10:00:00"), "p1-email", "chat")]
        self.assertIsNone(hmc.questions_for_day(rows, *_window(self.day)))

    def test_zero_when_log_covers_a_quiet_day(self):
        rows = [_q(_utc("2026-11-01T10:00:00"), "p1-email", "chat")]
        q = hmc.questions_for_day(rows, *_window(self.day))
        self.assertEqual(q["total"], 0)
        self.assertEqual(q["by_family"], {})


class ResolveFirstForDayTest(unittest.TestCase):
    def setUp(self):
        self.day = date(2026, 11, 9)
        t = _utc("2026-11-09T09:00:00")
        self.rows = [
            _rf(t, "question", "resolved", "drop", lane="watch", key="k1"),
            _rf(t, "question", "resolved", "drop", lane="watch", key="k1"),
            _rf(t, "question", "resolved", "rewrite", still_question=False, key="k2",
                deep={"ran": True, "settled": True}),
            _rf(t, "question", "partial", "rewrite", still_question=True, key="k3"),
            _rf(t, "question", "unresolved", "rewrite", still_question=True, key="k4",
                deep={"ran": True, "settled": False}),
            _rf(t, "ping", "covered", "rewrite", lane="stocks", still_question=False),
            _rf(t, "ping", "covered", "drop", lane="stocks"),
            _rf(t, "ping", "nothing_to_resolve", "send", lane="nearby", key="k5"),
            _rf(t, "ping", "error", "send", lane="nearby"),
            # Left out: a hand-run dry run, and a row on the next local day.
            _rf(t, "question", "resolved", "drop", dry_run=True),
            _rf(_utc("2026-11-10T00:00:30"), "question", "resolved", "drop"),
        ]

    def test_counts_by_verdict_action_kind_lane(self):
        r = hmc.resolve_first_for_day(self.rows, *_window(self.day))
        self.assertEqual(r["checked"], 9)
        self.assertEqual(r["caught"], 5)
        self.assertEqual(r["narrowed"], 1)
        self.assertEqual(r["by_verdict"], {"resolved": 3, "partial": 1, "unresolved": 1,
                                           "covered": 2, "nothing_to_resolve": 1, "error": 1})
        self.assertEqual(r["by_action"], {"drop": 3, "rewrite": 4, "send": 2})
        self.assertEqual(r["by_kind"]["question"]["checked"], 5)
        self.assertEqual(r["by_kind"]["question"]["caught"], 3)
        self.assertEqual(r["by_kind"]["question"]["narrowed"], 1)
        self.assertEqual(r["by_kind"]["ping"]["checked"], 4)
        self.assertEqual(r["by_kind"]["ping"]["caught"], 2)
        self.assertEqual(r["by_kind"]["ping"]["by_action"], {"drop": 1, "rewrite": 1, "send": 2})
        # Under by_kind, only the verdicts/actions that occurred (no zero-fill).
        self.assertEqual(r["by_kind"]["question"]["by_verdict"],
                         {"resolved": 3, "partial": 1, "unresolved": 1})
        self.assertEqual(r["by_kind"]["question"]["by_action"], {"drop": 2, "rewrite": 3})
        self.assertNotIn("caught_distinct_keys", r["by_kind"]["question"])
        # The two watch drops share one key: caught 2, one distinct key.
        self.assertEqual(r["caught_distinct_keys"], 2)
        self.assertEqual(r["by_lane"]["watch"], {"checked": 2, "caught": 2,
                                                 "caught_distinct_keys": 1, "narrowed": 0,
                                                 "sent_as_written": 0})
        self.assertEqual(r["by_lane"]["ideas"], {"checked": 3, "caught": 1,
                                                 "caught_distinct_keys": 1, "narrowed": 1,
                                                 "sent_as_written": 0})
        # Caught without a dedup_key: counted, no distinct key.
        self.assertEqual(r["by_lane"]["stocks"]["caught"], 2)
        self.assertEqual(r["by_lane"]["stocks"]["caught_distinct_keys"], 0)
        self.assertEqual(r["by_lane"]["nearby"]["sent_as_written"], 2)
        self.assertEqual(r["distinct_keys"], 5)
        self.assertEqual(r["looked_further"], 2)
        self.assertEqual(r["settled_by_looking"], 1)

    def test_caught_definition(self):
        c = hmc.resolve_first_caught
        self.assertTrue(c({"verdict": "resolved", "action": "drop"}))
        self.assertTrue(c({"verdict": "covered", "action": "rewrite", "still_question": False}))
        # Still asked: not caught.
        self.assertFalse(c({"verdict": "resolved", "action": "rewrite", "still_question": True}))
        self.assertFalse(c({"verdict": "partial", "action": "rewrite", "still_question": True}))
        self.assertFalse(c({"verdict": "unresolved", "action": "send"}))
        self.assertFalse(c({"verdict": "error", "action": "send"}))

    def test_unknown_verdict_counted_by_name(self):
        rows = [_rf(_utc("2026-11-09T09:00:00"), "question", "skipped", "send")]
        r = hmc.resolve_first_for_day(rows, *_window(self.day))
        self.assertEqual(r["by_verdict"]["skipped"], 1)
        self.assertEqual(r["caught"], 0)

    def test_unknown_when_rows_none_or_log_starts_later(self):
        self.assertIsNone(hmc.resolve_first_for_day(None, *_window(self.day)))
        later = [_rf(_utc("2026-11-11T09:00:00"), "question", "resolved", "drop")]
        self.assertIsNone(hmc.resolve_first_for_day(later, *_window(self.day)))


class QuestionLogLoaderTest(unittest.TestCase):
    def test_missing_file_is_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(hmc.load_jsonl_or_none(os.path.join(d, "nope.jsonl")))

    def test_unreadable_path_is_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(hmc.load_jsonl_or_none(d))  # a directory

    def test_safe_load_turns_any_error_into_none(self):
        with mock.patch.object(hmc, "load_jsonl_or_none", side_effect=RuntimeError("boom")):
            self.assertIsNone(hmc._safe_load("/whatever.jsonl"))

    def test_malformed_lines_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "log.jsonl")
            _write_jsonl(p, [{"ts": "2026-11-09T15:00:00Z", "a": 1}],
                         raw_lines=["{not json", "[1, 2]", "", "\"str\""])
            self.assertEqual(hmc.load_jsonl_or_none(p), [{"ts": "2026-11-09T15:00:00Z", "a": 1}])


class CollectForDayQuestionsTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(
            hmc, "derive_context_flags",
            return_value={"traveling": None, "hum_paused_hours": None,
                          "calendar_density": None})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.day = date(2026, 11, 9)

    def test_fields_null_when_logs_not_given(self):
        row = hmc.collect_for_day(self.day, QTZ, [], [], [])
        self.assertIsNone(row["questions"])
        self.assertIsNone(row["resolve_first"])
        self.assertEqual(row["pings_delivered"], 0)

    def test_fields_present_and_other_fields_unchanged(self):
        t = _utc("2026-11-09T10:00:00")
        base = hmc.collect_for_day(self.day, QTZ, [], [], [])
        row = hmc.collect_for_day(self.day, QTZ, [], [], [],
                                  question_rows=[_q(t, "hum:ideas:question", "questions", lane="ideas")],
                                  resolve_rows=[_rf(t, "question", "resolved", "drop")])
        self.assertEqual(row["questions"]["total"], 1)
        self.assertEqual(row["resolve_first"]["caught"], 1)
        for k in base:
            if k not in ("questions", "resolve_first"):
                self.assertEqual(row[k], base[k], k)

    def test_a_counter_that_breaks_costs_only_its_field(self):
        # A non-dict row slips past the loader (a direct caller): the field is
        # unknown, the row is still built.
        t = _utc("2026-11-09T10:00:00")
        row = hmc.collect_for_day(self.day, QTZ, [], [], [],
                                  question_rows=["not-a-dict"],
                                  resolve_rows=[_rf(t, "question", "resolved", "drop")])
        self.assertIsNone(row["questions"])
        self.assertEqual(row["resolve_first"]["checked"], 1)


class MainJsonDryRunQuestionsTest(unittest.TestCase):
    """main() --json --dry-run: a missing question-route log leaves `questions`
    null, the resolve-first log is counted (a malformed line skipped), and
    nothing is written."""

    def test_wiring(self):
        with tempfile.TemporaryDirectory() as d:
            rf = os.path.join(d, "hum-resolve-first-log.jsonl")
            _write_jsonl(rf, [_rf(_utc("2026-11-09T10:00:00"), "question", "resolved", "drop"),
                              _rf(_utc("2026-11-09T23:59:00"), "ping", "nothing_to_resolve", "send")],
                         raw_lines=["{broken"])
            state = os.path.join(d, "hum-metrics-state.json")
            patches = [
                mock.patch.object(hmc, "QUESTION_ROUTE_LOG", os.path.join(d, "missing.jsonl")),
                mock.patch.object(hmc, "RESOLVE_FIRST_LOG", rf),
                mock.patch.object(hmc, "HUM_RUNS", os.path.join(d, "runs.jsonl")),
                mock.patch.object(hmc, "HUM_FEEDBACK", os.path.join(d, "fb.jsonl")),
                mock.patch.object(hmc, "SUGG_HISTORY", os.path.join(d, "hist.jsonl")),
                mock.patch.object(hmc, "METRICS_STATE", state),
                mock.patch.object(hmc, "get_local_tz", return_value=QTZ),
                mock.patch.object(hmc, "derive_context_flags",
                                  return_value={"traveling": None, "hum_paused_hours": None,
                                                "calendar_density": None}),
                mock.patch.object(sys, "argv", ["hum-metrics-collect", "--date", "2026-11-09",
                                                "--json", "--dry-run"]),
            ]
            for p in patches:
                p.start()
                self.addCleanup(p.stop)
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                hmc.main()
            row = json.loads(out.getvalue())
            self.assertIsNone(row["questions"])
            self.assertEqual(row["resolve_first"]["checked"], 2)
            self.assertEqual(row["resolve_first"]["caught"], 1)
            self.assertEqual(row["resolve_first"]["by_kind"]["ping"]["by_action"]["send"], 1)
            self.assertFalse(os.path.exists(state))


if __name__ == "__main__":
    unittest.main()
