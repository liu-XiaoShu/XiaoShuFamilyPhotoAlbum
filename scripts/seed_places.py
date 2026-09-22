#!/usr/bin/env python3
"""重建全国省/市/区县 GPS 库 → data/geo/places.sqlite

数据来源：阿里云 DataV 行政区划中心点（精确到区县）。
用法：
  PYTHONPATH=.vendor python3 scripts/seed_places.py
"""
from __future__ import annotations

import json
import sqlite3
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "geo" / "places.sqlite"
UA = "XiaoshuPhotoAlbum/0.1 (geo-seed)"

# DataV 台湾无下级；手工补主要城市
TAIWAN_EXTRA = [
    ("台北市", "台湾省台北市", "city", "710100", "710000", 25.0330, 121.5654),
    ("台北", "台湾省台北市", "city", "710100", "710000", 25.0330, 121.5654),
    ("高雄市", "台湾省高雄市", "city", "710200", "710000", 22.6273, 120.3014),
    ("高雄", "台湾省高雄市", "city", "710200", "710000", 22.6273, 120.3014),
    ("台中市", "台湾省台中市", "city", "710300", "710000", 24.1477, 120.6736),
    ("台中", "台湾省台中市", "city", "710300", "710000", 24.1477, 120.6736),
    ("台南市", "台湾省台南市", "city", "710400", "710000", 22.9997, 120.2270),
    ("台南", "台湾省台南市", "city", "710400", "710000", 22.9997, 120.2270),
    ("新北市", "台湾省新北市", "city", "710500", "710000", 25.0169, 121.4628),
    ("新北", "台湾省新北市", "city", "710500", "710000", 25.0169, 121.4628),
]


def get(url: str, retries: int = 3) -> dict:
    last: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.8 * (i + 1))
    assert last is not None
    raise last


def center_of(props: dict) -> tuple[float, float] | None:
    c = props.get("center") or props.get("centroid")
    if not c or len(c) < 2:
        return None
    return float(c[1]), float(c[0])  # lat, lng


def aliases(name: str, level: str) -> set[str]:
    names = {name}
    for suf in (
        "特别行政区",
        "壮族自治区",
        "回族自治区",
        "维吾尔自治区",
        "自治区",
        "省",
        "市",
        "地区",
        "盟",
    ):
        if name.endswith(suf) and len(name) > len(suf) + 1:
            names.add(name[: -len(suf)])
    if level in ("district", "county"):
        for suf in ("自治县", "自治旗", "林区", "特区", "区", "县", "旗", "市"):
            if name.endswith(suf) and len(name) > len(suf) + 1:
                names.add(name[: -len(suf)])
                break
    return names


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.exists():
        OUT.unlink()

    con = sqlite3.connect(str(OUT))
    con.execute(
        """
        CREATE TABLE places (
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
    con.execute("CREATE INDEX idx_places_name ON places(name)")
    con.execute("CREATE INDEX idx_places_level ON places(level)")
    con.execute("CREATE INDEX idx_places_adcode ON places(adcode)")

    rows: list[tuple] = []
    seen: set[tuple] = set()

    def add(name, full, level, adcode, parent, lat, lng):
        key = (name, level, str(adcode))
        if key in seen:
            return
        seen.add(key)
        rows.append((name, full, level, str(adcode), str(parent) if parent else None, lat, lng))
        for a in aliases(name, level):
            if a == name:
                continue
            k = (a, level, f"{adcode}:{a}")
            if k in seen:
                continue
            seen.add(k)
            rows.append((a, full, level, str(adcode), str(parent) if parent else None, lat, lng))

    print("fetch china…", flush=True)
    china = get("https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json")
    provinces = []
    for feat in china["features"]:
        p = feat["properties"]
        c = center_of(p)
        if not c:
            continue
        lat, lng = c
        ad = p["adcode"]
        name = p["name"]
        if not name:
            continue
        add(name, name, "province", ad, 100000, lat, lng)
        provinces.append((ad, name, p.get("childrenNum", 0)))
    print("provinces", len(provinces), flush=True)

    city_jobs = []
    for ad, pname, nchild in provinces:
        if not nchild:
            continue
        url = f"https://geo.datav.aliyun.com/areas_v3/bound/{ad}_full.json"
        try:
            data = get(url)
        except Exception as e:  # noqa: BLE001
            print("skip province", pname, e, flush=True)
            continue
        time.sleep(0.05)
        for feat in data["features"]:
            p = feat["properties"]
            c = center_of(p)
            if not c:
                continue
            lat, lng = c
            level = p.get("level") or "city"
            cad = p["adcode"]
            cname = p["name"]
            full = f"{pname}{cname}"
            add(cname, full, level, cad, ad, lat, lng)
            if level == "city" and p.get("childrenNum", 0) > 0:
                city_jobs.append((cad, pname, cname))
        print("+", pname, "rows", len(rows), flush=True)

    print("city jobs", len(city_jobs), flush=True)
    for i, (cad, pname, cname) in enumerate(city_jobs, 1):
        url = f"https://geo.datav.aliyun.com/areas_v3/bound/{cad}_full.json"
        try:
            data = get(url)
        except Exception as e:  # noqa: BLE001
            print("skip city", cname, e, flush=True)
            continue
        for feat in data["features"]:
            p = feat["properties"]
            c = center_of(p)
            if not c:
                continue
            lat, lng = c
            level = p.get("level") or "district"
            dad = p["adcode"]
            dname = p["name"]
            full = f"{pname}{cname}{dname}"
            add(dname, full, level, dad, cad, lat, lng)
        if i % 20 == 0 or i == len(city_jobs):
            print(f"counties {i}/{len(city_jobs)} rows={len(rows)}", flush=True)
        time.sleep(0.04)

    for row in TAIWAN_EXTRA:
        add(*row)

    con.executemany(
        "INSERT INTO places(name, full_name, level, adcode, parent_adcode, lat, lng) "
        "VALUES (?,?,?,?,?,?,?)",
        rows,
    )
    con.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
    con.execute("INSERT INTO meta VALUES (?,?)", ("source", "geo.datav.aliyun.com"))
    con.execute("INSERT INTO meta VALUES (?,?)", ("version", "2"))
    con.execute(
        "INSERT INTO meta VALUES (?,?)",
        ("built_at", time.strftime("%Y-%m-%d %H:%M:%S")),
    )
    con.execute(
        "INSERT INTO meta VALUES (?,?)",
        ("coverage", "china-province-city-county"),
    )
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM places").fetchone()[0]
    by = con.execute("SELECT level, COUNT(*) FROM places GROUP BY level").fetchall()
    print("DONE", n, by, "bytes", OUT.stat().st_size, flush=True)
    con.close()


if __name__ == "__main__":
    main()
