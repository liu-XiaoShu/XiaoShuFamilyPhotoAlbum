"""后台补算 content_hash。

整库按 nometa-v1 扫完才写入 content_hash_full。没写上这个标记时，
启动后会重算全部指纹，避免把旧的整文件 MD5 当成去元数据指纹。
"""
from __future__ import annotations

import os
import threading
from datetime import datetime

from . import media_index

FULL_KEY = "content_hash_full"
FULL_VALUE = "nometa-v1"

_lock = threading.Lock()
_state = {
    "running": False,
    "done": 0,
    "total": 0,
    "updated": 0,
    "failed": 0,
    "error": None,
    "finished_at": None,
}


def hash_coverage() -> dict:
    media_index.init_media_tables()
    with media_index.connect() as con:
        total = int(con.execute("SELECT COUNT(*) AS n FROM media").fetchone()["n"])
        hashed = int(
            con.execute(
                """
                SELECT COUNT(*) AS n FROM media
                WHERE content_hash IS NOT NULL AND TRIM(content_hash) != ''
                """
            ).fetchone()["n"]
        )
        row = con.execute(
            "SELECT value FROM meta_kv WHERE key = ?",
            (FULL_KEY,),
        ).fetchone()
        full = (row["value"] if row else "") or ""
    missing = max(0, total - hashed)
    return {
        "total": total,
        "hashed": hashed,
        "missing": missing,
        "full": full,
        "needs_rehash": full != FULL_VALUE,
    }


def public_state() -> dict:
    with _lock:
        return dict(_state)


def _mark_full() -> None:
    with media_index.connect() as con:
        media_index._set_kv(con, FULL_KEY, FULL_VALUE)
        media_index._set_kv(con, "content_hash_algo", FULL_VALUE)


def _hash_one(rel: str) -> tuple[str, str | None]:
    from .library import album_path
    from .ops import content_hash_of

    try:
        full = album_path(rel)
        if not full.is_file():
            return rel, None
        return rel, content_hash_of(full)
    except Exception:
        return rel, None


def _flush_hashes(items: list[tuple[str, str]]) -> None:
    if not items:
        return
    stamp = media_index._iso()
    with media_index.connect() as con:
        con.executemany(
            "UPDATE media SET content_hash = ?, updated_at = ? WHERE path = ?",
            [(h, stamp, rel) for rel, h in items],
        )


def _start_thumb_warm() -> None:
    """指纹算完再补缩略图。仅当环境变量 ALBUM_WARM_THUMBS 指向本机脚本时启动。"""
    import subprocess

    script = os.environ.get("ALBUM_WARM_THUMBS", "").strip()
    if not script or not os.path.isfile(script):
        return
    try:
        subprocess.Popen(
            ["python3", "-u", script],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print("[dedup] thumb warm started", flush=True)
    except OSError as exc:
        print(f"[dedup] thumb warm skip {exc}", flush=True)


def _worker(force: bool) -> None:
    from concurrent.futures import ThreadPoolExecutor

    try:
        try:
            os.nice(8)
        except OSError:
            pass
        media_index.init_media_tables()
        with media_index.connect() as con:
            if force:
                rows = con.execute("SELECT path FROM media").fetchall()
                con.execute("UPDATE media SET content_hash = NULL")
            else:
                rows = con.execute(
                    """
                    SELECT path FROM media
                    WHERE content_hash IS NULL OR TRIM(content_hash) = ''
                    """
                ).fetchall()
        paths = [
            r["path"]
            for r in rows
            if r["path"] and not str(r["path"]).startswith(".trash/")
        ]
        with _lock:
            _state["total"] = len(paths)
            _state["done"] = 0
            _state["updated"] = 0
            _state["failed"] = 0
            _state["error"] = None
        print(f"[dedup] start force={force} n={len(paths)}", flush=True)
        batch: list[tuple[str, str]] = []
        updated = 0
        failed = 0
        with ThreadPoolExecutor(max_workers=2) as pool:
            for i, (rel, digest) in enumerate(pool.map(_hash_one, paths, chunksize=16), 1):
                if digest:
                    batch.append((rel, digest))
                    updated += 1
                else:
                    failed += 1
                if len(batch) >= 40:
                    _flush_hashes(batch)
                    batch = []
                if i % 20 == 0 or i == len(paths):
                    with _lock:
                        _state["done"] = i
                        _state["updated"] = updated
                        _state["failed"] = failed
                if i % 200 == 0 or i == len(paths):
                    print(f"[dedup] {i}/{len(paths)}", flush=True)
        _flush_hashes(batch)
        with _lock:
            _state["done"] = len(paths)
            _state["updated"] = updated
            _state["failed"] = failed
        if force:
            _mark_full()
        else:
            cov = hash_coverage()
            if cov["missing"] == 0 and cov["total"] > 0:
                _mark_full()
        print("[dedup] finished", flush=True)
        _start_thumb_warm()
    except Exception as exc:
        with _lock:
            _state["error"] = str(exc)[:300]
        print(f"[dedup] error {exc}", flush=True)
    finally:
        with _lock:
            _state["running"] = False
            _state["finished_at"] = datetime.now().isoformat(timespec="seconds")


def start_dedup_scan(*, force: bool = False) -> dict:
    cov = hash_coverage()
    # 整库标记还没写上、但已经算出一批指纹时，只补缺口，避免重启把算过的清掉。
    if force and cov["needs_rehash"] and cov["hashed"] > 0:
        force = False
    with _lock:
        if _state["running"]:
            snap = dict(_state)
            snap.update({"ok": True, "started": False})
            return snap
        _state["running"] = True
        _state["error"] = None
        _state["finished_at"] = None
        _state["done"] = 0
        _state["updated"] = 0
        _state["failed"] = 0
    threading.Thread(
        target=_worker, args=(bool(force),), daemon=True, name="dedup-scan"
    ).start()
    snap = public_state()
    snap.update({"ok": True, "started": True})
    return snap


def kick_dedup_scan() -> None:
    """启动时若还没完成 nometa 整库扫描，就在后台开始。"""
    try:
        cov = hash_coverage()
        if cov["needs_rehash"] or cov["missing"] > 0:
            start_dedup_scan(force=bool(cov["needs_rehash"]))
    except Exception as exc:
        print(f"[dedup] kick failed {exc}", flush=True)
