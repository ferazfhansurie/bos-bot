"""Verify BOS Windows/UI branding. Requires Pillow==12.1.1; no app is launched."""
from pathlib import Path
import io
import hashlib
import struct
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SIZES = (16, 24, 32, 48, 64, 128, 256)
SOURCE_SHA256 = "117f8b32f48c8f2f8a8cf0b5c836bb7df2a12bab7bafc669957565f9c0257654"


def check(root=ROOT):
    source = Image.open(root / "build/icon.png").convert("RGBA")
    failures = []
    if hashlib.sha256((root / "build/icon.png").read_bytes()).hexdigest() != SOURCE_SHA256:
        failures.append("build/icon.png: approved BOS source changed; review required")
    for name in ("electron/resources/app-icon.png", "public/app-icon.png"):
        try:
            actual = Image.open(root / name).convert("RGBA")
            assert actual.size == source.size and actual.tobytes() == source.tobytes()
        except (OSError, AssertionError):
            failures.append(f"{name}: missing or stale source pixels")
    try:
        data = (root / "build/icon.ico").read_bytes()
        assert struct.unpack_from("<HHH", data) == (0, 1, len(SIZES))
        offset = 6 + 16 * len(SIZES)
        for index, size in enumerate(SIZES):
            width, height, colors, reserved, planes, bits, length, start = struct.unpack_from(
                "<BBBBHHII", data, 6 + 16 * index)
            assert (width or 256, height or 256, colors, reserved, planes, bits, start) == (
                size, size, 0, 0, 1, 32, offset)
            png = data[start:start + length]
            assert png.startswith(b"\x89PNG\r\n\x1a\n")
            actual = Image.open(io.BytesIO(png)).convert("RGBA")
            expected = source.resize((size, size), Image.Resampling.LANCZOS)
            assert actual.size == expected.size and actual.tobytes() == expected.tobytes()
            offset += length
        assert offset == len(data)
        # Also exercise Pillow's ICO decoder rather than only the PNG payloads.
        ico = Image.open(io.BytesIO(data))
        assert ico.ico.sizes() == {(size, size) for size in SIZES}
        for size in SIZES:
            assert ico.ico.getimage((size, size)).convert("RGBA").tobytes() == source.resize(
                (size, size), Image.Resampling.LANCZOS).tobytes()
    except (OSError, ValueError, AssertionError, struct.error):
        failures.append("build/icon.ico: invalid sizes/encoding or stale source pixels")
    html = (root / "index.html").read_text()
    about = (root / "src/components/AboutDialog.tsx").read_text()
    main = (root / "electron/main.mjs").read_text()
    config = (root / "electron-builder.yml").read_text()
    for ok, label in (
        ('<link rel="icon" type="image/png" href="/app-icon.png" />' in html
         and "app-icon.svg" not in html, "favicon PNG reference"),
        ('<img src="/app-icon.png"' in about and "app-icon.svg" not in about, "About PNG reference"),
        ('const APP_ICON = path.join(__dirname, "resources/app-icon.png");' in main
         and "icon: APP_ICON" in main, "Electron window PNG reference"),
        ("  icon: build/icon.ico" in config and "  - electron/**" in config, "packaged Windows icon/window resources"),
    ):
        if not ok:
            failures.append(label)
    return failures


if __name__ == "__main__":
    errors = check()
    if errors:
        print("Windows branding check FAILED:\n- " + "\n- ".join(errors))
        sys.exit(1)
    print("Windows branding check passed: source pixels, 7 decoded ICO sizes, window/About/favicon and package references")
