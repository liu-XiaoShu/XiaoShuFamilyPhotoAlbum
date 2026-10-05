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
              updated_at TEXT NOT NULL,
              uploaded_by_share_id INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_media_ym ON media(year, month);
            CREATE INDEX IF NOT EXISTS idx_media_dt ON media(datetime);
            CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);
            CREATE INDEX IF NOT EXISTS idx_media_geo ON media(lat, lng);
            CREATE TABLE IF NOT EXISTS meta_kv (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            """
        )
        cols = {str(r[1]) for r in con.execute("PRAGMA table_info(media)").fetchall()}
        if "uploaded_by_share_id" not in cols:
            con.execute("ALTER TABLE media ADD COLUMN uploaded_by_share_id INTEGER")
        if "content_hash" not in cols:
            con.execute("ALTER TABLE media ADD COLUMN content_hash TEXT")
        if "duration" not in cols:
            con.execute("ALTER TABLE media ADD COLUMN duration REAL")
        if "audio_duration" not in cols:
            con.execute("ALTER TABLE media ADD COLUMN audio_duration REAL")
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_uploader ON media(uploaded_by_share_id)"
        )
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_hash ON media(content_hash)"
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


def media_bytes_sum() -> int:
    """索引内原片体积合计（不含旁路/回收站）。"""
    init_media_tables()
    with connect() as con:
        row = con.execute(
            "SELECT COALESCE(SUM(size), 0) AS n FROM media"
        ).fetchone()
        return int(row["n"] if row else 0)


def content_hash_coverage() -> dict:
    """入库指纹覆盖率：查重应优先读库，仅对缺失项补算。"""
    init_media_tables()
    with connect() as con:
        total = int(con.execute("SELECT COUNT(*) AS n FROM media").fetchone()["n"])
        hashed = int(
            con.execute(
                """
                SELECT COUNT(*) AS n FROM media
                WHERE content_hash IS NOT NULL AND TRIM(content_hash) != ''
                """
            ).fetchone()["n"]
        )
    missing = max(0, total - hashed)
    return {
        "total": total,
        "hashed": hashed,
        "missing": missing,
        "complete": missing == 0,
    }


def content_hash_algo_state() -> dict:
    """当前去重算法是否已应用到库内指纹。"""
    from .naming import CONTENT_HASH_ALGO

    init_media_tables()
    with connect() as con:
        stored = _get_kv(con, "content_hash_algo") or ""
    needs = stored != CONTENT_HASH_ALGO
    return {
        "algo": CONTENT_HASH_ALGO,
        "stored": stored,
        "needs_rehash": needs,
    }


def set_content_hash_algo(algo: str | None = None) -> None:
    from .naming import CONTENT_HASH_ALGO

    init_media_tables()
    with connect() as con:
        _set_kv(con, "content_hash_algo", algo or CONTENT_HASH_ALGO)
        con.commit()


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
    duration = None
    audio_duration = None
    try:
        from .library import narration_file

        narr = narration_file(path)
        if narr:
            has_audio = 1
            try:
                from .video import probe_duration

                audio_duration = probe_duration(narr)
            except Exception:
                pass
    except Exception:
        pass
    if is_video(path):
        try:
            from .video import probe_duration, read_sidecar

            side = read_sidecar(path)
            duration = side.get("duration")
            if duration is None:
                duration = probe_duration(path)
        except Exception:
            pass
    lat, lng = meta.lat, meta.lng
    # 入库进索引时就把地点文本解析成坐标，浏览地图不再现算
    if (lat is None or lng is None) and (meta.location or "").strip():
        try:
            resolved = resolve_location(meta.location)
            if resolved:
                lat, lng = resolved
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
        "lat": lat,
        "lng": lng,
        "has_audio": has_audio,
        "duration": duration,
        "audio_duration": audio_duration,
        "mtime": st.st_mtime,
        "size": st.st_size,
        "updated_at": _iso(),
        "content_hash": None,
    }


_CACHE_KEYS = (
    "cache_outline_brief",
    "cache_outline_full",
    "cache_map_summary",
)


def invalidate_browse_caches() -> None:
    """媒资变更后清浏览缓存（大纲/地图摘要）。"""
    init_media_tables()
    with connect() as con:
        for k in _CACHE_KEYS:
            con.execute("DELETE FROM meta_kv WHERE key = ?", (k,))


def _cache_get(key: str) -> dict | None:
    with connect() as con:
        raw = _get_kv(con, key)
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _cache_set(key: str, data: dict) -> None:
    with connect() as con:
        _set_kv(con, key, json.dumps(data, ensure_ascii=False, separators=(",", ":")))


def _schedule_tile_prefetch(lat: float, lng: float) -> None:
    def _run():
        try:
            from . import offline_map

            offline_map.prefetch_around(float(lat), float(lng))
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True, name="map-tile-prefetch").start()


def upsert_media(
    album_rel: str,
    *,
    uploaded_by_share_id: int | None = None,
    content_hash: str | None = None,
) -> None:
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
            invalidate = True
        else:
            h = (content_hash or "").strip().lower()
            if len(h) >= 8 and all(c in "0123456789abcdef" for c in h):
                row["content_hash"] = h
            # 新入库可写归属；后续元数据更新保留原 uploaded_by_share_id
            sid = (
                int(uploaded_by_share_id)
                if uploaded_by_share_id is not None
                else None
            )
            con.execute(
                """
                INSERT INTO media(
                  path, name, kind, year, month, datetime, title, description,
                  location, lat, lng, has_audio, mtime, size, updated_at,
                  uploaded_by_share_id, content_hash, duration, audio_duration
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(path) DO UPDATE SET
                  name=excluded.name, kind=excluded.kind, year=excluded.year,
                  month=excluded.month, datetime=excluded.datetime, title=excluded.title,
                  description=excluded.description, location=excluded.location,
                  lat=excluded.lat, lng=excluded.lng, has_audio=excluded.has_audio,
                  mtime=excluded.mtime, size=excluded.size, updated_at=excluded.updated_at,
                  uploaded_by_share_id=COALESCE(
                    excluded.uploaded_by_share_id, media.uploaded_by_share_id
                  ),
                  content_hash=COALESCE(
                    excluded.content_hash, media.content_hash
                  ),
                  duration=COALESCE(excluded.duration, media.duration),
                  audio_duration=COALESCE(excluded.audio_duration, media.audio_duration)
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
                    sid,
                    row.get("content_hash"),
                    row.get("duration"),
                    row.get("audio_duration"),
                ),
            )
            invalidate = True
    # 批量入库时由调用方统一清缓存，避免每张图都刷大纲/地图
    if invalidate and upsert_media._flush_now:
        invalidate_browse_caches()
    if row and row.get("lat") is not None and row.get("lng") is not None:
        _schedule_tile_prefetch(row["lat"], row["lng"])


upsert_media._flush_now = True


def is_owned_by_share(album_rel: str, share_id: int) -> bool:
    rel = str(album_rel).replace("\\", "/").lstrip("/")
    if not rel or not share_id:
        return False
    init_media_tables()
    with connect() as con:
        row = con.execute(
            "SELECT 1 AS ok FROM media WHERE path = ? AND uploaded_by_share_id = ?",
            (rel, int(share_id)),
        ).fetchone()
    return bool(row)


def get_uploader_share_id(album_rel: str) -> int | None:
    rel = str(album_rel).replace("\\", "/").lstrip("/")
    if not rel:
        return None
    init_media_tables()
    with connect() as con:
        row = con.execute(
            "SELECT uploaded_by_share_id FROM media WHERE path = ?", (rel,)
        ).fetchone()
    if not row or row["uploaded_by_share_id"] is None:
        return None
    return int(row["uploaded_by_share_id"])


def delete_media(album_rel: str) -> None:
    rel = str(album_rel).replace("\\", "/").lstrip("/")
    with connect() as con:
        con.execute("DELETE FROM media WHERE path = ?", (rel,))
    invalidate_browse_caches()


def move_media(old_rel: str, new_rel: str) -> None:
    sid = get_uploader_share_id(old_rel)
    delete_media(old_rel)
    upsert_media(new_rel, uploaded_by_share_id=sid)

def rebuild_index(*, force: bool = False) -> dict:
    if not _rebuild_lock.acquire(blocking=False):
        return {"ok": False, "message": "索引重建进行中", **status()}
    _rebuild_state["running"] = True
    _rebuild_state["last_error"] = None
    try:
        init_media_tables()
        root = config.album_root
        # 重建前保留访客入库归属，避免扫盘后丢失「自己上传的可见」
        owners: dict[str, int] = {}
        with connect() as con:
            for r in con.execute(
                "SELECT path, uploaded_by_share_id FROM media "
                "WHERE uploaded_by_share_id IS NOT NULL"
            ).fetchall():
                try:
                    owners[str(r["path"])] = int(r["uploaded_by_share_id"])
                except (TypeError, ValueError):
                    pass
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
                    if row["path"] in owners:
                        row["uploaded_by_share_id"] = owners[row["path"]]
                    else:
                        row["uploaded_by_share_id"] = None
                    rows.append(row)
        with connect() as con:
            con.execute("DELETE FROM media")
            con.executemany(
                """
                INSERT INTO media(
                  path, name, kind, year, month, datetime, title, description,
                  location, lat, lng, has_audio, mtime, size, updated_at,
                  uploaded_by_share_id, content_hash, duration, audio_duration
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
                        r.get("uploaded_by_share_id"),
                        r.get("content_hash"),
                        r.get("duration"),
                        r.get("audio_duration"),
                    )
                    for r in rows
                ],
            )
            _set_kv(con, "media_index_built_at", _iso())
            _set_kv(con, "media_index_root", str(root.resolve()))
        _rebuild_state["last_ok"] = _iso()
        _rebuild_state["count"] = len(rows)
        invalidate_browse_caches()
        return {"ok": True, "count": len(rows), "message": f"已索引 {len(rows)} 条媒资"}
    except Exception as e:
        _rebuild_state["last_error"] = str(e)
        return {"ok": False, "message": str(e), **status()}
    finally:
        _rebuild_state["running"] = False
        _rebuild_lock.release()


def backfill_missing_coords(*, limit: int = 5000) -> int:
    """把缺 GPS、但有地点文本的媒资补全 lat/lng（入库解析遗漏的存量）。"""
    init_media_tables()
    with connect() as con:
        rows = con.execute(
            """
            SELECT path, location FROM media
            WHERE (lat IS NULL OR lng IS NULL)
              AND location IS NOT NULL AND TRIM(location) != ''
            LIMIT ?
            """,
            (max(1, int(limit)),),
        ).fetchall()
    updated = 0
    for r in rows:
        try:
            resolved = resolve_location(r["location"])
        except Exception:
            continue
        if not resolved:
            continue
        with connect() as con:
            con.execute(
                "UPDATE media SET lat = ?, lng = ?, updated_at = ? WHERE path = ?",
                (resolved[0], resolved[1], _iso(), r["path"]),
            )
        updated += 1
    if updated:
        invalidate_browse_caches()
    return updated


def ensure_index_ready() -> None:
    """启动或首次访问时：空库或根目录变更则异步重建，不阻塞请求。"""
    init_media_tables()
    root = str(config.album_root.resolve())
    with connect() as con:
        n = con.execute("SELECT COUNT(*) AS n FROM media").fetchone()["n"]
        stored_root = _get_kv(con, "media_index_root")
    if n == 0 or stored_root != root:
        start_rebuild_async()
        return

    # 存量补坐标：后台跑，不挡请求
    def _bg():
        try:
            backfill_missing_coords(limit=8000)
        except Exception:
            pass

    threading.Thread(target=_bg, daemon=True, name="coords-backfill").start()


def _photo_dict(r: sqlite3.Row | dict) -> dict:
    def _g(key: str, default=None):
        try:
            if isinstance(r, dict):
                return r.get(key, default)
            return r[key] if key in r.keys() else default
        except Exception:
            return default

    return {
        "path": _g("path"),
        "name": _g("name"),
        "kind": _g("kind"),
        "has_audio": bool(_g("has_audio") or 0),
        "duration": _g("duration"),
        "audio_duration": _g("audio_duration"),
        "size": _g("size"),
        "meta": {
            "datetime": _g("datetime"),
            "title": _g("title"),
            "description": _g("description"),
            "location": _g("location"),
            "lat": _g("lat"),
            "lng": _g("lng"),
        },
    }


def lookup_media(album_rel: str) -> dict | None:
    """按路径读索引行（灯箱/详情优先走库，避免每次扫盘 probe）。"""
    rel = str(album_rel).replace("\\", "/").lstrip("/")
    if not rel:
        return None
    init_media_tables()
    with connect() as con:
        row = con.execute(
            """
            SELECT path, name, kind, datetime, title, description, location,
                   lat, lng, has_audio, size, duration, audio_duration, mtime
            FROM media WHERE path = ?
            """,
            (rel,),
        ).fetchone()
    if not row:
        return None
    return _photo_dict(row)


def _scope_clause(
    scopes: list[str] | None,
    media_paths: list[str] | None,
    uploaded_by_share_id: int | None = None,
) -> tuple[str, list[Any]]:
    """返回 (SQL 片段含前导 AND…, 参数)。

    可见 = 分享授权范围 ∪ 该访客自己入库的媒资（uploaded_by_share_id）。
    """
    owner_id: int | None = None
    try:
        if uploaded_by_share_id is not None:
            owner_id = int(uploaded_by_share_id)
    except (TypeError, ValueError):
        owner_id = None
    owner_sql = "uploaded_by_share_id = ?" if owner_id is not None else ""
    owner_args: list[Any] = [owner_id] if owner_id is not None else []

    def _combine(base_sql: str, base_args: list[Any]) -> tuple[str, list[Any]]:
        if owner_sql:
            return f" AND (({base_sql}) OR {owner_sql})", base_args + owner_args
        return f" AND ({base_sql})", base_args

    paths = [p.replace("\\", "/").lstrip("/") for p in (media_paths or []) if p]
    if paths:
        if paths == ["__none__"]:
            if owner_sql:
                return f" AND ({owner_sql})", owner_args
            return " AND 0", []
        ph = ",".join("?" * len(paths))
        return _combine(f"path IN ({ph})", paths)
    scopes = [s.strip().replace("\\", "/").strip("/") for s in (scopes or []) if s and str(s).strip()]
    if not scopes:
        return "", []
    parts = []
    args: list[Any] = []
    for s in scopes:
        parts.append("(path = ? OR path LIKE ?)")
        args.extend([s, s + "/%"])
    return _combine(" OR ".join(parts), args)


def _kind_clause(kind: str | None) -> tuple[str, list[Any]]:
    """媒体类型过滤：image / video；其它视为全部。"""
    k = (kind or "").strip().lower()
    if k == "video":
        return " AND kind = ?", ["video"]
    if k == "image":
        # 历史数据可能缺 kind：非 video 都当照片
        return " AND IFNULL(kind, 'image') != ?", ["video"]
    return "", []


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
        years.setdefault(y, {}).setdefault(m, []).append(_photo_dict(r))
    result = []
    for year in sorted(years.keys(), reverse=True):
        months = []
        for month in sorted(years[year].keys(), reverse=True):
            months.append({"month": month, "photos": years[year][month]})
        result.append({"year": year, "months": months})
    return {"years": result, "from_index": True}


def timeline_outline(
    scopes: list[str] | None = None,
    media_paths: list[str] | None = None,
    uploaded_by_share_id: int | None = None,
    *,
    brief: bool = False,
) -> dict:
    """轻量大纲：年/月计数；brief=True 时跳过高频简述（首屏更快）。"""
    init_media_tables()
    # 全库访问走 SQLite 缓存，刷新几乎零计算
    use_cache = not (scopes or media_paths or uploaded_by_share_id)
    cache_key = "cache_outline_brief" if brief else "cache_outline_full"
    if use_cache:
        hit = _cache_get(cache_key)
        if hit is not None:
            # 重建过程中可能短暂 total=0，勿继续命中空缓存
            if not (hit.get("total") == 0 and _rebuild_state.get("running")):
                hit["from_cache"] = True
                return hit

    where, args = _scope_clause(scopes, media_paths, uploaded_by_share_id)
    with connect() as con:
        total = con.execute(f"SELECT COUNT(*) AS n FROM media WHERE 1=1{where}", args).fetchone()["n"]
        if total == 0:
            empty = {
                "years": [],
                "total": 0,
                "from_index": True,
                "brief": brief,
                "rebuilding": bool(_rebuild_state.get("running")),
            }
            # 重建中不写空缓存，避免首屏一直 HIT 空结果
            if use_cache and not _rebuild_state.get("running"):
                _cache_set(cache_key, empty)
            return empty
        rows = con.execute(
            f"""
            SELECT year, month, kind, COUNT(*) AS n
            FROM media
            WHERE 1=1{where}
            GROUP BY year, month, kind
            """,
            args,
        ).fetchall()
        years_map: dict[str, dict[str, dict]] = {}
        for r in rows:
            y = r["year"] or "0000"
            m = r["month"] or f"{y}-01"
            ym = years_map.setdefault(y, {})
            bucket = ym.setdefault(
                m,
                {"month": m, "photo_count": 0, "image_count": 0, "video_count": 0},
            )
            n = int(r["n"])
            bucket["photo_count"] += n
            if r["kind"] == "video":
                bucket["video_count"] += n
            else:
                bucket["image_count"] += n

        title_freq: dict[str, dict[str, int]] = {}
        if not brief:
            for tr in con.execute(
                f"""
                SELECT year, title, COUNT(*) AS c
                FROM media
                WHERE title IS NOT NULL AND TRIM(title) != ''{where}
                GROUP BY year, title
                """,
                args,
            ).fetchall():
                y = tr["year"] or "0000"
                bucket = title_freq.setdefault(y, {})
                bucket[tr["title"]] = int(tr["c"])

        year_list = []
        for year in sorted(years_map.keys(), reverse=True):
            months = [
                years_map[year][m]
                for m in sorted(years_map[year].keys(), reverse=True)
            ]
            photo_count = sum(m["photo_count"] for m in months)
            image_count = sum(m["image_count"] for m in months)
            video_count = sum(m["video_count"] for m in months)
            ranked = sorted(
                (title_freq.get(year) or {}).items(),
                key=lambda x: (-x[1], x[0]),
            )[:5]
            top_titles = [t for t, _ in ranked]
            year_list.append(
                {
                    "year": year,
                    "photo_count": photo_count,
                    "image_count": image_count,
                    "video_count": video_count,
                    "month_count": len(months),
                    "top_titles": top_titles,
                    "months": months,
                }
            )
    result = {
        "years": year_list,
        "total": int(total),
        "from_index": True,
        "brief": brief,
        "from_cache": False,
    }
    if use_cache:
        _cache_set(cache_key, {k: v for k, v in result.items() if k != "from_cache"})
    return result


def timeline_month(
    month: str,
    *,
    limit: int = 200,
    offset: int = 0,
    scopes: list[str] | None = None,
    media_paths: list[str] | None = None,
    uploaded_by_share_id: int | None = None,
    kind: str | None = None,
) -> dict:
    """按月分页拉取照片（新→旧）。kind=image|video 时在库内过滤。"""
    init_media_tables()
    month = (month or "").strip()
    if not month:
        return {
            "month": month,
            "year": "",
            "photos": [],
            "total": 0,
            "offset": 0,
            "limit": limit,
            "has_more": False,
            "from_index": True,
            "kind": kind or "all",
        }
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    where, args = _scope_clause(scopes, media_paths, uploaded_by_share_id)
    kind_sql, kind_args = _kind_clause(kind)
    year = month[:4] if len(month) >= 4 else ""
    with connect() as con:
        total = con.execute(
            f"SELECT COUNT(*) AS n FROM media WHERE month = ?{where}{kind_sql}",
            [month, *args, *kind_args],
        ).fetchone()["n"]
        rows = con.execute(
            f"""
            SELECT path, name, kind, year, month, datetime, title, description, location, lat, lng, has_audio
            FROM media
            WHERE month = ?{where}{kind_sql}
            ORDER BY datetime DESC, path DESC
            LIMIT ? OFFSET ?
            """,
            [month, *args, *kind_args, limit, offset],
        ).fetchall()
    photos = [_photo_dict(r) for r in rows]
    return {
        "month": month,
        "year": year,
        "photos": photos,
        "total": int(total),
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(photos) < int(total),
        "from_index": True,
        "kind": (kind or "all"),
    }


def timeline_paths(
    *,
    year: str | None = None,
    month: str | None = None,
    scopes: list[str] | None = None,
    media_paths: list[str] | None = None,
    uploaded_by_share_id: int | None = None,
    kind: str | None = None,
) -> dict:
    """仅返回 path 列表（多选/批量用），避免拉全量元数据。"""
    init_media_tables()
    where, args = _scope_clause(scopes, media_paths, uploaded_by_share_id)
    kind_sql, kind_args = _kind_clause(kind)
    clauses = ["1=1"]
    params: list[Any] = []
    if month:
        clauses.append("month = ?")
        params.append(month.strip())
    elif year:
        clauses.append("year = ?")
        params.append(year.strip())
    sql = (
        f"SELECT path FROM media WHERE {' AND '.join(clauses)}{where}{kind_sql} "
        "ORDER BY datetime DESC, path DESC"
    )
    with connect() as con:
        rows = con.execute(sql, [*params, *args, *kind_args]).fetchall()
    paths = [r["path"] for r in rows]
    return {"paths": paths, "total": len(paths), "from_index": True, "kind": kind or "all"}


def map_points_from_index(kind: str | None = None) -> dict | None:
    init_media_tables()
    kind_sql, kind_args = _kind_clause(kind)
    with connect() as con:
        n = con.execute("SELECT COUNT(*) AS n FROM media").fetchone()["n"]
        if n == 0:
            return None
        # 坐标在入库/索引时已写入；此处不再现解析地点（避免首屏/地图卡顿）
        rows = con.execute(
            f"""
            SELECT path, name, kind, location, lat, lng, title, datetime FROM media
            WHERE lat IS NOT NULL AND lng IS NOT NULL{kind_sql}
            """,
            kind_args,
        ).fetchall()
        skipped = con.execute(
            f"SELECT COUNT(*) AS n FROM media WHERE lat IS NULL OR lng IS NULL{kind_sql}",
            kind_args,
        ).fetchone()["n"]
    points = [
        {
            "path": r["path"],
            "name": r["name"],
            "lat": r["lat"],
            "lng": r["lng"],
            "source": "index",
            "kind": r["kind"],
            "meta": {
                "title": r["title"],
                "location": r["location"],
                "datetime": r["datetime"],
            },
        }
        for r in rows
    ]

    def _in_china(lat: float, lng: float) -> bool:
        # 南界约海南三亚；过低会把泰国中心点误判成「国内」
        return 18.0 <= lat <= 54.5 and 73.0 <= lng <= 135.5

    has_foreign = any(not _in_china(p["lat"], p["lng"]) for p in points)
    return {
        "points": points,
        "skipped": int(skipped),
        "total": len(points) + int(skipped),
        "scope": "world" if has_foreign else "china",
        "has_foreign": has_foreign,
        "map_mode": "offline",
        "from_index": True,
    }


def _map_cell(zoom: int) -> float:
    """地图聚合网格边长（度）。

    原先 z+2 在默认世界视野（约 zoom 5）会把港深揉成一簇，封面常被深圳盖住，
    看起来像香港没点。略加密后邻近城市更早分开。
    """
    z = max(2, min(int(zoom or 4), 18))
    # z+5：默认世界视野（约 zoom 5）即可把港/深分开
    return max(0.02, 360.0 / (2 ** (z + 5)))


def map_summary(
    scopes: list[str] | None = None,
    media_paths: list[str] | None = None,
    uploaded_by_share_id: int | None = None,
) -> dict:
    """地图摘要：有坐标点数、缺坐标数、视野范围，不返回逐点。"""
    init_media_tables()
    use_cache = not (scopes or media_paths or uploaded_by_share_id)
    if use_cache:
        hit = _cache_get("cache_map_summary")
        if hit is not None:
            hit["from_cache"] = True
            return hit
    where, args = _scope_clause(scopes, media_paths, uploaded_by_share_id)
    with connect() as con:
        total = con.execute(f"SELECT COUNT(*) AS n FROM media WHERE 1=1{where}", args).fetchone()["n"]
        geo = con.execute(
            f"""
            SELECT COUNT(*) AS n,
                   MIN(lat) AS min_lat, MAX(lat) AS max_lat,
                   MIN(lng) AS min_lng, MAX(lng) AS max_lng
            FROM media
            WHERE lat IS NOT NULL AND lng IS NOT NULL{where}
            """,
            args,
        ).fetchone()
        skipped = con.execute(
            f"""
            SELECT COUNT(*) AS n FROM media
            WHERE (lat IS NULL OR lng IS NULL){where}
            """,
            args,
        ).fetchone()["n"]
    n = int(geo["n"] or 0)
    has_foreign = False
    if n and geo["min_lat"] is not None:
        def _out(lat: float, lng: float) -> bool:
            return not (18.0 <= lat <= 54.5 and 73.0 <= lng <= 135.5)

        has_foreign = (
            _out(float(geo["min_lat"]), float(geo["min_lng"]))
            or _out(float(geo["max_lat"]), float(geo["max_lng"]))
            or _out(float(geo["min_lat"]), float(geo["max_lng"]))
            or _out(float(geo["max_lat"]), float(geo["min_lng"]))
        )
    result = {
        "total": int(total),
        "points": n,
        "skipped": int(skipped),
        "scope": "world" if has_foreign else "china",
        "has_foreign": has_foreign,
        "bounds": (
            {
                "south": float(geo["min_lat"]),
                "west": float(geo["min_lng"]),
                "north": float(geo["max_lat"]),
                "east": float(geo["max_lng"]),
            }
            if n and geo["min_lat"] is not None
            else None
        ),
        "from_index": True,
        "from_cache": False,
    }
    if use_cache:
        _cache_set("cache_map_summary", {k: v for k, v in result.items() if k != "from_cache"})
    return result


def map_clusters(
    zoom: int,
    *,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
    scopes: list[str] | None = None,
    media_paths: list[str] | None = None,
    uploaded_by_share_id: int | None = None,
    limit: int = 800,
    kind: str | None = None,
) -> dict:
    """按缩放网格服务端聚合，仅返回簇摘要（含封面 path）。"""
    init_media_tables()
    cell = _map_cell(zoom)
    limit = max(1, min(int(limit), 1500))
    where, args = _scope_clause(scopes, media_paths, uploaded_by_share_id)
    kind_sql, kind_args = _kind_clause(kind)
    bbox = ""
    bargs: list[Any] = []
    if None not in (west, south, east, north):
        # 略放大视野，避免边缘空洞
        pad = cell * 1.5
        bbox = " AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?"
        bargs = [float(south) - pad, float(north) + pad, float(west) - pad, float(east) + pad]

    with connect() as con:
        rows = con.execute(
            f"""
            SELECT
              CAST(ROUND(lat / ?) AS INTEGER) AS gy,
              CAST(ROUND(lng / ?) AS INTEGER) AS gx,
              AVG(lat) AS lat,
              AVG(lng) AS lng,
              COUNT(*) AS cnt,
              MAX(datetime || '|' || path) AS cover_key
            FROM media
            WHERE lat IS NOT NULL AND lng IS NOT NULL{where}{kind_sql}{bbox}
            GROUP BY gy, gx
            ORDER BY cnt DESC
            LIMIT ?
            """,
            [cell, cell, *args, *kind_args, *bargs, limit],
        ).fetchall()

        clusters = []
        for r in rows:
            cover_key = r["cover_key"] or ""
            cover_path = cover_key.split("|", 1)[-1] if cover_key else ""
            # 多地点揉在一簇时，封面优先取该簇「出现最多」的地点里最新一张
            mode = con.execute(
                """
                SELECT location FROM media
                WHERE lat IS NOT NULL AND lng IS NOT NULL
                  AND CAST(ROUND(lat / ?) AS INTEGER) = ?
                  AND CAST(ROUND(lng / ?) AS INTEGER) = ?
                  AND location IS NOT NULL AND TRIM(location) != ''
                GROUP BY location
                ORDER BY COUNT(*) DESC, MAX(datetime) DESC
                LIMIT 1
                """,
                (cell, int(r["gy"]), cell, int(r["gx"])),
            ).fetchone()
            if mode and mode["location"]:
                pref = con.execute(
                    """
                    SELECT path FROM media
                    WHERE lat IS NOT NULL AND lng IS NOT NULL
                      AND CAST(ROUND(lat / ?) AS INTEGER) = ?
                      AND CAST(ROUND(lng / ?) AS INTEGER) = ?
                      AND location = ?
                    ORDER BY datetime DESC, path DESC
                    LIMIT 1
                    """,
                    (cell, int(r["gy"]), cell, int(r["gx"]), mode["location"]),
                ).fetchone()
                if pref and pref["path"]:
                    cover_path = pref["path"]
            cover = None
            if cover_path:
                cr = con.execute(
                    """
                    SELECT path, name, kind, title, location, datetime, lat, lng
                    FROM media WHERE path = ?
                    """,
                    (cover_path,),
                ).fetchone()
                if cr:
                    cover = {
                        "path": cr["path"],
                        "name": cr["name"],
                        "kind": cr["kind"],
                        "lat": cr["lat"],
                        "lng": cr["lng"],
                        "meta": {
                            "title": cr["title"],
                            "location": cr["location"],
                            "datetime": cr["datetime"],
                        },
                    }
            clusters.append(
                {
                    "lat": float(r["lat"]),
                    "lng": float(r["lng"]),
                    "count": int(r["cnt"]),
                    "gy": int(r["gy"]),
                    "gx": int(r["gx"]),
                    "cell": cell,
                    "cover": cover,
                }
            )
    return {
        "clusters": clusters,
        "zoom": int(zoom),
        "cell": cell,
        "from_index": True,
    }


def map_cluster_photos(
    *,
    gy: int,
    gx: int,
    cell: float,
    limit: int = 200,
    offset: int = 0,
    scopes: list[str] | None = None,
    media_paths: list[str] | None = None,
    uploaded_by_share_id: int | None = None,
) -> dict:
    """展开某一网格簇内的照片。"""
    init_media_tables()
    cell = float(cell) if cell and cell > 0 else 0.05
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    where, args = _scope_clause(scopes, media_paths, uploaded_by_share_id)
    with connect() as con:
        total = con.execute(
            f"""
            SELECT COUNT(*) AS n FROM media
            WHERE lat IS NOT NULL AND lng IS NOT NULL
              AND CAST(ROUND(lat / ?) AS INTEGER) = ?
              AND CAST(ROUND(lng / ?) AS INTEGER) = ?
              {where}
            """,
            [cell, int(gy), cell, int(gx), *args],
        ).fetchone()["n"]
        rows = con.execute(
            f"""
            SELECT path, name, kind, location, lat, lng, title, datetime
            FROM media
            WHERE lat IS NOT NULL AND lng IS NOT NULL
              AND CAST(ROUND(lat / ?) AS INTEGER) = ?
              AND CAST(ROUND(lng / ?) AS INTEGER) = ?
              {where}
            ORDER BY datetime DESC, path DESC
            LIMIT ? OFFSET ?
            """,
            [cell, int(gy), cell, int(gx), *args, limit, offset],
        ).fetchall()
    photos = [
        {
            "path": r["path"],
            "name": r["name"],
            "lat": r["lat"],
            "lng": r["lng"],
            "kind": r["kind"],
            "meta": {
                "title": r["title"],
                "location": r["location"],
                "datetime": r["datetime"],
            },
        }
        for r in rows
    ]
    lat = sum(p["lat"] for p in photos) / len(photos) if photos else 0.0
    lng = sum(p["lng"] for p in photos) / len(photos) if photos else 0.0
    return {
        "photos": photos,
        "total": int(total),
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(photos) < int(total),
        "lat": lat,
        "lng": lng,
        "count": int(total),
        "gy": int(gy),
        "gx": int(gx),
        "cell": cell,
        "from_index": True,
    }


def start_rebuild_async() -> dict:
    if _rebuild_state["running"]:
        return {"ok": True, "message": "索引重建已在进行", **status()}

    def _run():
        rebuild_index()

    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "message": "已开始重建索引", **status()}


def set_content_hash(album_rel: str, content_hash: str) -> None:
    rel = str(album_rel).replace("\\", "/").lstrip("/")
    h = (content_hash or "").strip().lower()
    if not rel or not h:
        return
    init_media_tables()
    with connect() as con:
        con.execute(
            "UPDATE media SET content_hash = ?, updated_at = ? WHERE path = ?",
            (h, _iso(), rel),
        )


def patch_media_meta(
    album_rel: str,
    fields: dict,
    *,
    invalidate: bool = True,
) -> None:
    """轻量更新索引元数据字段，避免批量编辑时反复读盘/探测视频时长。

    fields 仅含要改的键；值可为 None（表示清空该字段）。
    """
    rel = str(album_rel).replace("\\", "/").lstrip("/")
    if not rel or not fields:
        return
    allowed = ("datetime", "title", "description", "location", "lat", "lng", "year", "month")
    sets: list[str] = []
    args: list = []
    for key in allowed:
        if key in fields:
            sets.append(f"{key} = ?")
            args.append(fields[key])
    if not sets:
        return
    sets.append("updated_at = ?")
    args.append(_iso())
    args.append(rel)
    init_media_tables()
    with connect() as con:
        con.execute(
            f"UPDATE media SET {', '.join(sets)} WHERE path = ?",
            tuple(args),
        )
    if invalidate:
        invalidate_browse_caches()


def paths_by_content_hash(content_hash: str) -> list[str]:
    h = (content_hash or "").strip().lower()
    if not h:
        return []
    init_media_tables()
    with connect() as con:
        rows = con.execute(
            "SELECT path FROM media WHERE content_hash = ? ORDER BY path",
            (h,),
        ).fetchall()
    return [r["path"] for r in rows]


def content_hash_path_map() -> dict[str, list[str]]:
    """一次加载全部已入库指纹 → 路径列表，供待入库批量查重。"""
    init_media_tables()
    out: dict[str, list[str]] = {}
    with connect() as con:
        rows = con.execute(
            """
            SELECT content_hash, path FROM media
            WHERE content_hash IS NOT NULL AND TRIM(content_hash) != ''
            ORDER BY path
            """
        ).fetchall()
    for r in rows:
        h = (r["content_hash"] or "").strip().lower()
        if not h:
            continue
        out.setdefault(h, []).append(r["path"])
    return out


def duplicate_groups(*, limit: int = 200) -> dict:
    init_media_tables()
    coverage = content_hash_coverage()
    algo = content_hash_algo_state()
    with connect() as con:
        rows = con.execute(
            """
            SELECT content_hash, COUNT(*) AS c
            FROM media
            WHERE content_hash IS NOT NULL AND TRIM(content_hash) != ''
            GROUP BY content_hash
            HAVING c > 1
            ORDER BY c DESC
            LIMIT ?
            """,
            (max(1, min(int(limit or 200), 500)),),
        ).fetchall()
        groups = []
        for r in rows:
            items = con.execute(
                """
                SELECT path, name, kind, size, datetime, title
                FROM media WHERE content_hash = ? ORDER BY datetime, path
                """,
                (r["content_hash"],),
            ).fetchall()
            groups.append(
                {
                    "content_hash": r["content_hash"],
                    "count": int(r["c"]),
                    "items": [
                        {
                            "path": it["path"],
                            "name": it["name"],
                            "kind": it["kind"],
                            "size": it["size"],
                            "datetime": it["datetime"],
                            "title": it["title"],
                        }
                        for it in items
                    ],
                }
            )
    return {
        "groups": groups,
        "count": len(groups),
        "total": coverage["total"],
        "hashed": coverage["hashed"],
        "missing": coverage["missing"],
        "complete": coverage["complete"],
        "hash_algo": algo["algo"],
        "needs_rehash": algo["needs_rehash"],
    }


def search_media(
    q: str,
    *,
    limit: int = 60,
    offset: int = 0,
    scopes: list[str] | None = None,
    media_paths: list[str] | None = None,
    uploaded_by_share_id: int | None = None,
    kind: str | None = None,
) -> dict:
    init_media_tables()
    text = (q or "").strip()
    if not text:
        return {
            "items": [],
            "total": 0,
            "q": q,
            "limit": limit,
            "offset": offset,
            "kind": kind or "all",
        }
    limit = max(1, min(int(limit or 60), 200))
    offset = max(0, int(offset or 0))
    like = f"%{text}%"
    where_scope, args_scope = _scope_clause(scopes, media_paths, uploaded_by_share_id)
    kind_sql, kind_args = _kind_clause(kind)
    sql_where = (
        " WHERE ("
        " IFNULL(title,'') LIKE ? OR IFNULL(description,'') LIKE ?"
        " OR IFNULL(location,'') LIKE ? OR IFNULL(name,'') LIKE ?"
        " OR IFNULL(path,'') LIKE ? OR IFNULL(datetime,'') LIKE ?"
        " )"
        + where_scope
        + kind_sql
    )
    args = [like, like, like, like, like, like] + args_scope + kind_args
    with connect() as con:
        total = con.execute(
            f"SELECT COUNT(*) AS c FROM media{sql_where}", args
        ).fetchone()["c"]
        rows = con.execute(
            f"""
            SELECT path, name, kind, year, month, datetime, title, description,
                   location, lat, lng, has_audio, size
            FROM media
            {sql_where}
            ORDER BY datetime DESC, path DESC
            LIMIT ? OFFSET ?
            """,
            args + [limit, offset],
        ).fetchall()
    items = []
    for r in rows:
        d = _photo_dict(r)
        d["size"] = r["size"]
        items.append(d)
    return {
        "items": items,
        "total": int(total),
        "q": text,
        "limit": limit,
        "offset": offset,
        "kind": kind or "all",
    }
