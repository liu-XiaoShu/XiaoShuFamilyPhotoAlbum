#!/usr/bin/env python3
"""并行拉取离线 XYZ 瓦片（本机有网时用，再 rsync 到树莓派）。"""
from __future__ import annotations

import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".vendor"))
sys.path.insert(0, str(ROOT))

from app.services import offline_map  # noqa: E402

#TEMPLATES = [
#    "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
#    "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
#    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
#]

TEMPLATES = [
    # 最优先，风格最统一
    "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    # 备用
    "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
    # 最后备用（OSM官方限速严）
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
]


WORKERS = 24


def fetch_one(item):
    z, x, y, path = item
    if path.exists() and path.stat().st_size >= 50:
        return "skip"
    last_err = None
    for tmpl in TEMPLATES:
        try:
            raw = offline_map._http_get(tmpl.format(z=z, x=x, y=y), timeout=25)
            if not raw or raw[:1] == b"<" or raw[:5] == b"<!DOC":
                raise ValueError("non-image")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            return "ok"
        except Exception as e:
            last_err = e
            continue
    return f"fail:{last_err}"


def main() -> None:
    force = "--force" in sys.argv
    tiles = offline_map._plan_xyz_coverage_tiles()
    # 优先低缩放，便于先可用
    tiles = sorted(tiles, key=lambda t: (t[0], t[1], t[2]))
    todo = []
    for z, x, y in tiles:
        path = offline_map.XYZ_DIR / str(z) / str(x) / f"{y}.png"
        if force or not path.exists() or path.stat().st_size < 50:
            todo.append((z, x, y, path))
    print(f"plan={len(tiles)} todo={len(todo)} workers={WORKERS}", flush=True)
    if not todo:
        print("nothing to do")
        return

    ok = skip = fail = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(fetch_one, it) for it in todo]
        for i, fut in enumerate(as_completed(futs), 1):
            r = fut.result()
            if r == "ok":
                ok += 1
            elif r == "skip":
                skip += 1
            else:
                fail += 1
            if i % 200 == 0 or i == len(futs):
                elapsed = time.time() - t0
                rate = i / max(elapsed, 0.1)
                print(
                    f"progress {i}/{len(futs)} ok={ok} fail={fail} "
                    f"{rate:.1f} tiles/s elapsed={elapsed:.0f}s",
                    flush=True,
                )
    print(f"done ok={ok} skip={skip} fail={fail}", flush=True)


if __name__ == "__main__":
    main()
