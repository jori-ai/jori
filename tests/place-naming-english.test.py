#!/usr/bin/env python3
"""Map guesses come out in English, never as a bare number (2026-10-20). Nominatim bodies have the
shape of live responses (ARCH trimmed to a German-only node); the model is faked.
Run: python3 tests/place-naming-english.test.py"""
import io, json, os, sys, tempfile, unittest
from unittest import mock

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "lib"))
import osm_places, overpass_client, place_naming  # noqa: E402  (this tree's, before location-segment's path)
seg = type(sys)("locseg")
seg.__dict__["__file__"] = os.path.join(REPO, "bin", "location-segment")
exec(compile(open(os.path.join(REPO, "bin", "location-segment")).read(), "location-segment", "exec"),
     seg.__dict__)

DE = "Archäologischer Park „Durch die Zeiten“"  # a German `name` tag in an old city
MODEL = {DE: ("Archaeological Park 'Through the Ages'", True), "3350": ("3350", False)}
R3976 = {"name": "3976", "addresstype": "road", "namedetails": {"ref": "3976"}, "address": {"road": "3976"}}
I95 = {"name": "I 95", "addresstype": "road", "namedetails": {"ref": "I 95"}, "address": {"road": "I 95"}}
R3350 = {"name": "", "addresstype": "tourism", "address": {"road": "3350", "suburb": "Old Port", "city": "Example City"}}
ARCH = {"name": DE, "addresstype": "tourism", "namedetails": {"name": DE},
        "address": {"tourism": DE, "road": "Suq Ed-Dabbagha", "suburb": "Old City", "city": "Example City"}}
TAGS = [{"type": "way", "id": 1, "center": {"lat": 10.0, "lon": 20.0},
         "tags": {"name": "הכותל המערבי", "name:en": "Western Wall", "amenity": "place_of_worship"}},
        {"type": "node", "id": 2, "lat": 10.0, "lon": 20.0,
         "tags": {"name": "אצטדיון טדי", "int_name": "Teddy Stadium", "amenity": "cafe"}}]


class EnglishNames(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.calls, self.urls, self.reply = [], [], None
        self.p = [mock.patch.object(place_naming, "PLACE_NAME_EN_CACHE", os.path.join(d, "en.json"), create=True),
                  mock.patch.object(place_naming, "MODELS_ENV",  # this tree's, wherever HOME points
                                    os.path.join(REPO, "agent", "config", "models.env"), create=True),
                  mock.patch.object(place_naming, "_claude_toolless", self.fake, create=True),
                  mock.patch.object(place_naming, "_en_run", {"calls": 0, "down": None}, create=True),
                  mock.patch.object(osm_places, "CACHE_DIR", d),
                  mock.patch.dict(os.environ, {"JORI_PLACE_NAMES_MODEL": "1"})]
        for p in self.p: p.start()
        os.environ.pop("JORI_PHOTO_TEXT_NO_CLAUDE", None)
        seg.PLACES_CACHE_DIR = d

    def tearDown(self):
        for p in self.p: p.stop()

    def fake(self, model, prompt, timeout_s):
        self.calls.append((model, timeout_s))
        if self.reply is not None:
            return self.reply.pop(0)
        ask = json.loads(prompt.split("Input:\n", 1)[1])["labels"]
        return json.dumps({"items": [dict(zip(("id", "en", "is_name"), (x["id"], *MODEL.get(x["label"], (x["label"], True)))))
                                     for x in ask]})

    def nominatim(self, body):
        def urlopen(req, timeout):
            self.urls.append(req.full_url)
            return io.BytesIO(json.dumps(body).encode())
        with mock.patch("urllib.request.urlopen", side_effect=urlopen):
            return seg.reverse_geocode_nominatim(31.8, 35.1)

    def test_osm_english_tag_wins_and_the_original_is_kept(self):
        with mock.patch.object(osm_places, "_query", return_value={"elements": TAGS}):
            got = {p["osm_id"]: p for p in osm_places.nearby(31.77, 35.23)}
        self.assertEqual((got["way/1"]["name"], got["way/1"].get("name_native")), ("Western Wall", "הכותל המערבי"))
        self.assertEqual(got["node/2"]["name"], "Teddy Stadium")
        with mock.patch.object(overpass_client, "post", return_value={"elements": TAGS}):
            pois = {p["place_id"]: p["name"] for p in seg.osm_overpass_pois(31.77, 35.23, 100)}
        self.assertEqual(pois["osm:way/1"], "Western Wall")

    def test_a_road_number_is_never_the_name(self):
        self.assertEqual(self.nominatim(R3976)[0], "Route 3976")             # structure: only a `ref` tag
        self.assertIn("accept-language=en", self.urls[0])
        self.assertEqual(self.nominatim(I95)[0], "I 95")                     # a lettered ref is not "Route I 95"
        self.assertEqual(self.nominatim(R3350)[0], "Old Port, Example City")    # the model: "3350" is no name

    def test_a_label_with_no_english_tag_is_translated_by_the_model(self):
        got = self.nominatim(ARCH)
        self.assertEqual(got[0], "Archaeological Park 'Through the Ages' (Old City)")
        self.assertEqual(got[3], DE)
        stop = seg.PlaceCandidate(name=DE, address=None, source="osm_overpass", confidence=0.9)
        seg._in_english([stop])
        self.assertEqual((stop.name, stop.name_native), ("Archaeological Park 'Through the Ages'", DE))
        self.assertTrue(all(t <= 8 for _, t in self.calls))               # one call never holds a caller long

    def test_latency_bound_callers_read_remembered_answers_only(self):
        place_naming.english_names([DE])                                  # the background refresh asks once
        del os.environ["JORI_PLACE_NAMES_MODEL"]                       # location-confirm, resolve-point, MCP
        self.assertEqual(place_naming.english_names([DE, "קפה דוגמה"]), {DE: {"en": MODEL[DE][0], "is_name": True}})
        self.assertEqual(len(self.calls), 1)

    def test_ladder_climbs_caches_caps_and_stops_after_a_failure(self):
        self.reply = ["not json", json.dumps({"items": [{"id": "l0", "en": "Cafe Example", "is_name": True}]})]
        self.assertEqual(place_naming.english_names(["קפה דוגמה"])["קפה דוגמה"]["en"], "Cafe Example")
        place_naming.english_names(["קפה דוגמה"])
        self.assertEqual(len(self.calls), 2)       # Sonnet failed the schema, Opus answered, then remembered
        self.reply = None
        for n in range(8):
            place_naming.english_names([f"label {n}"])
        self.assertEqual(len(self.calls), 6)       # EN_CALLS_PER_RUN fresh calls a run, then remembered only
        place_naming._en_run.update(calls=0)
        self.reply = []                            # the next fork fails (pop from empty)
        self.assertEqual(place_naming.english_names(["מאפיית דוגמה"]), {})
        self.assertEqual(place_naming.english_names(["מאפיית דוגמה"]), {})
        self.assertEqual(len(self.calls), 7)       # no second tier after a failure, nor a second fork this run


if __name__ == "__main__":
    unittest.main()
