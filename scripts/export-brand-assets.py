"""Run after `npm run tauri -- icon src/assets/brand/icon-manifest.json`.
Requires Pillow for build-time PNG resizing; no runtime dependency.
"""
from pathlib import Path
from shutil import copyfile
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
source = ROOT / "src-tauri/icons/icon.png"
for target in ("logo.png", "src/assets/logo.png"):
    copyfile(source, ROOT / target)
with Image.open(source) as image:
    for target, size in (
        ("public/favicon.png", 32),
        ("extension/icon16.png", 16),
        ("extension/icon48.png", 48),
        ("extension/icon128.png", 128),
    ):
        image.resize((size, size), Image.Resampling.LANCZOS).save(ROOT / target)
