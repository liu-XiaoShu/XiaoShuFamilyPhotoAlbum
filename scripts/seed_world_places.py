#!/usr/bin/env python3
"""向 places.sqlite 增补常用海外地点（国家/城市中心点），不重建国内库。

用法：
  python3 scripts/seed_world_places.py
  # 或指定库路径：
  PLACES_DB=/path/to/places.sqlite python3 scripts/seed_world_places.py
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get("PLACES_DB") or (ROOT / "data" / "geo" / "places.sqlite"))

# (name, full_name, level, lat, lng)
# level: country < city，匹配时城市优先
WORLD_PLACES: list[tuple[str, str, str, float, float]] = [
    # 泰国
    ("泰国", "泰国", "country", 15.8700, 100.9925),
    ("Thailand", "泰国", "country", 15.8700, 100.9925),
    ("曼谷", "泰国曼谷", "city", 13.7563, 100.5018),
    ("Bangkok", "泰国曼谷", "city", 13.7563, 100.5018),
    ("清迈", "泰国清迈", "city", 18.7883, 98.9853),
    ("Chiang Mai", "泰国清迈", "city", 18.7883, 98.9853),
    ("普吉", "泰国普吉", "city", 7.8804, 98.3923),
    ("普吉岛", "泰国普吉", "city", 7.8804, 98.3923),
    ("Phuket", "泰国普吉", "city", 7.8804, 98.3923),
    ("芭堤雅", "泰国芭堤雅", "city", 12.9236, 100.8825),
    ("帕塔亚", "泰国芭堤雅", "city", 12.9236, 100.8825),
    ("Pattaya", "泰国芭堤雅", "city", 12.9236, 100.8825),
    ("清莱", "泰国清莱", "city", 19.9105, 99.8406),
    ("甲米", "泰国甲米", "city", 8.0863, 98.9063),
    ("Krabi", "泰国甲米", "city", 8.0863, 98.9063),
    ("苏梅岛", "泰国苏梅岛", "city", 9.5120, 100.0136),
    ("华欣", "泰国华欣", "city", 12.5684, 99.9577),
    ("大城", "泰国大城", "city", 14.3692, 100.5877),
    # 常见出境（后续继续用地点文本也能上图）
    ("日本", "日本", "country", 36.2048, 138.2529),
    ("Japan", "日本", "country", 36.2048, 138.2529),
    ("东京", "日本东京", "city", 35.6762, 139.6503),
    ("Tokyo", "日本东京", "city", 35.6762, 139.6503),
    ("大阪", "日本大阪", "city", 34.6937, 135.5023),
    ("Osaka", "日本大阪", "city", 34.6937, 135.5023),
    ("京都", "日本京都", "city", 35.0116, 135.7681),
    ("Kyoto", "日本京都", "city", 35.0116, 135.7681),
    ("韩国", "韩国", "country", 35.9078, 127.7669),
    ("首尔", "韩国首尔", "city", 37.5665, 126.9780),
    ("Seoul", "韩国首尔", "city", 37.5665, 126.9780),
    ("新加坡", "新加坡", "country", 1.3521, 103.8198),
    ("Singapore", "新加坡", "country", 1.3521, 103.8198),
    ("马来西亚", "马来西亚", "country", 4.2105, 101.9758),
    ("吉隆坡", "马来西亚吉隆坡", "city", 3.1390, 101.6869),
    ("越南", "越南", "country", 14.0583, 108.2772),
    ("河内", "越南河内", "city", 21.0278, 105.8342),
    ("胡志明", "越南胡志明市", "city", 10.8231, 106.6297),
    ("美国", "美国", "country", 37.0902, -95.7129),
    ("USA", "美国", "country", 37.0902, -95.7129),
    ("纽约", "美国纽约", "city", 40.7128, -74.0060),
    ("New York", "美国纽约", "city", 40.7128, -74.0060),
    ("洛杉矶", "美国洛杉矶", "city", 34.0522, -118.2437),
    ("法国", "法国", "country", 46.2276, 2.2137),
    ("巴黎", "法国巴黎", "city", 48.8566, 2.3522),
    ("Paris", "法国巴黎", "city", 48.8566, 2.3522),
    ("意大利", "意大利", "country", 41.8719, 12.5674),
    ("罗马", "意大利罗马", "city", 41.9028, 12.4964),
    ("澳大利亚", "澳大利亚", "country", -25.2744, 133.7751),
    ("悉尼", "澳大利亚悉尼", "city", -33.8688, 151.2093),
    ("墨尔本", "澳大利亚墨尔本", "city", -37.8136, 144.9631),
]


def main() -> None:
    if not OUT.exists():
        raise SystemExit(f"地点库不存在: {OUT}（请先跑 seed_places.py）")
    con = sqlite3.connect(str(OUT))
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS places (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          full_name TEXT,
          level TEXT NOT NULL,
          adcode TEXT,
          parent_adcode TEXT,
          lat REAL NOT NULL,
          lng REAL NOT NULL
        )
        """
    )
    # 仅清理本脚本写入的海外条目（adcode 以 W 开头），可重复执行
    con.execute("DELETE FROM places WHERE adcode LIKE 'W%'")

    rows = []
    for i, (name, full, level, lat, lng) in enumerate(WORLD_PLACES, start=1):
        adcode = f"W{i:04d}"
        rows.append((name, full, level, adcode, None, lat, lng))
    con.executemany(
        """
        INSERT INTO places(name, full_name, level, adcode, parent_adcode, lat, lng)
        VALUES (?,?,?,?,?,?,?)
        """,
        rows,
    )
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM places WHERE adcode LIKE 'W%'").fetchone()[0]
    total = con.execute("SELECT COUNT(*) FROM places").fetchone()[0]
    con.close()
    print(f"已写入海外地点 {n} 条 → {OUT}（库合计 {total}）")


if __name__ == "__main__":
    main()
