"""媒资索引：SQLite 缓存时间线/地图元数据，避免每次扫盘读 EXIF。"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from ..config import ROOT, config
from . import auth
from .geo import resolve_location
from .metadata import read_meta
from .naming import is_media, is_video

# 与鉴权共用一库，减少文件数
DB_PATH = auth.DB_PATH
TRASH_DIRNAME = ".trash"

_rebuild_lock = threading.Lock()
_rebuild_state = {"running": False, "last_ok": None, "last_error": None, "count": 0}


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH), timeout=60)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init_media_tables() -> None:
    with connect() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS media (
              path TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              kind TEXT NOT NULL,
              year TEXT,
              month TEXT,
              datetime TEXT,
              title TEXT,
              description TEXT,
              location TEXT,
              lat REAL,
              lng REAL,
              has_audio INTEGER NOT NULL DEFAULT 0,
              mtime REAL,
              size INTEGER,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_media_ym ON media(year, month);
            CREATE INDEX IF NOT EXISTS idx_media_dt ON media(datetime);
            CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);
            CREATE TABLE IF NOT EXISTS meta_kv (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            """
        )


def _set_kv(con: sqlite3.Connection, key: str, value: str) -> None:
    con.execute(
        "INSERT INTO meta_kv(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def _get_kv(con: sqlite3.Connection, key: str) -> str | None:
    row = con.execute("SELECT value FROM meta_kv WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def index_count() -> int:
    init_media_tables()
    with connect() as con:
        row = con.execute("SELECT COUNT(*) AS n FROM media").fetchone()
        return int(row["n"] if row else 0)


def status() -> dict:
    init_media_tables()
    return {
        "count": index_count(),
        "rebuilding": _rebuild_state["running"],
        "last_ok": _rebuild_state["last_ok"],
        "last_error": _rebuild_state["last_error"],
    }


def _row_from_file(path: Path, rel: str) -> dict[str, Any] | None:
    if not path.is_file() or not is_media(path):
        return None
    if ".narration." in path.name:
        return None
    parts = Path(rel).parts
    if not parts or not parts[0].isdigit() or len(parts[0]) != 4:
        return None
    if parts[0] in {
        "app",
        "data",
        "inbox",
        "_staging",
        "__pycache__",
        ".git",
        "node_modules",
        TRASH_DIRNAME,
    }:
        return None
    try:
        meta = read_meta(path)
        st = path.stat()
    except OSError:
        return None
    year = parts[0]
    month = parts[1] if len(parts) > 1 else f"{year}-01"
    has_audio = 0
    try:
        from .library import narration_file

        if narration_file(path):
            has_audio = 1
    except Exception:
        pass
    return {
        "path": rel.replace("\\", "/"),
        "name": path.name,
        "kind": "video" if is_video(path) else "image",
        "year": year,
        "month": month,
        "datetime": meta.datetime,
        "title": meta.title,
        "description": meta.description,
        "location": meta.location,
        "lat": meta.lat,
        "lng": meta.lng,
        "has_audio": has_audio,
        "mtime": st.st_mtime,
        "size": st.st_size,
        "updated_at": _iso(),
    }


def upsert_media(album_rel: str) -> None:
    rel = str(album_rel).replace("\\", "/").lstrip("/")
    from .library import album_path

    try:
        full = album_path(rel)
    except ValueError:
        return
    row = _row_from_file(full, rel)
    with connect() as con:
        if not row:
            con.execute("DELETE FROM media WHERE path = ?", (rel,))
            return
        con.execute(
            """
            INSERT INTO media(
              path, name, kind, year, month, datetime, title, description,
              location, lat, lng, has_audio, mtime, size, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(path) DO UPDATE SET
              name=excluded.name, kind=excluded.kind, year=excluded.year,
              month=excluded.month, datetime=excluded.datetime, title=excluded.title,
              description=excluded.description, location=excluded.location,
              lat=excluded.lat, lng=excluded.lng, has_audio=excluded.has_audio,
              mtime=excluded.mtime, size=excluded.size, updated_at=excluded.updated_at
            """,
            (
                row["path"],
                row["name"],
                row["kind"],
                row["year"],
                row["month"],
                row["datetime"],
                row["title"],
                row["description"],
                row["location"],
                row["lat"],
                row["lng"],
                row["has_audio"],
                row["mtime"],
                row["size"],
                row["updated_at"],
            ),
        )


def delete_media(album_rel: str) -> None:
    rel = str(album_rel).replace("\\", "/").lstrip("/")
    with connect() as con:
        con.execute("DELETE FROM media WHERE path = ?", (rel,))


def move_media(old_rel: str, new_rel: str) -> None:
    delete_media(old_rel)
    upsert_media(new_rel)


def rebuild_index(*, force: bool = False) -> dict:
    if not _rebuild_lock.acquire(blocking=False):
        return {"ok": False, "message": "索引重建进行中", **status()}
    _rebuild_state["running"] = True
    _rebuild_state["last_error"] = None
    try:
        init_media_tables()
        root = config.album_root
        rows: list[dict] = []
        if root.exists():
            for p in root.rglob("*"):
                if not p.is_file():
                    continue
                try:
                    rel = str(p.relative_to(root)).replace("\\", "/")
                except ValueError:
                    continue
                row = _row_from_file(p, rel)
                if row:
                    rows.append(row)
        with connect() as con:
            con.execute("DELETE FROM media")
            con.executemany(
                """
                INSERT INTO media(
                  path, name, kind, year, month, datetime, title, description,
                  location, lat, lng, has_audio, mtime, size, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                [
                    (
                        r["path"],
                        r["name"],
                        r["kind"],
                        r["year"],
                        r["month"],
                        r["datetime"],
                        r["title"],
                        r["description"],
                        r["location"],
                        r["lat"],
                        r["lng"],
                        r["has_audio"],
                        r["mtime"],
                        r["size"],
                        r["updated_at"],
                    )
                    for r in rows
                ],
            )
            _set_kv(con, "media_index_built_at", _iso())
            _set_kv(con, "media_index_root", str(root.resolve()))
        _rebuild_state["last_ok"] = _iso()
        _rebuild_state["count"] = len(rows)
        return {"ok": True, "count": len(rows), "message": f"已索引 {len(rows)} 条媒资"}
    except Exception as e:
        _rebuild_state["last_error"] = str(e)
        return {"ok": False, "message": str(e), **status()}
    finally:
        _rebuild_state["running"] = False
        _rebuild_lock.release()


def ensure_index_ready() -> None:
    """启动或首次访问时：空库或根目录变更则异步重建，不阻塞请求。"""
    init_media_tables()
    root = str(config.album_root.resolve())
    with connect() as con:
        n = con.execute("SELECT COUNT(*) AS n FROM media").fetchone()["n"]
        stored_root = _get_kv(con, "media_index_root")
    if n == 0 or stored_root != root:
        start_rebuild_async()


def timeline_from_index() -> dict | None:
    init_media_tables()
    with connect() as con:
        n = con.execute("SELECT COUNT(*) AS n FROM media").fetchone()["n"]
        if n == 0:
            return None
        rows = con.execute(
            """
            SELECT path, name, kind, year, month, datetime, title, description, location, lat, lng, has_audio
            FROM media
            ORDER BY year DESC, month DESC, datetime DESC, path DESC
            """
        ).fetchall()
    years: dict[str, dict[str, list]] = {}
    for r in rows:
        y = r["year"] or "0000"
        m = r["month"] or f"{y}-01"
        years.setdefault(y, {}).setdefault(m, []).append(
            {
                "path": r["path"],
                "name": r["name"],
                "kind": r["kind"],
                "has_audio": bool(r["has_audio"]),
                "meta": {
                    "datetime": r["datetime"],
                    "title": r["title"],
                    "description": r["description"],
                    "location": r["location"],
                    "lat": r["lat"],
                    "lng": r["lng"],
                },
            }
        )
    result = []
    for year in sorted(years.keys(), reverse=True):
        months = []
        for month in sorted(years[year].keys(), reverse=True):
            months.append({"month": month, "photos": years[year][month]})
        result.append({"year": year, "months": months})
    return {"years": result, "from_index": True}


def map_points_from_index() -> dict | None:
    init_media_tables()
    with connect() as con:
        n = con.execute("SELECT COUNT(*) AS n FROM media").fetchone()["n"]
        if n == 0:
            return None
        rows = con.execute(
            "SELECT path, name, kind, location, lat, lng, title, datetime FROM media"
        ).fetchall()
    points = []
    skipped = 0
    for r in rows:
        lat, lng = r["lat"], r["lng"]
        source = "gps"
        if lat is None or lng is None:
            resolved = resolve_location(r["location"])
            if resolved:
                lat, lng = resolved
                source = "place"
            else:
                skipped += 1
                continue
        points.append(
            {
                "path": r["path"],
                "name": r["name"],
                "lat": lat,
                "lng": lng,
                "source": source,
                "kind": r["kind"],
                "meta": {
                    "title": r["title"],
                    "location": r["location"],
                    "datetime": r["datetime"],
                },
            }
        )

    def _in_china(lat: float, lng: float) -> bool:
        return 15.0 <= lat <= 54.5 and 72.0 <= lng <= 135.5

    has_foreign = any(not _in_china(p["lat"], p["lng"]) for p in points)
    return {
        "points": points,
        "skipped": skipped,
        "total": len(points) + skipped,
        "scope": "world" if has_foreign else "china",
        "has_foreign": has_foreign,
        "map_mode": "offline",
        "from_index": True,
    }


def start_rebuild_async() -> dict:
    if _rebuild_state["running"]:
        return {"ok": True, "message": "索引重建已在进行", **status()}

    def _run():
        rebuild_index()

    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "message": "已开始重建索引", **status()}
