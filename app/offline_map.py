from __future__ import annotations

"""离线标准地图包（MBTiles）：默认从国家天地图矢量底图拉取；浏览只读本地包。"""

import io
import json
import math
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import List, Optional, Tuple

from PIL import Image

from ..config import ROOT, config

MAP_PACK_DIR = ROOT / "data" / "map_pack"
MBTILES_PATH = MAP_PACK_DIR / "standard.mbtiles"
XYZ_DIR = MAP_PACK_DIR / "xyz"
META_PATH = MAP_PACK_DIR / "pack_meta.json"

USER_AGENT = "XiaoshuPhotoAlbum/0.1 (tianditu-offline-pack; local LAN)"

# 仅标准矢量：底图 vec + 注记 cva（不含影像/地形/路况/三维）
TDT_VEC = (
    "https://t{s}.tianditu.gov.cn/vec_w/wmts?"
    "SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default"
    "&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}"
)
TDT_CVA = (
    "https://t{s}.tianditu.gov.cn/cva_w/wmts?"
    "SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default"
    "&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}"
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


def pack_status() -> dict:
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
    xyz_count = 0
    if XYZ_DIR.exists():
        try:
            xyz_count = sum(1 for p in XYZ_DIR.rglob("*.png") if p.is_file())
        except OSError:
            xyz_count = 0
    meta = {}
    if META_PATH.exists():
        try:
            meta = json.loads(META_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            meta = {}
    ready = (ready_mb and tile_count > 0) or xyz_count > 100
    return {
        "ready": ready,
        "path": str(MBTILES_PATH),
        "xyz_dir": str(XYZ_DIR),
        "tile_count": max(tile_count, xyz_count),
        "mbtiles_count": tile_count,
        "xyz_count": xyz_count,
        "size_bytes": size,
        "meta": meta,
        "job": job_status(),
    }


def _xyz_to_tms_row(z: int, y: int) -> int:
    return (1 << z) - 1 - y


def _next_sub() -> str:
    global _sub_i
    s = str(_sub_i % 8)
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
        "name": "国家天地图·标准矢量",
        "format": "png",
        "type": "baselayer",
        "version": "1",
        "description": "天地图矢量底图+注记离线包（不含影像/三维/路况）",
        "attribution": "© 国家地理信息公共服务平台·天地图",
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


def _http_get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


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


def _fetch_tdt_png(template: str, z: int, x: int, y: int, tk: str) -> bytes:
    url = template.format(s=_next_sub(), z=z, x=x, y=y, tk=tk)
    data = _http_get(url, timeout=25)
    if not data or data[:1] in (b"<", b"{") or data[:5] == b"<!DOC":
        raise ValueError("天地图返回非图片（请检查密钥/配额）")
    return data


def _compose_vec_cva(vec_bytes: bytes, cva_bytes: Optional[bytes]) -> bytes:
    """矢量底图 + 矢量注记合成一张标准地图瓦片。"""
    base = Image.open(io.BytesIO(vec_bytes)).convert("RGBA")
    if cva_bytes:
        try:
            anno = Image.open(io.BytesIO(cva_bytes)).convert("RGBA")
            if anno.size != base.size:
                anno = anno.resize(base.size, Image.BILINEAR)
            base = Image.alpha_composite(base, anno)
        except OSError:
            pass
    out = io.BytesIO()
    base.convert("RGB").save(out, format="PNG", optimize=True)
    return out.getvalue()


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


def _fetch_tianditu_into_mbtiles(tk: str, tiles: List[Tuple[int, int, int]]) -> int:
    con = _prepare_mbtiles_db()
    ok = 0
    fail_streak = 0
    total = len(tiles)
    _job_set(
        total=total,
        done=0,
        phase="拉取天地图",
        message=f"从国家天地图拉取标准矢量 {total} 张…",
    )

    for i, (z, x, y) in enumerate(tiles, 1):
        try:
            vec = _fetch_tdt_png(TDT_VEC, z, x, y, tk)
            cva = None
            try:
                cva = _fetch_tdt_png(TDT_CVA, z, x, y, tk)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError):
                cva = None
            data = _compose_vec_cva(vec, cva)
            row = _xyz_to_tms_row(z, y)
            con.execute(
                "INSERT OR REPLACE INTO tiles(zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)",
                (z, x, row, sqlite3.Binary(data)),
            )
            ok += 1
            fail_streak = 0
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as e:
            fail_streak += 1
            _job_set(message=f"跳过 {z}/{x}/{y}: {e}")
            if fail_streak >= 6 and ok == 0:
                con.close()
                close_db()
                raise RuntimeError(
                    f"无法从天地图拉取瓦片（{e}）。请检查网络、密钥是否有效，以及控制台配额。"
                )

        if i % 15 == 0:
            con.commit()
            _job_set(done=i, message=f"已拉取 {i}/{total}（成功 {ok}）")
            time.sleep(0.06)
        elif i % 3 == 0:
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
        tk = str(getattr(config, "tianditu_key", "") or "").strip()
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
                if tk:
                    overview = _fetch_tianditu_into_mbtiles(tk, _plan_standard_tiles())
                    provider = "国家天地图+OSM"
                    source = "tianditu+osm-xyz"
                else:
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
