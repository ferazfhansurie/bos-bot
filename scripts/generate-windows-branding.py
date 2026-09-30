"""Generate Windows/UI assets from approved build/icon.png; Pillow==12.1.1.

Run: python3 scripts/generate-windows-branding.py
Check: python3 scripts/check-windows-branding.py
Only format/size conversion: macOS, Linux SVGs and mascot assets are untouched.
"""
import hashlib
import io
import shutil
import struct
import runpy
from pathlib import Path

from PIL import Image, __version__
CONTRACT = runpy.run_path(str(Path(__file__).with_name("check-windows-branding.py")))
ROOT, SIZES, SOURCE_SHA256 = (CONTRACT[key] for key in ("ROOT", "SIZES", "SOURCE_SHA256"))


def generate():
    if __version__ != "12.1.1":
        raise RuntimeError("Use Pillow==12.1.1 for reproducible Lanczos/PNG output")
    source_path = ROOT / "build/icon.png"
    if hashlib.sha256(source_path.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("Approved BOS source changed; review required")
    source = Image.open(source_path).convert("RGBA")
    payloads = []
    entries = []
    offset = 6 + len(SIZES) * 16
    for size in SIZES:
        stream = io.BytesIO()
        source.resize((size, size), Image.Resampling.LANCZOS).save(
            stream, format="PNG", optimize=False, compress_level=9)
        png = stream.getvalue()
        entries.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset))
        payloads.append(png)
        offset += len(png)
    (ROOT / "build/icon.ico").write_bytes(
        struct.pack("<HHH", 0, 1, len(SIZES)) + b"".join(entries) + b"".join(payloads))
    for name in ("electron/resources/app-icon.png", "public/app-icon.png"):
        shutil.copyfile(source_path, ROOT / name)
    print("Generated BOS ICO (16/24/32/48/64/128/256) and window/UI PNGs")


if __name__ == "__main__":
    generate()
