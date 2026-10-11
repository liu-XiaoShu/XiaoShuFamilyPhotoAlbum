from __future__ import annotations

"""地点文本 → 经纬度。

数据来自 data/geo/places.sqlite（省/市/区县中心点），
匹配时优先更细级别、更长名称（县级优先于市级、省级）。
"""

import sqlite3
import threading
from pathlib import Path
from typing import List, Optional, Tuple

from ..config import ROOT

DB_PATH = ROOT / "data" / "geo" / "places.sqlite"

# level 权重：越大越优先
_LEVEL_WEIGHT = {
    "district": 40,
    "county": 40,
    "city": 20,
    "province": 10,
}

_lock = threading.Lock()
_cache: Optional[List[Tuple[str, str, str, float, float, int]]] = None
# (name, full_name, level, lat, lng, weight)


def _load_places() -> List[Tuple[str, str, str, float, float, int]]:
    global _cache
    with _lock:
        if _cache is not None:
            return _cache
        rows: List[Tuple[str, str, str, float, float, int]] = []
        if DB_PATH.exists():
            con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
            try:
                cur = con.execute(
                    "SELECT name, COALESCE(full_name,''), level, lat, lng FROM places "
                    "WHERE name IS NOT NULL AND name != ''"
                )
                for name, full_name, level, lat, lng in cur:
                    w = _LEVEL_WEIGHT.get(str(level), 15)
                    rows.append(
                        (str(name), str(full_name), str(level), float(lat), float(lng), w)
                    )
            finally:
                con.close()
        rows.sort(key=lambda r: len(r[0]), reverse=True)
        _cache = rows
        return _cache


def reload_places() -> int:
    """热加载地点库（增补 sqlite 后可调用）。"""
    global _cache
    with _lock:
        _cache = None
    return len(_load_places())


def resolve_location(text: str | None) -> tuple[float, float] | None:
    hit = resolve_location_detail(text)
    if not hit:
        return None
    return hit["lat"], hit["lng"]


_LEVEL_LABEL = {
    "district": "区县",
    "county": "区县",
    "city": "市级",
    "province": "省级",
}


def resolve_location_detail(text: str | None) -> dict | None:
    """解析地点文本，返回匹配详情（含级别），供地图定位与 UI 提示。"""
    if not text:
        return None
    s = str(text).strip()
    if not s:
        return None

    places = _load_places()
    if not places:
        return None

    s_norm = (
        s.replace(" ", "")
        .replace("　", "")
        .replace("-", "")
        .replace("—", "")
        .replace("/", "")
        .replace("·", "")
    )

    best = None
    # score: (level_weight, name_len, context_bonus)
    best_score = (-1, -1, -1)

    for name, full_name, level, lat, lng, weight in places:
        if name not in s_norm and name not in s:
            continue
        ctx = 0
        if full_name and (full_name in s_norm or full_name in s):
            ctx = 2
        else:
            if full_name:
                for part_len in (2, 3, 4):
                    for i in range(0, max(0, len(full_name) - part_len)):
                        part = full_name[i : i + part_len]
                        if part in ("地区", "自治区"):
                            continue
                        if part in s_norm and part != name:
                            ctx = max(ctx, 1)
                            break
        score = (weight, len(name), ctx)
        if score > best_score:
            best_score = score
            best = {
                "name": name,
                "full_name": full_name or name,
                "level": level,
                "level_label": _LEVEL_LABEL.get(level, level),
                "lat": lat,
                "lng": lng,
            }

    return best


def places_stats() -> dict:
    places = _load_places()
    by_level: dict[str, int] = {}
    for _n, _f, level, *_rest in places:
        by_level[level] = by_level.get(level, 0) + 1
    return {
        "db": str(DB_PATH),
        "ready": DB_PATH.exists(),
        "count": len(places),
        "by_level": by_level,
    }
