"""存储统计、权限对齐、内容去重辅助。"""
from __future__ import annotations

import os
from pathlib import Path

from ..config import ROOT, config
from .naming import MEDIA_EXTS, file_md5, is_media, is_video

TRASH_DIRNAME = ".trash"

_HOST_UID: int | None = None
_HOST_GID: int | None = None
_HOST_READY = False


def _host_ids() -> tuple[int | None, int | None]:
    global _HOST_UID, _HOST_GID, _HOST_READY
    if _HOST_READY:
        return _HOST_UID, _HOST_GID
    try:
        uid = os.environ.get("HOST_UID") or os.environ.get("ALBUM_HOST_UID")
        gid = os.environ.get("HOST_GID") or os.environ.get("ALBUM_HOST_GID")
        _HOST_UID = int(uid) if uid not in (None, "") else None
        _HOST_GID = int(gid) if gid not in (None, "") else None
    except ValueError:
        _HOST_UID, _HOST_GID = None, None
    _HOST_READY = True
    return _HOST_UID, _HOST_GID


def ensure_host_perms(path: Path, *, is_dir: bool = False) -> None:
    """chmod 保证可读；若配置 HOST_UID 且进程为 root 则 chown 到宿主机用户。"""
    try:
        if not path.exists():
            return
        mode = 0o755 if (is_dir or path.is_dir()) else 0o644
        os.chmod(path, mode)
        uid, gid = _host_ids()
        if uid is not None and os.geteuid() == 0:
            os.chown(path, uid, gid if gid is not None else uid)
    except OSError:
        pass


def dir_byte_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    try:
        if path.is_file():
            return int(path.stat().st_size)
        for p in path.rglob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                pass
    except OSError:
        pass
    return total


def storage_overview() -> dict:
    import shutil

    album = config.album_root
    trash = album / TRASH_DIRNAME
    inbox = config.import_root
    thumbs = config.thumb_root
    data_root = (ROOT / "data").resolve()
    map_pack = data_root / "map_pack"

    album_bytes = dir_byte_size(album)
    trash_bytes = dir_byte_size(trash) if trash.exists() else 0
    album_net = max(0, album_bytes - trash_bytes)

    media_count = 0
    trash_count = 0
    try:
        from . import media_index

        media_count = media_index.index_count()
    except Exception:
        pass
    try:
        trash_count = sum(1 for p in trash.iterdir() if p.is_dir()) if trash.exists() else 0
    except OSError:
        trash_count = 0

    try:
        usage = shutil.disk_usage(str(album if album.exists() else ROOT))
        disk = {
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "percent_used": round(100.0 * usage.used / usage.total, 1) if usage.total else 0,
        }
    except OSError:
        disk = {"total": 0, "used": 0, "free": 0, "percent_used": 0}

    return {
        "paths": {
            "album_root": str(album),
            "trash_root": str(trash),
            "import_root": str(inbox),
            "thumb_root": str(thumbs),
            "map_pack": str(map_pack),
            "data_root": str(data_root),
        },
        "bytes": {
            "album": album_net,
            "trash": trash_bytes,
            "inbox": dir_byte_size(inbox),
            "thumbs": dir_byte_size(thumbs),
            "map_pack": dir_byte_size(map_pack),
            "data": dir_byte_size(data_root),
            "album_with_trash": album_bytes,
        },
        "counts": {"media": media_count, "trash": trash_count},
        "disk": disk,
    }


def content_hash_of(path: Path) -> str:
    return file_md5(path, length=32)


def find_existing_by_hash(content_hash: str, *, exclude_rel: str | None = None) -> list[str]:
    h = (content_hash or "").strip().lower()
    if not h:
        return []
    short = h[:8]
    found: list[str] = []
    try:
        from . import media_index

        found = media_index.paths_by_content_hash(h)
    except Exception:
        found = []
    if found:
        return [p for p in found if p != exclude_rel]

    root = config.album_root
    if not root.exists():
        return []
    for p in root.rglob("*"):
        if not is_media(p):
            continue
        try:
            rel = str(p.relative_to(root)).replace("\\", "/")
        except ValueError:
            continue
        if rel.startswith(TRASH_DIRNAME + "/") or TRASH_DIRNAME in Path(rel).parts:
            continue
        if short not in p.stem.lower():
            continue
        try:
            if content_hash_of(p) != h:
                continue
        except OSError:
            continue
        if exclude_rel and rel == exclude_rel:
            continue
        found.append(rel)
    return found


def live_video_for(media: Path) -> Path | None:
    if not media.is_file() or is_video(media):
        return None
    direct = media.with_name(media.name + ".live.mov")
    if direct.is_file():
        return direct
    try:
        from .video import read_sidecar

        side = read_sidecar(media) or {}
        name = side.get("live_video")
        if name:
            p = media.parent / Path(str(name)).name
            if p.is_file():
                return p
    except Exception:
        pass
    return None


def list_duplicate_groups(*, limit: int = 200) -> dict:
    """按 content_hash 分组；返回每组 2+ 条。"""
    try:
        from . import media_index

        return media_index.duplicate_groups(limit=limit)
    except Exception as e:
        return {"groups": [], "count": 0, "message": str(e)}
