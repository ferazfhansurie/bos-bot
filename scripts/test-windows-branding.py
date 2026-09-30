"""Isolated regression checks; never reads or launches the installed app."""
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest

from PIL import Image

CONTRACT = runpy.run_path(str(Path(__file__).with_name("check-windows-branding.py")))
ROOT, CHECK = CONTRACT["ROOT"], CONTRACT["check"]


class BrandingTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="bos-branding-test-")
        self.root = Path(self.directory.name)
        for name in ("build/icon.png", "build/icon.ico", "electron/resources/app-icon.png",
                     "public/app-icon.png", "index.html", "src/components/AboutDialog.tsx",
                     "electron/main.mjs", "electron-builder.yml"):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)

    def tearDown(self):
        self.directory.cleanup()

    def test_current_assets(self):
        self.assertEqual(CHECK(self.root), [])

    def test_stale_pngs(self):
        for name in ("electron/resources/app-icon.png", "public/app-icon.png"):
            with self.subTest(name=name):
                Image.new("RGBA", (1024, 1024), "red").save(self.root / name)
                self.assertTrue(any(name in error for error in CHECK(self.root)))

    def test_valid_but_stale_ico(self):
        Image.new("RGBA", (256, 256), "red").save(self.root / "build/icon.ico", format="ICO")
        self.assertTrue(any("build/icon.ico" in error for error in CHECK(self.root)))

    def test_truncated_ico(self):
        target = self.root / "build/icon.ico"
        target.write_bytes(target.read_bytes()[:-10])
        self.assertTrue(any("build/icon.ico" in error for error in CHECK(self.root)))

    def test_stale_ui_references(self):
        for name, label in (("index.html", "favicon"), ("src/components/AboutDialog.tsx", "About")):
            with self.subTest(name=name):
                target = self.root / name
                target.write_text(target.read_text().replace("/app-icon.png", "/app-icon.svg"))
                self.assertTrue(any(label in error for error in CHECK(self.root)))

    def test_wrong_window_reference(self):
        target = self.root / "electron/main.mjs"
        target.write_text(target.read_text().replace("resources/app-icon.png", "resources/old.png"))
        self.assertTrue(any("Electron window" in error for error in CHECK(self.root)))

    def test_wrong_package_reference(self):
        target = self.root / "electron-builder.yml"
        target.write_text(target.read_text().replace("icon: build/icon.ico", "icon: build/old.ico"))
        self.assertTrue(any("packaged Windows" in error for error in CHECK(self.root)))


if __name__ == "__main__":
    unittest.main()
