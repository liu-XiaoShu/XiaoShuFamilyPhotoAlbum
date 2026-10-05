#!/usr/bin/env python3
"""预生成网格缩略图(320)与看图预览(1600)，加速单反大图浏览。"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import config  # noqa: E402
from app.services import library  # noqa: E402
from app.services.naming import is_media, is_video  # noqa: E402

def main() -> None:
    root = config.album_root
    files = [p for p in root.rglob("*") if p.is_file() and is_media(p) and not is_video(p)]
    # skip trash
    files = [p for p in files if ".trash" not in p.parts]
    print(f"warming {len(files)} images under {root}")
    ok = fail = 0
    for i, p in enumerate(files, 1):
        rel = str(p.relative_to(root)).replace("\\", "/")
        try:
            library.ensure_thumb(rel, 320)
            library.ensure_preview(rel, 1600)
            ok += 1
            print(f"[{i}/{len(files)}] ok {rel}")
        except Exception as e:
            fail += 1
            print(f"[{i}/{len(files)}] FAIL {rel}: {e}")
    print(f"done ok={ok} fail={fail}")

if __name__ == "__main__":
    main()
