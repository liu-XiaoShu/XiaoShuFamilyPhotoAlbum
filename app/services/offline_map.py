from __future__ import annotations

"""离线标准地图包（MBTiles/XYZ）与高德在线瓦片代理缓存。"""

import json
import math
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import List, Optional, Tuple

from ..config import ROOT, config

MAP_PACK_DIR = ROOT / "data" / "map_pack"
MBTILES_PATH = MAP_PACK_DIR / "standard.mbtiles"
XYZ_DIR = MAP_PACK_DIR / "xyz"
AMAP_XYZ_DIR = MAP_PACK_DIR / "xyz_amap"
META_PATH = MAP_PACK_DIR / "pack_meta.json"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 XiaoshuAlbum/0.1"
)

# 高德公开路网瓦片（免密钥，国内快；私有局域网相册按需缓存）
AMAP_ROAD = (
    "https://webrd0{s}.is.autonavi.com/appmaptile?"
    "lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}"
)

CHINA_BBOX = (73.0, 18.0, 135.5, 54.5)  # west, south, east, north

_lock = threading.Lock()
_job = {
    "running": False,
    "phase": "",
    "done": 0,
    "total": 0,
    "message": "",
    "error": "",
    "updated_at": 0.0,
}
_db_conn: Optional[sqlite3.Connection] = None
_sub_i = 0


def _job_set(**kwargs) -> None:
    with _lock:
        _job.update(kwargs)
        _job["updated_at"] = time.time()


def job_status() -> dict:
    with _lock:
        return dict(_job)


_pack_status_cache: dict = {"ts": 0.0, "data": None}
_PACK_STATUS_TTL = 60.0
_TILE_COUNTS_PATH = MAP_PACK_DIR / "tile_counts.json"


def _read_tile_counts_file() -> dict:
    if not _TILE_COUNTS_PATH.exists():
        return {}
    try:
        data = json.loads(_TILE_COUNTS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _write_tile_counts_file(data: dict) -> None:
    try:
        MAP_PACK_DIR.mkdir(parents=True, exist_ok=True)
        _TILE_COUNTS_PATH.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass


def _count_pngs(root: Path) -> int:
    if not root.exists():
        return 0
    try:
        return sum(1 for p in root.rglob("*.png") if p.is_file())
    except OSError:
        return 0


def bump_tile_count(kind: str = "amap", delta: int = 1) -> None:
    """写入瓦片后增量更新计数，避免每次 rglob 全盘扫描。"""
    data = _read_tile_counts_file()
    key = "amap_cache_count" if kind == "amap" else "xyz_count"
    data[key] = max(0, int(data.get(key) or 0) + int(delta))
    data["updated_at"] = time.time()
    _write_tile_counts_file(data)
    # 使内存缓存失效
    _pack_status_cache["ts"] = 0.0
    _pack_status_cache["data"] = None


_count_refresh_lock = threading.Lock()
_count_refresh_running = False


def _refresh_tile_counts_bg() -> None:
    """后台全盘统计瓦片数，不阻塞请求。"""
    global _count_refresh_running
    try:
        xyz_count = _count_pngs(XYZ_DIR)
        amap_count = _count_pngs(AMAP_XYZ_DIR)
        _write_tile_counts_file(
            {
                "xyz_count": xyz_count,
                "amap_cache_count": amap_count,
                "updated_at": time.time(),
            }
        )
        # 失效内存缓存，下次 pack_status 读到新计数
        _pack_status_cache["ts"] = 0.0
        _pack_status_cache["data"] = None
    finally:
        with _count_refresh_lock:
            _count_refresh_running = False


def _schedule_tile_count_refresh() -> None:
    global _count_refresh_running
    with _count_refresh_lock:
        if _count_refresh_running:
            return
        _count_refresh_running = True
    threading.Thread(target=_refresh_tile_counts_bg, daemon=True, name="tile-count").start()


def pack_status(*, force: bool = False) -> dict:
    now = time.time()
    if (
        not force
        and _pack_status_cache["data"] is not None
        and now - float(_pack_status_cache["ts"] or 0) < _PACK_STATUS_TTL
    ):
        return dict(_pack_status_cache["data"])

    ready_mb = MBTILES_PATH.exists() and MBTILES_PATH.stat().st_size > 1024
    size = MBTILES_PATH.stat().st_size if ready_mb else 0
    tile_count = 0
    if ready_mb:
        try:
            con = sqlite3.connect(f"file:{MBTILES_PATH}?mode=ro", uri=True)
            tile_count = int(con.execute("SELECT COUNT(*) FROM tiles").fetchone()[0])
            con.close()
        except sqlite3.Error:
            tile_count = 0

    saved = _read_tile_counts_file()
    counts_ready = "xyz_count" in saved and "amap_cache_count" in saved
    if counts_ready and not force:
        xyz_count = int(saved.get("xyz_count") or 0)
        amap_count = int(saved.get("amap_cache_count") or 0)
    else:
        # 请求路径绝不 rglob：先返回 0，后台扫一次写回
        xyz_count = int(saved.get("xyz_count") or 0) if counts_ready else 0
        amap_count = int(saved.get("amap_cache_count") or 0) if counts_ready else 0
        _schedule_tile_count_refresh()

    meta = {}
    if META_PATH.exists():
        try:
            meta = json.loads(META_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            meta = {}
    provider = effective_provider()
    ready = provider == "amap" or (ready_mb and tile_count > 0) or xyz_count > 100
    if provider == "amap":
        max_zoom = 18
        attribution = "© 高德地图"
    else:
        max_zoom = 11
        attribution = "© OpenStreetMap"
    data = {
        "ready": ready,
        "path": str(MBTILES_PATH),
        "xyz_dir": str(XYZ_DIR),
        "tile_count": max(tile_count, xyz_count, amap_count),
        "mbtiles_count": tile_count,
        "xyz_count": xyz_count,
        "amap_cache_count": amap_count,
        "size_bytes": size,
        "meta": meta,
        "job": job_status(),
        "provider_mode": provider,
        "map_provider_pref": config.map_provider,
        "needs_gcj02": provider == "amap",
        "max_zoom": max_zoom,
        "attribution": attribution,
        "counts_pending": not counts_ready,
    }
    _pack_status_cache["ts"] = now
    _pack_status_cache["data"] = dict(data)
    return data


def effective_provider() -> str:
    """实际底图：offline=本地离线包；其余（auto/amap）=高德在线。"""
    pref = str(config.map_provider or "auto").strip().lower()
    if pref == "offline":
        return "offline"
    return "amap"


def invalidate_pack_status_cache() -> None:
    _pack_status_cache["ts"] = 0.0
    _pack_status_cache["data"] = None


def tile_cache_path(z: int, x: int, y: int) -> Optional[Path]:
    """若本地已有缓存瓦片则返回路径（不发起网络请求）。"""
    mode = effective_provider()
    if mode == "amap":
        p = AMAP_XYZ_DIR / str(z) / str(x) / f"{y}.png"
        return p if p.is_file() else None
    p = XYZ_DIR / str(z) / str(x) / f"{y}.png"
    if p.is_file():
        return p
    return None


def resolve_map_tile(z: int, x: int, y: int) -> Optional[bytes]:
    """按当前底图模式取瓦片并写入本地缓存。"""
    if z < 0 or x < 0 or y < 0:
        return None
    n = 1 << z
    if z > 18 or x >= n or y >= n:
        return None

    mode = effective_provider()

    if mode == "amap":
        cache = AMAP_XYZ_DIR / str(z) / str(x) / f"{y}.png"
        if cache.is_file() and cache.stat().st_size >= 50:
            try:
                return cache.read_bytes()
            except OSError:
                pass
        try:
            data = _fetch_amap_png(z, x, y)
            try:
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(data)
                bump_tile_count("amap", 1)
            except OSError:
                pass
            return data
        except Exception:
            # 在线失败时尽量用已有离线包兜底，避免空白
            return read_tile(z, x, y)

    static_path = XYZ_DIR / str(z) / str(x) / f"{y}.png"
    if static_path.is_file() and static_path.stat().st_size >= 50:
        try:
            return static_path.read_bytes()
        except OSError:
            pass

    return read_tile(z, x, y)


def prefetch_around(lat: float, lng: float, zooms: Tuple[int, ...] = (10, 11, 12)) -> int:
    """入库后预取照片周边瓦片到本地文件缓存，减轻地图首次展开卡顿。

    瓦片体积大，仍存文件系统（xyz / xyz_amap）；坐标与大纲走媒资 SQLite。
    """
    try:
        lat_f = float(lat)
        lng_f = float(lng)
    except (TypeError, ValueError):
        return 0
    if abs(lat_f) > 90 or abs(lng_f) > 180:
        return 0

    mode = effective_provider()
    pad = 0.06
    tiles: List[Tuple[int, int, int]] = []
    for z in zooms:
        z = max(2, min(int(z), 14))
        tiles.extend(
            _tiles_for_bbox(
                lng_f - pad,
                lat_f - pad * 0.75,
                lng_f + pad,
                lat_f + pad * 0.75,
                z,
            )
        )
    # 控制单次预取量，避免拖垮树莓派与带宽
    tiles = tiles[:48]
    if not tiles:
        return 0

    done = 0
    if mode == "amap":
        for z, x, y in tiles:
            cache = AMAP_XYZ_DIR / str(z) / str(x) / f"{y}.png"
            if cache.is_file() and cache.stat().st_size >= 50:
                done += 1
                continue
            try:
                data = _fetch_amap_png(z, x, y)
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(data)
                bump_tile_count("amap", 1)
                done += 1
            except Exception:
                continue
            time.sleep(0.03)
        return done

    # 离线模式：优先写 xyz 目录
    for z, x, y in tiles:
        path = XYZ_DIR / str(z) / str(x) / f"{y}.png"
        if path.is_file() and path.stat().st_size >= 50:
            done += 1
            continue
        # 已有 mbtiles 则导出到 xyz
        blob = read_tile(z, x, y)
        if blob and len(blob) >= 50:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(blob)
                bump_tile_count("xyz", 1)
                done += 1
            except OSError:
                pass
            continue
        # 尝试在线拉 OSM（仅补洞）
        for tmpl in (
            "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
            "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        ):
            try:
                data = _http_get(tmpl.format(z=z, x=x, y=y), timeout=20)
                if len(data) < 50:
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                bump_tile_count("xyz", 1)
                done += 1
                break
            except Exception:
                continue
        time.sleep(0.04)
    return done


def _xyz_to_tms_row(z: int, y: int) -> int:
    return (1 << z) - 1 - y


def _next_amap_sub() -> str:
    global _sub_i
    s = str((_sub_i % 4) + 1)
    _sub_i += 1
    return s


def _open_db(write: bool = False) -> sqlite3.Connection:
    global _db_conn
    MAP_PACK_DIR.mkdir(parents=True, exist_ok=True)
    if write:
        if _db_conn is not None:
            try:
                _db_conn.close()
            except sqlite3.Error:
                pass
            _db_conn = None
        con = sqlite3.connect(str(MBTILES_PATH))
        con.execute("PRAGMA journal_mode=WAL")
        return con
    if _db_conn is None:
        if not MBTILES_PATH.exists():
            raise FileNotFoundError("地图包不存在，请先在设置中「更新地图包」")
        _db_conn = sqlite3.connect(f"file:{MBTILES_PATH}?mode=ro", uri=True)
    return _db_conn


def close_db() -> None:
    global _db_conn
    if _db_conn is not None:
        try:
            _db_conn.close()
        except sqlite3.Error:
            pass
        _db_conn = None


def _init_mbtiles(con: sqlite3.Connection) -> None:
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS tiles (
          zoom_level INTEGER,
          tile_column INTEGER,
          tile_row INTEGER,
          tile_data BLOB,
          PRIMARY KEY (zoom_level, tile_column, tile_row)
        );
        CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
        """
    )
    meta = {
        "name": "OpenStreetMap 标准地图",
        "format": "png",
        "type": "baselayer",
        "version": "1",
        "description": "开源标准道路地图离线包",
        "attribution": "© OpenStreetMap contributors",
        "minzoom": "0",
        "maxzoom": "8",
        "bounds": "-180.0,-85.0,180.0,85.0",
        "center": "105.0,35.0,4",
    }
    for k, v in meta.items():
        con.execute(
            "INSERT OR REPLACE INTO metadata(name, value) VALUES (?, ?)",
            (k, v),
        )
    con.commit()


def read_tile(z: int, x: int, y: int) -> Optional[bytes]:
    if not MBTILES_PATH.exists():
        return None
    try:
        con = _open_db(False)
        row = _xyz_to_tms_row(z, y)
        cur = con.execute(
            "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
            (z, x, row),
        )
        r = cur.fetchone()
        return bytes(r[0]) if r and r[0] else None
    except (sqlite3.Error, FileNotFoundError):
        return None


def _tiles_for_bbox(
    west: float, south: float, east: float, north: float, z: int
) -> List[Tuple[int, int, int]]:
    def clamp(v: int, lo: int, hi: int) -> int:
        return max(lo, min(hi, v))

    n = 1 << z

    def lon_to_x(lon: float) -> int:
        return clamp(int(math.floor((lon + 180.0) / 360.0 * n)), 0, n - 1)

    def lat_to_y(lat: float) -> int:
        lat = max(min(lat, 85.05112878), -85.05112878)
        s = math.sin(math.radians(lat))
        y = (1.0 - math.log((1 + s) / (1 - s)) / (2 * math.pi)) / 2.0 * n
        return clamp(int(math.floor(y)), 0, n - 1)

    x0, x1 = lon_to_x(west), lon_to_x(east)
    y0, y1 = lat_to_y(north), lat_to_y(south)
    if x0 > x1:
        x0, x1 = x1, x0
    if y0 > y1:
        y0, y1 = y1, y0
    return [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def _plan_standard_tiles() -> List[Tuple[int, int, int]]:
    """全球概览 + 中国标准矢量常用缩放。"""
    need = set()
    for z in range(0, 6):
        n = 1 << z
        for x in range(n):
            for y in range(n):
                need.add((z, x, y))
    cw, cs, ce, cn = CHINA_BBOX
    for z in range(6, 9):
        for t in _tiles_for_bbox(cw, cs, ce, cn, z):
            need.add(t)
    return sorted(need)


def _http_get(url: str, timeout: int = 30, referer: str = "") -> bytes:
    headers = {"User-Agent": USER_AGENT}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _fetch_amap_png(z: int, x: int, y: int) -> bytes:
    url = AMAP_ROAD.format(s=_next_amap_sub(), z=z, x=x, y=y)
    data = _http_get(url, timeout=20, referer="https://www.amap.com/")
    if not data or data[:1] in (b"<", b"{") or data[:5] == b"<!DOC":
        raise ValueError("高德返回非图片")
    if len(data) < 50:
        raise ValueError("高德瓦片过小")
    return data


def _download_mbtiles_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".mbtiles.part")
    if tmp.exists():
        tmp.unlink()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total:
                    _job_set(
                        done=done,
                        total=total,
                        message=f"下载地图包 {done // 1024 // 1024}/{max(1, total // 1024 // 1024)} MB",
                    )
                else:
                    _job_set(done=done, total=0, message=f"下载地图包 {done // 1024 // 1024} MB…")
    close_db()
    if dest.exists():
        dest.unlink()
    tmp.rename(dest)


def _prepare_mbtiles_db() -> sqlite3.Connection:
    close_db()
    if MBTILES_PATH.exists():
        MBTILES_PATH.unlink()
    for side in (Path(str(MBTILES_PATH) + "-wal"), Path(str(MBTILES_PATH) + "-shm")):
        if side.exists():
            try:
                side.unlink()
            except OSError:
                pass
    con = _open_db(True)
    _init_mbtiles(con)
    return con


def _fetch_osm_into_mbtiles(tiles: List[Tuple[int, int, int]]) -> int:
    """免密钥：OpenStreetMap 开源标准道路图。"""
    templates = [
        # 国内常能访问的 OSM 镜像优先；官网 tile.openstreetmap.org 易被重置
        "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
        "https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    ]
    con = _prepare_mbtiles_db()
    # 覆盖 attribution
    con.execute(
        "INSERT OR REPLACE INTO metadata(name, value) VALUES (?, ?)",
        ("name", "OpenStreetMap 标准地图"),
    )
    con.execute(
        "INSERT OR REPLACE INTO metadata(name, value) VALUES (?, ?)",
        ("attribution", "© OpenStreetMap contributors"),
    )
    con.execute(
        "INSERT OR REPLACE INTO metadata(name, value) VALUES (?, ?)",
        ("description", "开源标准道路地图离线包（免密钥）"),
    )
    con.commit()

    ok = 0
    fail_streak = 0
    total = len(tiles)
    _job_set(total=total, done=0, phase="拉取开源地图", message=f"从 OpenStreetMap 拉取 {total} 张…")

    for i, (z, x, y) in enumerate(tiles, 1):
        data = None
        last_err: Optional[BaseException] = None
        for tmpl in templates:
            try:
                raw = _http_get(tmpl.format(z=z, x=x, y=y), timeout=20)
                if not raw or raw[:1] == b"<" or raw[:5] == b"<!DOC":
                    raise ValueError("非图片响应")
                data = raw
                break
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as e:
                last_err = e
        if data:
            row = _xyz_to_tms_row(z, y)
            con.execute(
                "INSERT OR REPLACE INTO tiles(zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)",
                (z, x, row, sqlite3.Binary(data)),
            )
            ok += 1
            fail_streak = 0
        else:
            fail_streak += 1
            _job_set(message=f"跳过 {z}/{x}/{y}: {last_err}")
            if fail_streak >= 8 and ok == 0:
                con.close()
                close_db()
                raise RuntimeError(
                    f"无法连接开源地图源（{last_err}）。请检查网络后重试。"
                )
        if i % 20 == 0:
            con.commit()
            _job_set(done=i, message=f"已拉取 {i}/{total}（成功 {ok}）")
            time.sleep(0.05)
        elif i % 5 == 0:
            time.sleep(0.02)

    con.commit()
    con.execute("INSERT OR REPLACE INTO metadata(name, value) VALUES (?, ?)", ("minzoom", "0"))
    con.execute("INSERT OR REPLACE INTO metadata(name, value) VALUES (?, ?)", ("maxzoom", "8"))
    con.commit()
    con.close()
    close_db()
    return ok


def _plan_xyz_coverage_tiles() -> List[Tuple[int, int, int]]:
    """离线覆盖：全国到 z10；照片/城市/区县周边补到 z11（区县级可视），不再下探 z12。"""
    need = set()
    # 全球低缩放
    for z in range(0, 6):
        n = 1 << z
        for x in range(n):
            for y in range(n):
                need.add((z, x, y))
    cw, cs, ce, cn = CHINA_BBOX
    for z in range(6, 11):
        need.update(_tiles_for_bbox(cw, cs, ce, cn, z))

    centers: List[Tuple[float, float, str]] = []
    try:
        from .library import list_map_photos

        for p in list_map_photos().get("points") or []:
            centers.append((float(p["lat"]), float(p["lng"]), "photo"))
    except Exception:
        pass
    places_db = ROOT / "data" / "geo" / "places.sqlite"
    if places_db.exists():
        try:
            con = sqlite3.connect(f"file:{places_db}?mode=ro", uri=True)
            rows = con.execute(
                "SELECT lat, lng, level FROM places "
                "WHERE level IN ('district','county','city')"
            ).fetchall()
            con.close()
            for lat, lng, level in rows:
                centers.append((float(lat), float(lng), str(level)))
        except sqlite3.Error:
            pass

    # z11 ≈ 区县级；pad 略放大保证拉近城市仍看得到周边区县，不再做 z12
    for lat, lng, level in centers:
        if level == "photo":
            pad = 0.30
        elif level == "city":
            pad = 0.30
        else:
            pad = 0.12
        need.update(
            _tiles_for_bbox(lng - pad, lat - pad * 0.75, lng + pad, lat + pad * 0.75, 11)
        )
    return sorted(need)


def _fetch_osm_into_xyz(tiles: List[Tuple[int, int, int]], force: bool = False) -> int:
    """写入静态 XYZ 目录（相册地图优先读这里）。"""
    templates = [
        "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    ]
    XYZ_DIR.mkdir(parents=True, exist_ok=True)
    todo: List[Tuple[int, int, int, Path]] = []
    for z, x, y in tiles:
        path = XYZ_DIR / str(z) / str(x) / f"{y}.png"
        if force or not path.exists() or path.stat().st_size < 50:
            todo.append((z, x, y, path))

    total = len(todo)
    _job_set(
        total=total,
        done=0,
        phase="拉取离线瓦片",
        message=f"待下载 {total} 张高清瓦片…",
    )
    if total == 0:
        return 0

    ok = 0
    fail_streak = 0
    for i, (z, x, y, path) in enumerate(todo, 1):
        data = None
        for tmpl in templates:
            try:
                raw = _http_get(tmpl.format(z=z, x=x, y=y), timeout=20)
                if not raw or raw[:1] == b"<" or raw[:5] == b"<!DOC":
                    raise ValueError("非图片响应")
                data = raw
                break
            except (
                urllib.error.URLError,
                urllib.error.HTTPError,
                TimeoutError,
                ValueError,
                OSError,
            ):
                continue
        if data:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            ok += 1
            fail_streak = 0
        else:
            fail_streak += 1
            if fail_streak >= 20 and ok == 0:
                raise RuntimeError("无法从 OpenStreetMap 拉取瓦片，请检查网络后重试。")

        if i % 20 == 0 or i == total:
            _job_set(done=i, message=f"已下载 {i}/{total}（成功 {ok}）")
            time.sleep(0.03)
        elif i % 4 == 0:
            time.sleep(0.01)
    return ok


def update_map_pack(force: bool = True) -> dict:
    """联网更新离线标准地图包。

    优先自定义 URL → 否则补全/刷新本地 XYZ（全国到市级 + 区县周边），
    若 MBTiles 为空再补全球/中国概览包。
    """
    if job_status().get("running"):
        return {"ok": False, "message": "地图包正在更新中"}

    _job_set(running=True, phase="准备", done=0, total=0, message="准备更新地图包…", error="")
    try:
        custom = str(getattr(config, "map_pack_url", "") or "").strip()
        provider = "OpenStreetMap"
        layers = "standard"
        source = "osm-xyz"
        tile_count = 0

        if custom:
            _job_set(phase="下载", message="正在下载离线地图包…")
            _download_mbtiles_file(custom, MBTILES_PATH)
            st = pack_status()
            if not st["ready"]:
                raise RuntimeError("下载的文件不是有效的 MBTiles 地图包")
            source = "url"
            tile_count = st["tile_count"]
            provider = "自定义地址"
        else:
            _job_set(phase="拉取", message="正在补全离线标准地图（市级/县级）…")
            xyz_tiles = _plan_xyz_coverage_tiles()
            tile_count = _fetch_osm_into_xyz(xyz_tiles, force=bool(force))
            # MBTiles 概览兜底（相册无高清时仍可显示）
            st0 = pack_status()
            if st0.get("mbtiles_count", 0) < 50:
                _job_set(phase="概览包", message="正在生成低缩放概览地图包…")
                overview = _fetch_osm_into_mbtiles(_plan_standard_tiles())
                tile_count += overview
            provider = "OpenStreetMap"
            layers = "xyz+mbtiles"

        xyz_n = pack_status().get("xyz_count", 0)
        meta = {
            "version": int(time.time()),
            "style": "standard",
            "format": "xyz+mbtiles",
            "source": source,
            "provider": provider,
            "layers": layers,
            "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "tile_count": xyz_n or tile_count,
            "max_zoom": 11,
            "min_zoom": 2,
            "coverage": "china-z10 + places/photos-z11",
        }
        META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        _job_set(
            running=False,
            phase="完成",
            done=tile_count,
            total=tile_count,
            message=f"{provider} 标准地图包已更新（本批 {tile_count} 张）",
        )
        return {"ok": True, **meta, **pack_status()}
    except Exception as e:
        _job_set(running=False, phase="失败", error=str(e), message="更新失败")
        return {"ok": False, "message": str(e)}


def start_update_async(force: bool = True) -> dict:
    if job_status().get("running"):
        return {"ok": False, "message": "地图包正在更新中", "job": job_status()}

    def _run():
        update_map_pack(force=force)

    threading.Thread(target=_run, name="map-pack-update", daemon=True).start()
    return {
        "ok": True,
        "message": "已开始更新离线标准地图包（OpenStreetMap，需联网）",
        "job": job_status(),
    }


def start_build_async(force: bool = True) -> dict:
    return start_update_async(force=force)


def build_map_pack(force: bool = False) -> dict:
    return update_map_pack(force=force)
