"""location-confirmation-loop — a confirmation review's items, and the Places
locale change. Synthetic names and coordinates.

  - Refusal words ("skip", "unknown", a "Somewhere else" tap) are protocol
    tokens and never become place names (findme resolve, stop-identify).
  - An answer reaches confirmed-stops.json + the drift ledger, not only its row
    (location-confirm save-visit / _record_drift) — one real answer reached
    neither.
  - A late question says it is late; a too-old one is not asked (segment-ask).
  - Google Places is asked in the local language inside a configured locale,
    unchanged elsewhere.

Run: python3 tests/location-confirmation-loop-2026-10-06.test.py
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))
# A stand-in project URL: the modules build REST URLs at load; every call is stubbed.
os.environ.setdefault("SUPABASE_URL", "https://example-project.supabase.co")
import places_nearby  # noqa: E402

# Synthetic coordinates: metres east/north of an obviously fake origin, so the
# fixtures keep the real traces' geometry without pinning a real place.
import math as _fake_math
_FAKE_ORIGIN = (12.3456, -65.4321)
_FAKE_M_PER_DEG = 6371000 * _fake_math.pi / 180


def fake_pt(e, n):
    lat = _FAKE_ORIGIN[0] + n / _FAKE_M_PER_DEG
    return (lat, _FAKE_ORIGIN[1] + e / (_FAKE_M_PER_DEG * _fake_math.cos(_fake_math.radians(lat))))


def fake_at(e, n):
    lat, lon = fake_pt(e, n)
    return {"lat": lat, "lon": lon}


def fake_row(e, n):
    lat, lon = fake_pt(e, n)
    return {"latitude": lat, "longitude": lon}


def fake_kw(e, n):
    return fake_at(e, n)

# `findme` imports pyicloud at module scope and it isn't installed everywhere
# (same stub as daily-summary-nonstop.test.mjs).
if "pyicloud" not in sys.modules:
    import types
    _fake = types.ModuleType("pyicloud")
    _fake.PyiCloudService = object
    sys.modules["pyicloud"] = _fake


def load(script, name):
    mod = type(sys)(name)
    mod.__dict__["__name__"] = name
    mod.__dict__["__file__"] = os.path.join(REPO, "bin", script)
    with open(os.path.join(REPO, "bin", script)) as fh:
        src = fh.read()
    exec(compile(src, script, "exec"), mod.__dict__)
    return mod


class RefusalWordsAreProtocol(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fm = load("findme", "findme_mod")

    def test_tokens_are_recognised_exactly(self):
        p = self.fm._protocol_answer
        self.assertEqual(p("skip"), "withdraw")
        self.assertEqual(p(" unknown "), "declined")
        self.assertEqual(p("__other__"), "not_a_name")
        # A real answer is not a token, whatever it contains.
        self.assertIsNone(p("Skip Bar & Grill"))
        self.assertIsNone(p("Bread And Co"))

    def test_other_tap_is_refused_and_writes_nothing(self):
        writes = []
        self.fm._update_location_row = lambda *a, **k: writes.append(a) or True
        with self.assertRaises(SystemExit) as cm:
            self.fm._apply_protocol_answer("not_a_name", "v1", {"pending": []}, False)
        self.assertEqual(cm.exception.code, 2)
        self.assertEqual(writes, [])

    def test_skip_withdraws_with_no_name(self):
        writes = []
        self.fm._update_location_row = lambda vid, upd: writes.append((vid, upd)) or True
        self.fm._save_pending_enrich = lambda s: None
        with redirect_stdout(io.StringIO()):
            self.fm._apply_protocol_answer("withdraw", "v1", {"pending": [{"visit_id": "v1"}]}, False)
        self.assertEqual(writes, [("v1", {"place_name": None, "place_type": "non-stop"})])

    def test_unknown_marks_declined_and_names_nothing(self):
        writes = []
        self.fm._update_location_row = lambda *a, **k: writes.append(a) or True
        self.fm._save_pending_enrich = lambda s: None
        state = {"pending": [{"visit_id": "v1", "asked": False}]}
        with redirect_stdout(io.StringIO()):
            self.fm._apply_protocol_answer("declined", "v1", state, False)
        self.assertEqual(writes, [])
        self.assertTrue(state["pending"][0]["asked"])
        self.assertIn("declined_at", state["pending"][0])

    def test_stop_identify_no_button_stores_the_token_not_its_label(self):
        src = open(os.path.join(REPO, "bin", "stop-identify")).read()
        self.assertIn('"label": "No, somewhere else", "value": OTHER_VALUE', src)
        self.assertIn('"label": "Somewhere else", "value": OTHER_VALUE', src)
        self.assertIn('"label": "Type it in", "value": OTHER_VALUE', src)

    def test_clinic_ranks_below_an_untyped_venue(self):
        prio = self.fm.PLACE_TYPE_PRIORITY
        self.assertLess(prio["medical_clinic"], prio.get("point_of_interest", 20))
        self.assertLess(prio["clinic"], prio["cafe"])


class AnswersReachTheDurableStores(unittest.TestCase):
    def setUp(self):
        self.lc = load("location-confirm", "location_confirm_mod")
        self.tmp = tempfile.mkdtemp()
        self.lc.NIGHTLY_STATE_FILE = os.path.join(self.tmp, "nightly-review-state.json")
        self.lc.CONFIRMED_FILE = os.path.join(self.tmp, "confirmed-stops.json")
        self.lc.USER_TZ_FILE = os.path.join(self.tmp, "tz.json")
        with open(self.lc.USER_TZ_FILE, "w") as fh:
            json.dump({"timezone": "Asia/Jerusalem"}, fh)

    def _drift(self, **over):
        kw = dict(centroid={**fake_at(0, 0)},
                  stop_start="2026-10-03T07:21:45+00:00",
                  expected_name="Bread And Co", actual_name="The Corner Cafe",
                  signal="chat_correction", source="findme_resolve",
                  promoted=True, visit_id="6aec5c60")
        kw.update(over)
        return self.lc._record_drift(**kw)

    def test_drift_row_lands_in_the_review_ledger(self):
        with open(self.lc.NIGHTLY_STATE_FILE, "w") as fh:
            json.dump({"schema_version": 4, "daily_log_drift": []}, fh)
        self.assertTrue(self._drift())
        row = json.load(open(self.lc.NIGHTLY_STATE_FILE))["daily_log_drift"][0]
        self.assertEqual(row["date"], "2026-10-03")   # local (IDT) date of the stop
        self.assertEqual(row["expected_name"], "Bread And Co")
        self.assertEqual(row["actual_name"], "The Corner Cafe")
        self.assertEqual(row["fix_status"], "auto_resolved")
        self.assertEqual(row["recorded_by"], "location-confirm")

    def test_drift_is_idempotent_and_open_when_not_promoted(self):
        with open(self.lc.NIGHTLY_STATE_FILE, "w") as fh:
            json.dump({"daily_log_drift": []}, fh)
        self.assertTrue(self._drift(promoted=False))
        self.assertFalse(self._drift(promoted=False))
        rows = json.load(open(self.lc.NIGHTLY_STATE_FILE))["daily_log_drift"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["fix_status"], "open")

    def test_never_creates_or_clobbers_a_missing_state_file(self):
        self.assertFalse(self._drift())
        self.assertFalse(os.path.exists(self.lc.NIGHTLY_STATE_FILE))

    def test_save_visit_refuses_protocol_tokens(self):
        args = type("A", (), {"visit_id": "v1", "venue": "skip", "guess": None,
                              "signal": None, "source": None})()
        self.assertEqual(self.lc.cmd_save_visit(args), 2)

    def test_sentence_answers_stay_row_only_without_a_confident_name(self):
        self.lc._fetch_visit = lambda vid: {**fake_row(0, 0),
                                            "arrived_at": "2026-10-03T07:21:45+00:00",
                                            "departed_at": "2026-10-03T07:40:03+00:00"}
        written = []
        self.lc._write_confirmation = lambda *a, **k: written.append(a) or {"ok": True}
        self.lc._place_label = lambda answer, *ctx: None    # Sonnet read "(or Pua)" as unsure
        with open(self.lc.NIGHTLY_STATE_FILE, "w") as fh:
            json.dump({"daily_log_drift": []}, fh)
        sentence = "Breakfast at Bread And Co (or its twin) in the flea market, not The Corner Cafe"
        args = type("A", (), {"visit_id": "6aec5c60", "venue": sentence, "guess": "The Corner Cafe",
                              "signal": "chat_correction", "source": "findme_resolve"})()
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(self.lc.cmd_save_visit(args), 0)
        self.assertEqual(written, [])                       # not promoted
        res = json.loads(out.getvalue())
        self.assertFalse(res["promoted"])
        self.assertTrue(res["drift_recorded"])              # but the correction is kept

    def test_a_place_name_is_promoted(self):
        self.lc._fetch_visit = lambda vid: {**fake_row(0, 0),
                                            "arrived_at": "2026-10-03T07:21:45+00:00",
                                            "departed_at": "2026-10-03T07:40:03+00:00"}
        written = []
        self.lc._write_confirmation = lambda ask, chosen, ask_id, **k: written.append((chosen, ask_id)) or {"ok": True}
        args = type("A", (), {"visit_id": "6aec5c60", "venue": "Bread And Co", "guess": None,
                              "signal": None, "source": None})()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.lc.cmd_save_visit(args), 0)
        self.assertEqual(written[0][0]["name"], "Bread And Co")
        self.assertEqual(written[0][1], "lc-visit-6aec5c60")


def put(path, data):
    with open(path, "w") as fh:
        fh.write(data if isinstance(data, str) else json.dumps(data))


class SentenceAnswersArePromotedUnderTheirName(unittest.TestCase):
    """si-20261013-04: a sentence answer is promoted under the confident name a
    model reads out of it, closing the drift row it left open. Real 2026-10-12 data."""
    FRIENDS = ("Sam and Kim's house, 1 Example Lane. We left our car there and "
              "went on a day trip to the hills in Sam's car.")
    VISIT = "98e78e6a-5bd7-4925-a95c-2115f6ae1bcc"

    def setUp(self):
        self.lc = lc = load("location-confirm", "location_confirm_mod")
        self.tmp = tempfile.mkdtemp()
        lc.NIGHTLY_STATE_FILE, lc.CONFIRMED_FILE, lc.USER_TZ_FILE = (
            os.path.join(self.tmp, f) for f in ("state.json", "confirmed.json", "tz.json"))
        put(lc.USER_TZ_FILE, {"timezone": "Asia/Jerusalem"})
        put(lc.NIGHTLY_STATE_FILE, {"daily_log_drift": [{
            "date": "2026-10-12", "expected_name": self.FRIENDS, "actual_name": "בית לדוגמה",
            "fix_status": "open", "visit_id": self.VISIT, "ref": self.VISIT,
            "recorded_by": "location-confirm"}]})
        lc._fetch_visit = lambda vid: {**fake_row(7374.5, -844.76),
                                       "arrived_at": "2026-10-12T06:02:17+00:00", "departed_at": "2026-10-12T06:18:24+00:00"}
        self.written, self.read = [], []
        lc._write_confirmation = lambda ask, chosen, ask_id, **k: self.written.append((chosen, ask_id)) or chosen
        lc._place_label = lambda *a: self.read.append(a) or "Sam and Kim's house"

    def _save(self, venue):
        args = type("A", (), {"visit_id": self.VISIT, "venue": venue, "guess": "בית לדוגמה",
                              "signal": "chat_correction", "source": "findme_resolve"})()
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(self.lc.cmd_save_visit(args), 0)
        with open(self.lc.NIGHTLY_STATE_FILE) as fh:
            return json.loads(out.getvalue()), json.load(fh)["daily_log_drift"]

    def test_the_grofit_answer_is_promoted_and_its_open_drift_row_closed(self):
        res, drift = self._save(self.FRIENDS)
        self.assertTrue(res["promoted"])
        # The reader is told which stop (his local time) and what Jori had guessed.
        self.assertEqual(self.read, [(self.FRIENDS, "Mon 12 Oct, 09:02–09:18", "בית לדוגמה")])
        self.assertEqual([(c["name"], c.get("answer"), a) for c, a in self.written],   # the name, his words kept
                         [("Sam and Kim's house", self.FRIENDS, "lc-visit-" + self.VISIT)])
        self.assertEqual(len(drift), 1)                     # closed, not duplicated
        self.assertEqual((drift[0]["fix_status"], drift[0]["promoted_name"]),
                         ("auto_resolved", "Sam and Kim's house"))
        self.assertIn("promoted_from_sentence_at", drift[0])    # the roundup can show it was a model's pick

    def test_no_confident_name_writes_nothing_and_leaves_the_row_open(self):
        self.lc._place_label = lambda *a: None              # unsure / other / model down / timeout
        res, drift = self._save(self.FRIENDS)
        self.assertEqual((res["promoted"], self.written, drift[0]["fix_status"]), (False, [], "open"))

    def test_replays_and_short_names_never_reach_the_model(self):
        put(self.lc.CONFIRMED_FILE, [{"ask_id": "lc-visit-" + self.VISIT, "name": "Sam and Kim's house",
                                      "answer": self.FRIENDS}])
        self.assertEqual(self._save(self.FRIENDS)[0]["reason"], "already promoted")
        self._save("Sam and Kim's house")
        self.assertEqual(self.read, [])

    def test_the_row_keeps_his_sentence_in_notes_under_the_short_name(self):
        lc = load("location-confirm", "location_confirm_mod")   # the real write-back
        rows = [{"id": self.VISIT, **fake_row(7374.5, -844.76),
                 "arrived_at": "2026-10-12T06:02:17+00:00", "departed_at": "2026-10-12T06:18:24+00:00",
                 "place_name": self.FRIENDS, "notes": "[resolve-trim] x"}]
        sent = []
        class Resp(io.BytesIO):
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False
        def urlopen(req, timeout=None):
            if req.get_method() == "PATCH":
                sent.append(json.loads(req.data))
            return Resp(json.dumps(rows).encode())
        lc._supabase_key = lambda: "k"
        real, lc.urllib.request.urlopen = lc.urllib.request.urlopen, urlopen
        try:
            ask = {"centroid": {**fake_at(7374.5, -844.76)},
                   "first_sample_ts": rows[0]["arrived_at"], "last_sample_ts": rows[0]["departed_at"]}
            with redirect_stdout(io.StringIO()):
                self.assertTrue(lc._patch_location_history(ask, "Sam and Kim's house", "findme_resolve",
                                                           answer=self.FRIENDS))
        finally:
            lc.urllib.request.urlopen = real
        self.assertEqual(sent, [{"place_name": "Sam and Kim's house", "place_type": "user-confirmed",
                                 "notes": "[resolve-trim] x\n[his answer] " + self.FRIENDS}])

    def test_place_label_takes_only_a_confident_place_from_the_reader(self):
        lc = load("location-confirm", "location_confirm_mod")   # the real _place_label
        lc.LABEL_READER = reader = os.path.join(self.tmp, "reader.mjs")
        def label(stdout):
            put(reader, f"process.stdout.write({json.dumps(stdout)});")
            return lc._place_label(self.FRIENDS)
        self.assertEqual(label('{"answer":"place","place_name":"Sam and Kim\'s house"}'), "Sam and Kim's house")
        for bad in ('{"answer":"unsure","place_name":"Aroma"}', '{"place_name":null}', "not json"):
            self.assertIsNone(label(bad))
        lc.LABEL_READER = os.path.join(self.tmp, "missing.mjs")
        self.assertIsNone(lc._place_label(self.FRIENDS))


class LateQuestionsSayTheyAreLate(unittest.TestCase):
    def test_segment_ask_lead_names_the_daypart_and_time(self):
        sa = load("segment-ask", "segment_ask_mod")
        self.assertEqual(sa.late_lead(datetime(2026, 10, 3, 10, 21)),
                         "Looking back to this morning, around 10:21 — ")
        self.assertEqual(sa.late_lead(datetime(2026, 10, 3, 18, 5)),
                         "Looking back to this evening, around 18:05 — ")
        self.assertEqual(sa.HONEST_AFTER_MIN, 45)
        self.assertEqual(sa.DROP_AFTER_H, 4)


class PlacesInTheLocalLanguage(unittest.TestCase):
    """A Places request inside a configured locale box asks for that language;
    everywhere else it is unchanged. A synthetic box, so no installation's
    config is needed."""
    BOX = ((12.0, -66.0, 13.0, -65.0), {"languageCode": "xx", "regionCode": "XX"})

    def setUp(self):
        self._saved = places_nearby.LOCALES
        places_nearby.LOCALES = [self.BOX]

    def tearDown(self):
        places_nearby.LOCALES = self._saved

    def test_inside_the_box_gets_its_language(self):
        self.assertEqual(places_nearby.places_locale(*fake_pt(0, 0)), {"languageCode": "xx", "regionCode": "XX"})
        self.assertEqual(places_nearby.places_locale(*fake_pt(5000, -8000)), {"languageCode": "xx", "regionCode": "XX"})

    def test_elsewhere_is_unchanged(self):
        self.assertEqual(places_nearby.places_locale(44.4444, -66.6666), {})
        self.assertEqual(places_nearby.places_locale(None, None), {})

    def test_cache_key_outside_a_locale_is_unchanged(self):
        # A cache outside every locale stays warm: no locale, no change to the key.
        k_old = places_nearby._cache_key("findme-nearby", 44.4444, -66.6666, 40, 20)
        k_new = places_nearby._cache_key("findme-nearby", 44.4444, -66.6666, 40, 20, query="")
        self.assertEqual(k_old, k_new)


if __name__ == "__main__":
    unittest.main(verbosity=2)
