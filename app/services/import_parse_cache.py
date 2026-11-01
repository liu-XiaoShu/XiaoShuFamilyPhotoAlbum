"""待入库解析：内容指纹磁盘缓存 + 列表短缓存，减轻 USB 盘连续猛读。"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from ..config import config

_LOCK = threading.Lock()
_MEM: dict[str, dict] = {}
_LIST_CACHE: dict = {"at": 0.0, "items": None}
_DIRTY = False
_LAST_SAVE = 0.0


def _cache_path() -> Path:
    # 与相册 data 同盘，避免写到 SD 卡
    try:
        return Path(config.thumb_root).resolve().parent / "import_parse_cache.json"
    except Exception:
        return Path(config.import_root).resolve().parent / "import_parse_cache.json"


def _load() -> None:
    global _MEM
    path = _cache_path()
    if not path.is_file():
        return
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            _MEM = {str(k): v for k, v in raw.items() if isinstance(v, dict)}
    except (OSError, json.JSONDecodeError):
        _MEM = {}


def _save_unlocked(*, force: bool = False) -> None:
    global _DIRTY, _LAST_SAVE
    if not _DIRTY and not force:
        return
    now = time.time()
    if not force and now - _LAST_SAVE < 8:
        return
    path = _cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(_MEM, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
        _DIRTY = False
        _LAST_SAVE = now
    except OSError:
        pass


def content_hash_cached(path: Path, compute) -> str:
    """按 path+size+mtime 复用指纹；未命中再调用 compute(path)。"""
    try:
        st = path.stat()
    except OSError:
        return ""
    key = str(path.resolve())
    sig = f"{st.st_size}:{int(st.st_mtime_ns)}"
    with _LOCK:
        if not _MEM and _cache_path().is_file():
            _load()
        hit = _MEM.get(key)
        if hit and hit.get("sig") == sig and hit.get("hash"):
            return str(hit["hash"])
    digest = ""
    try:
        digest = compute(path) or ""
    except OSError:
        digest = ""
    if digest:
        with _LOCK:
            _MEM[key] = {"sig": sig, "hash": digest}
            global _DIRTY
            _DIRTY = True
            # 控制体积：超过 2 万条时丢掉一半旧项（简单截断）
            if len(_MEM) > 20000:
                for k in list(_MEM.keys())[:10000]:
                    _MEM.pop(k, None)
            _save_unlocked()
    return digest


def flush_cache() -> None:
    with _LOCK:
        _save_unlocked(force=True)


def list_import_cached(loader, *, ttl: float = 60.0):
    """短时复用待入库列表，避免每个解析分片都全盘 rglob。"""
    now = time.time()
    with _LOCK:
        items = _LIST_CACHE.get("items")
        at = float(_LIST_CACHE.get("at") or 0)
        if items is not None and now - at < ttl:
            return items
    items = loader()
    with _LOCK:
        _LIST_CACHE["items"] = items
        _LIST_CACHE["at"] = time.time()
    return items


def invalidate_list_cache() -> None:
    with _LOCK:
        _LIST_CACHE["items"] = None
        _LIST_CACHE["at"] = 0.0


def parse_pause_seconds() -> float:
    """每张图处理后的停顿，降低 USB 盘连续读爆掉线概率。"""
    raw = os.environ.get("ALBUM_PARSE_PAUSE_MS", "80").strip()
    try:
        ms = max(0, min(int(raw), 2000))
    except ValueError:
        ms = 80
    return ms / 1000.0
