#!/usr/bin/env python3
"""photos-derivative-fallback.test.py — a photo whose original is not on the
Mac still gets a thumbnail, from the preview Photos keeps of it.

A bakery photo received in Messages (osxphotos `syndicated`, `ismissing`,
path null) was assigned to its stop but never shown
in the email. `osxphotos export` wrote no file, so `_build_resized_jpeg` raised
"export produced no image file", `photos embed-uuids` dropped it on stderr, and
the library's own preview JPEG under
scopes/syndication/resources/derivatives/masters/2/ was never tried.

Run: python3 tests/photos-derivative-fallback.test.py
"""
import base64, os, sys, tempfile, types, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
# A stub Supabase, so loading the CLI never needs (or reaches) a real one.
os.environ["SUPABASE_URL"] = "http://127.0.0.1:9"
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "test-key"
PHOTOS = os.path.join(REPO, "bin", "photos")
mod = type(sys)("photos_bin")
mod.__dict__["__name__"] = "photos_bin"
mod.__dict__["__file__"] = PHOTOS
exec(compile(open(PHOTOS).read(), "photos", "exec"), mod.__dict__)

UUID = "2AAAAAAA-0000-4000-8000-000000000001"
# A valid 1x1 JPEG, so the real sips resize step runs on it.
JPEG_1PX = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////"
    "wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=")


def _done(rc=0, stderr=""):
    return types.SimpleNamespace(returncode=rc, stdout="", stderr=stderr)


class DerivativeFallback(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="photos-deriv-")
        self.lib = os.path.join(self.tmp, "Photos Library.photoslibrary")
        os.makedirs(self.lib)
        self.thumbs = os.path.join(self.tmp, "thumbs")
        os.environ["PHOTOS_LIBRARY"] = self.lib
        mod.THUMB_DIR = self.thumbs
        self.export_rc = 0
        mod._osxphotos_export = lambda uuid: _done(self.export_rc, "no original")
        mod._osxphotos_export_preview = lambda uuid: _done(self.export_rc, "no preview")

    def tearDown(self):
        os.environ.pop("PHOTOS_LIBRARY", None)

    def put(self, rel, data=JPEG_1PX):
        path = os.path.join(self.lib, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def test_messages_photo_uses_the_syndication_preview(self):
        self.put(f"scopes/syndication/resources/derivatives/masters/2/{UUID}_4_5005_c.jpeg")
        out = mod._build_resized_jpeg(UUID)
        self.assertTrue(os.path.exists(out))
        self.assertTrue(out.endswith(f"{UUID}_w900.jpg"))

    def test_failed_export_still_falls_back(self):
        self.export_rc = 1
        self.put(f"resources/derivatives/masters/2/{UUID}_4_5005_c.jpeg")
        self.assertTrue(os.path.exists(mod._build_resized_jpeg(UUID)))

    def test_largest_preview_wins_and_non_images_are_ignored(self):
        small = self.put(f"resources/derivatives/2/{UUID}_1_105_c.jpeg")
        big = self.put(f"scopes/syndication/resources/derivatives/masters/2/{UUID}_4_5005_c.jpeg",
                       JPEG_1PX + b"\0" * 4000)
        self.put(f"resources/derivatives/2/{UUID}_3_poster.mov", b"\0" * 9000)
        self.assertEqual(mod._library_derivative(UUID), big)
        self.assertNotEqual(mod._library_derivative(UUID), small)

    def test_other_assets_previews_are_not_borrowed(self):
        self.put("resources/derivatives/masters/2/2CC96CEE-0000-0000-0000-000000000000_4_5005_c.jpeg")
        self.assertIsNone(mod._library_derivative(UUID))

    def test_nothing_anywhere_still_raises(self):
        with self.assertRaisesRegex(RuntimeError, "export produced no image file"):
            mod._build_resized_jpeg(UUID)
        self.export_rc = 1
        with self.assertRaisesRegex(RuntimeError, "export failed"):
            mod._build_resized_jpeg(UUID)

    def test_no_library_means_no_fallback(self):
        os.environ["PHOTOS_LIBRARY"] = os.path.join(self.tmp, "missing.photoslibrary")
        self.assertIsNone(mod._library_derivative(UUID))


if __name__ == "__main__":
    unittest.main()
