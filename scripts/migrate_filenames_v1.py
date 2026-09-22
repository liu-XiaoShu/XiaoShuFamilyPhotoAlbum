#!/usr/bin/env python3
"""将相册内媒资重命名为：YYYY-MM-DD-HHMMSS-简述-md5.ext，并刷新索引与缩略图。"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / ".vendor"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))
sys.path.insert(0, str(ROOT))

from app.services import library, media_index  # noqa: E402
from app.services.naming import NEW_NAME, is_media  # noqa: E402
from app.config import config  # noqa: E402


def main() -> None:
    root = config.album_root.resolve()
    print(f"相册根: {root}")
    media_files: list[Path] = []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        parts = p.relative_to(root).parts
        if not parts or parts[0] in {".trash", "_staging"}:
            continue
        if ".narration." in p.name or p.name.endswith(".xiaoshu.json"):
            continue
        if p.name.endswith(".live.mov") or ".cover." in p.name:
            continue
        if is_media(p):
            media_files.append(p)

    print(f"待处理媒资: {len(media_files)}")
    ok = skip = fail = 0
    for src in media_files:
        rel = str(src.relative_to(root)).replace("\\", "/")
        stem = src.stem
        already = bool(NEW_NAME.match(stem))
        try:
            # rearrange 会按元数据时间+简述+内容 MD5 生成新名，并搬迁旁路
            r = library.rearrange(rel)
            new_path = r.get("path") or rel
            if already and new_path == rel and not r.get("renamed"):
                skip += 1
                print(f"  = {rel}")
            else:
                ok += 1
                print(f"  ✓ {rel} → {new_path}")
        except Exception as e:
            fail += 1
            print(f"  ✗ {rel}: {e}")

    print("重建媒资索引…")
    media_index.init_media_tables()
    result = media_index.rebuild_index()
    print(result)

    thumb_dir = ROOT / "data" / "thumbs"
    if thumb_dir.is_dir():
        n = sum(1 for _ in thumb_dir.glob("*.jpg"))
        shutil.rmtree(thumb_dir)
        thumb_dir.mkdir(parents=True, exist_ok=True)
        print(f"已清空缩略图缓存 {n} 个，下次浏览会重建")

    print(f"完成: 更新 {ok}, 已合规跳过 {skip}, 失败 {fail}")


if __name__ == "__main__":
    main()
