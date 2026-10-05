from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime
from pathlib import Path

from PIL import Image

from ..config import ROOT, config
from .geo import resolve_location
from .metadata import PhotoMeta, apply_meta_dict, read_meta, write_meta
from .naming import (
    MEDIA_EXTS,
    build_rel_path,
    guess_datetime_from_name,
    is_image,
    is_media,
    is_video,
    parse_datetime,
    parse_title_from_filename,
    sanitize_title,
    unique_path,
)

TRASH_DIRNAME = ".trash"
_HASH_CACHE_LOCK = threading.Lock()
_HASH_CACHE_MEM: dict[str, dict] | None = None
_PARSE_WORKERS = max(1, min(3, (os.cpu_count() or 2)))
_IMPORT_LIST_LOCK = threading.Lock()
_IMPORT_LIST_MEM: tuple[float, list] | None = None
_IMPORT_LIST_TTL = 2.5



def _path_visible(
    rel: str,
    scopes: list | None,
    media_paths: list | None,
    uploaded_by_share_id: int | None,
) -> bool:
    from . import auth as _auth
    from . import media_index

    if _auth.path_allowed(rel or "", scopes or [], media_paths or []):
        return True
    if uploaded_by_share_id:
        return media_index.is_owned_by_share(rel or "", int(uploaded_by_share_id))
    return False


def thumb_dir() -> Path:
    """缩略图目录（可在设置中改为外接盘路径）。"""
    d = config.thumb_root
    d.mkdir(parents=True, exist_ok=True)
    return d

def _index_upsert(
    rel: str | None,
    *,
    uploaded_by_share_id: int | None = None,
    content_hash: str | None = None,
) -> None:
    if not rel:
        return
    try:
        from . import media_index

        media_index.upsert_media(
            rel,
            uploaded_by_share_id=uploaded_by_share_id,
            content_hash=content_hash,
        )
    except Exception:
        pass


def _index_delete(rel: str | None) -> None:
    if not rel:
        return
    try:
        from . import media_index

        media_index.delete_media(rel)
    except Exception:
        pass


def _index_move(old_rel: str | None, new_rel: str | None) -> None:
    if old_rel and new_rel and old_rel != new_rel:
        try:
            from . import media_index

            media_index.move_media(old_rel, new_rel)
            return
        except Exception:
            pass
    if new_rel:
        _index_upsert(new_rel)
    if old_rel and old_rel != new_rel:
        _index_delete(old_rel)


def _safe_under(root: Path, path: Path) -> Path:
    root = root.resolve()
    full = path if path.is_absolute() else (root / path)
    full = full.resolve()
    if root != full and root not in full.parents:
        raise ValueError(f"路径越界: {path}")
    return full


def album_path(rel: str | Path) -> Path:
    return _safe_under(config.album_root, Path(rel))


def canonicalize_album_rel(album_rel: str) -> str:
    """旁白伴生名 foo.jpg.narration.m4a → 主图 foo.jpg，避免灯箱把音频当图片。"""
    rel = (album_rel or "").replace("\\", "/").lstrip("/")
    name = Path(rel).name
    marker = ".narration."
    if marker not in name:
        return rel
    orig = name.split(marker, 1)[0]
    parent = str(Path(rel).parent).replace("\\", "/")
    if not orig:
        return rel
    if parent in ("", "."):
        return orig
    return f"{parent}/{orig}"


def import_path(rel: str | Path) -> Path:
    return _safe_under(config.import_root, Path(rel))


def save_uploads(items: list[tuple[str, bytes]]) -> dict:
    """把拖入的单张或整个目录写入导入目录，保留相对路径。"""
    root = config.import_root
    root.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []
    skipped: list[str] = []
    for rel, data in items:
        rel = (rel or "").replace("\\", "/").strip().lstrip("/")
        parts = [p for p in Path(rel).parts if p not in ("", ".", "..")]
        if not parts:
            skipped.append(rel or "(空路径)")
            continue
        name = parts[-1]
        if Path(name).suffix.lower() not in MEDIA_EXTS:
            skipped.append("/".join(parts))
            continue
        dest = root.joinpath(*parts)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest, _ = unique_path(dest)
        dest.write_bytes(data)
        from .ops import ensure_host_perms
        ensure_host_perms(dest.parent, is_dir=True)
        ensure_host_perms(dest)
        saved.append(str(dest.relative_to(root)).replace("\\", "/"))
    invalidate_import_list_cache()
    return {"ok": True, "saved": saved, "skipped": skipped, "count": len(saved)}


def list_import_images(*, with_meta: bool = False) -> list[dict]:
    """列出待入库媒体。默认不读 EXIF（数百文件时很快）；点「解析」再 with_meta。"""
    global _IMPORT_LIST_MEM
    if not with_meta:
        with _IMPORT_LIST_LOCK:
            mem = _IMPORT_LIST_MEM
            if mem and (time.monotonic() - mem[0]) < _IMPORT_LIST_TTL:
                return deepcopy(mem[1])
    root = config.import_root
    if not root.exists():
        return []
    # 一次扫描同时收集 HEIC stem 与媒体项
    heic_stems: set[str] = set()
    media_files: list[Path] = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        suf = p.suffix.lower()
        if suf in {".heic", ".heif"}:
            heic_stems.add(p.stem.lower())
        if is_media(p):
            media_files.append(p)
    media_files.sort()
    items = []
    for p in media_files:
        rel = str(p.relative_to(root)).replace("\\", "/")
        if with_meta:
            meta = read_meta(p)
        else:
            # 不读 EXIF 时也先用文件名上的时间/简述填待入库列表
            guessed = guess_datetime_from_name(p.name) or guess_datetime_from_name(rel)
            meta = PhotoMeta(
                datetime=guessed.strftime("%Y-%m-%d %H:%M:%S") if guessed else None,
                title=parse_title_from_filename(p.name),
            )
        kind = "video" if is_video(p) else "image"
        live_companion = bool(
            is_video(p)
            and p.suffix.lower() == ".mov"
            and p.stem.lower() in heic_stems
        )
        items.append(
            {
                "path": rel,
                "name": p.name,
                "size": p.stat().st_size,
                "kind": kind,
                "meta": meta.to_dict(),
                "live_companion": live_companion,
                "content_hash": None,
                "duplicate": False,
                "duplicate_of": [],
                "inbox_duplicate": False,
                "inbox_duplicate_of": [],
            }
        )
    if not with_meta:
        with _IMPORT_LIST_LOCK:
            _IMPORT_LIST_MEM = (time.monotonic(), deepcopy(items))
    return items


def invalidate_import_list_cache() -> None:
    global _IMPORT_LIST_MEM
    with _IMPORT_LIST_LOCK:
        _IMPORT_LIST_MEM = None


def _hash_cache_path() -> Path:
    return config.thumb_root.parent / "import_hash_cache.json"


def _load_hash_cache() -> dict[str, dict]:
    global _HASH_CACHE_MEM
    with _HASH_CACHE_LOCK:
        if _HASH_CACHE_MEM is not None:
            return _HASH_CACHE_MEM
        path = _hash_cache_path()
        data: dict[str, dict] = {}
        if path.is_file():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    data = {str(k): v for k, v in raw.items() if isinstance(v, dict)}
            except (OSError, json.JSONDecodeError, TypeError):
                data = {}
        _HASH_CACHE_MEM = data
        return data


def _save_hash_cache(cache: dict[str, dict]) -> None:
    global _HASH_CACHE_MEM
    with _HASH_CACHE_LOCK:
        _HASH_CACHE_MEM = cache
        path = _hash_cache_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass


def _cached_content_hash(
    rel: str, src: Path, cache: dict[str, dict], dirty: list[bool], *, compute: bool = True
) -> str | None:
    """按 path+size+mtime 复用 MD5；文件未变则跳过重算。"""
    try:
        st = src.stat()
    except OSError:
        return None
    if st.st_size < 64:
        return None
    hit = cache.get(rel) or {}
    from .naming import CONTENT_HASH_ALGO

    if (
        hit.get("algo") == CONTENT_HASH_ALGO
        and hit.get("size") == st.st_size
        and hit.get("mtime") == int(st.st_mtime)
        and isinstance(hit.get("hash"), str)
        and len(hit["hash"]) == 32
    ):
        return hit["hash"].lower()
    if not compute:
        return None
    from .ops import content_hash_of

    h = content_hash_of(src)
    cache[rel] = {
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "hash": h,
        "algo": CONTENT_HASH_ALGO,
    }
    dirty[0] = True
    return h


def _fill_import_meta(items: list[dict]) -> None:
    """并行读 EXIF（JPEG 快路径为主）；缺失文件跳过。"""
    if not items:
        return

    def one(it: dict) -> None:
        rel = it.get("path") or ""
        try:
            src = import_path(rel)
            if not src.is_file():
                return
            it["meta"] = read_meta(src).to_dict()
            it["size"] = src.stat().st_size
        except Exception:
            pass

    workers = 1 if len(items) < 8 else _PARSE_WORKERS
    if workers == 1:
        for it in items:
            one(it)
        return
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, items))


def _annotate_import_duplicates(items: list[dict]) -> list[dict]:
    """解析阶段：计算 MD5，与相册库 / 待入库批次内比对并标记重复。"""
    from .ops import find_existing_by_hash

    album_map: dict[str, list[str]] = {}
    try:
        from . import media_index

        album_map = media_index.content_hash_path_map()
    except Exception:
        album_map = {}

    cache = _load_hash_cache()
    dirty = [False]
    cache_lock = threading.Lock()

    def hash_one(it: dict) -> tuple[dict, str | None]:
        rel = it.get("path") or ""
        try:
            src = import_path(rel)
            if not src.is_file():
                return it, None
            if src.stat().st_size < 64:
                return it, None
            with cache_lock:
                h = _cached_content_hash(rel, src, cache, dirty)
            return it, h
        except Exception:
            return it, None

    workers = 1 if len(items) < 6 else _PARSE_WORKERS
    hashed: list[tuple[dict, str | None]] = []
    if workers == 1:
        hashed = [hash_one(it) for it in items]
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            hashed = list(pool.map(hash_one, items))

    if dirty[0]:
        if len(cache) > 5000:
            overflow = len(cache) - 4000
            for k in list(cache.keys())[:overflow]:
                cache.pop(k, None)
        _save_hash_cache(cache)

    by_hash: dict[str, list[int]] = {}
    # 保持原 items 顺序索引
    index_of = {id(it): i for i, it in enumerate(items)}
    for it, h in hashed:
        i = index_of.get(id(it))
        if i is None:
            continue
        if not h:
            it["content_hash"] = None
            continue
        it["content_hash"] = h
        album_hits = album_map.get(h) or []
        if not album_hits and not album_map:
            # 索引为空时仍走旧兜底
            try:
                album_hits = find_existing_by_hash(h)
            except Exception:
                album_hits = []
        it["duplicate_of"] = list(album_hits)
        it["duplicate"] = bool(album_hits)

        peers = by_hash.get(h) or []
        it["inbox_duplicate"] = bool(peers)
        it["inbox_duplicate_of"] = [items[j]["path"] for j in peers]
        for j in peers:
            items[j]["inbox_duplicate"] = True
            items[j]["inbox_duplicate_of"] = [
                items[k]["path"] for k in peers + [i] if k != j
            ]
        by_hash.setdefault(h, []).append(i)
    return items


def parse_import_meta(*, offset: int = 0, limit: int | None = None, paths: list[str] | None = None) -> dict:
    """重读 EXIF，并与已入库指纹比对，标记重复项。

    支持分片：offset/limit，便于前端显示进度、避免一次卡死。
    paths 非空时只解析这些相对路径（上传结束后不必重扫整个待入库）。
    """
    all_items = list_import_images(with_meta=False)
    want: set[str] | None = None
    if paths:
        want = {str(p).replace("\\", "/").strip().lstrip("/") for p in paths if p}
        want.discard("")
        work = [it for it in all_items if it.get("path") in want] if want else all_items
    else:
        work = all_items
    total = len(work)
    off = max(0, int(offset or 0))
    if limit is None or int(limit) <= 0:
        chunk = work[off:]
        lim = len(chunk)
    else:
        lim = max(1, min(int(limit), 200))
        chunk = work[off : off + lim]
    _fill_import_meta(chunk)
    _annotate_import_duplicates(chunk)
    if want:
        cache = _load_hash_cache()
        dirty = [False]
        peer_by_hash: dict[str, list[str]] = {}
        for it in all_items:
            rel = it.get("path") or ""
            h = (it.get("content_hash") or "").lower()
            if not h:
                try:
                    src = import_path(rel)
                    if src.is_file():
                        h = (_cached_content_hash(rel, src, cache, dirty, compute=False) or "").lower()
                except Exception:
                    h = ""
            if h:
                peer_by_hash.setdefault(h, []).append(rel)
        for it in chunk:
            h = (it.get("content_hash") or "").lower()
            if not h:
                continue
            peers = [p for p in peer_by_hash.get(h, []) if p != it.get("path")]
            if peers:
                it["inbox_duplicate"] = True
                it["inbox_duplicate_of"] = peers
    done = off + len(chunk) >= total
    album_dups = sum(1 for x in chunk if x.get("duplicate"))
    inbox_dups = sum(1 for x in chunk if x.get("inbox_duplicate") and not x.get("duplicate"))
    return {
        "items": chunk,
        "offset": off,
        "limit": lim,
        "total": total,
        "processed": off + len(chunk),
        "done": done,
        "duplicate_album": album_dups,
        "duplicate_inbox": inbox_dups,
    }

def ingest_one(
    source_rel: str,
    *,
    datetime_str: str | None,
    title: str | None,
    description: str | None = None,
    reflection: str | None = None,
    location: str | None = None,
    from_import: bool = True,
    uploaded_by_share_id: int | None = None,
    content_hash: str | None = None,
    skip_meta_read: bool = False,
) -> dict:
    src = import_path(source_rel) if from_import else album_path(source_rel)
    if not src.exists() or not is_media(src):
        raise FileNotFoundError(f"找不到媒体: {source_rel}")

    # 前端已解析并提交字段时跳过二次 EXIF 解码（仍可读轻量补全由 skip 关闭时处理）
    if skip_meta_read and datetime_str and (title is not None):
        meta = PhotoMeta(
            datetime=datetime_str,
            title=title or None,
            description=description or None,
            reflection=reflection or None,
            location=location or None,
        )
    else:
        meta = read_meta(src)
    dt = (
        parse_datetime(datetime_str)
        or parse_datetime(meta.datetime)
        or guess_datetime_from_name(src.name)
        or guess_datetime_from_name(source_rel)
        or datetime.now()
    )
    title_final = sanitize_title(title if title is not None else meta.title, config.title_max_len)

    meta.datetime = dt.strftime("%Y-%m-%d %H:%M:%S")
    meta.title = title_final
    if description is not None:
        meta.description = description or None
    if reflection is not None:
        meta.reflection = reflection or None
    if location is not None:
        meta.location = location or None

    # Write meta first on a working copy in temp area under album, then move
    from .ops import content_hash_of, ensure_host_perms, find_existing_by_hash

    h = (content_hash or "").strip().lower()
    if len(h) == 32 and all(c in "0123456789abcdef" for c in h):
        content_hash = h
    else:
        content_hash = content_hash_of(src)
    short_hash = content_hash[:8]
    if from_import:
        existed = find_existing_by_hash(content_hash)
        if existed:
            # 相册已有相同内容：仍视为处理成功，并从待入库区清掉源文件
            _remove_import_source(src)
            return {
                "ok": True,
                "skipped": True,
                "duplicate": True,
                "path": existed[0],
                "duplicates": existed,
                "message": f"已存在相同内容，跳过入库并已从待入库移除 → {existed[0]}",
            }
    rel = build_rel_path(
        dt,
        title_final,
        src.suffix,
        config.title_max_len,
        content_hash=short_hash,
    )
    dest_dir = config.album_root / rel.parent
    dest_dir.mkdir(parents=True, exist_ok=True)
    ensure_host_perms(dest_dir, is_dir=True)
    dest, renamed = unique_path(config.album_root / rel, ignore=src)

    # If source is already the dest, just update meta
    if src.resolve() == dest.resolve():
        write_meta(src, meta)
        return {
            "ok": True,
            "path": str(dest.relative_to(config.album_root)).replace("\\", "/"),
            "renamed": False,
            "message": "已更新元数据",
        }

    # 同盘优先 rename（待入库与相册都在 1T 盘时几乎瞬时）；跨盘再 copy
    src_is_video = is_video(src)
    src_is_heic = src.suffix.lower() in {".heic", ".heif"}
    src_parent = src.parent
    moved = False
    try:
        os.replace(src, dest)
        moved = True
    except OSError:
        shutil.copy2(src, dest)
    live_msg = ""
    live_dest = None
    try:
        from .video import sidecar_path, write_sidecar

        if src_is_video or src_is_heic:
            src_side = sidecar_path(src_parent / src.name)
            if src_side.exists():
                shutil.copy2(src_side, sidecar_path(dest))
                if moved:
                    try:
                        src_side.unlink(missing_ok=True)
                    except OSError:
                        pass

        # Live Photo：同名 MOV 随 HEIC 无损旁路保存
        if src_is_heic and from_import:
            for ext in (".MOV", ".mov"):
                companion = src_parent / (src.stem + ext)
                if companion.exists() and companion.is_file():
                    live_dest = dest.with_name(dest.name + ".live.mov")
                    try:
                        os.replace(companion, live_dest)
                    except OSError:
                        shutil.copy2(companion, live_dest)
                        try:
                            companion.unlink(missing_ok=True)
                        except OSError:
                            pass
                    live_msg = "（含实况视频）"
                    break

        write_meta(dest, meta)
        if live_dest is not None and live_dest.exists():
            write_sidecar(
                dest,
                meta,
                {"kind": "heic", "live_video": live_dest.name},
            )

        if not moved and src.resolve() != dest.resolve():
            if not from_import:
                move_companions(src, dest)
            side_to_drop = sidecar_path(src) if (src_is_video or src_is_heic) else None
            src.unlink(missing_ok=True)
            if side_to_drop and side_to_drop.exists():
                side_to_drop.unlink(missing_ok=True)
        stop_root = config.import_root if from_import else config.album_root
        _cleanup_empty_parents(src if src.exists() else src_parent / ".keep", stop_root)
    except Exception:
        if dest.exists() and src.exists():
            dest.unlink(missing_ok=True)
            orphan = dest.with_name(dest.name + ".live.mov")
            if orphan.exists():
                orphan.unlink(missing_ok=True)
        raise

    ensure_host_perms(dest)
    live_check = dest.with_name(dest.name + ".live.mov")
    if live_check.exists():
        ensure_host_perms(live_check)
    new_rel = str(dest.relative_to(config.album_root)).replace("\\", "/")
    old_rel = None
    if not from_import:
        try:
            old_rel = str(src.relative_to(config.album_root)).replace("\\", "/")
        except ValueError:
            old_rel = None
    if old_rel and old_rel != new_rel:
        _index_move(old_rel, new_rel)
        try:
            from . import media_index

            media_index.set_content_hash(new_rel, content_hash)
        except Exception:
            pass
    else:
        # 入库时同步写入完整 MD5，供查重直接读库
        _index_upsert(
            new_rel,
            uploaded_by_share_id=uploaded_by_share_id,
            content_hash=content_hash,
        )

    if from_import:
        invalidate_import_list_cache()

    return {
        "ok": True,
        "path": new_rel,
        "renamed": renamed,
        "message": "入库成功"
        + ("（已自动加序号避免重名）" if renamed else "")
        + live_msg,
    }


def _cleanup_empty_parents(file_path: Path, stop_at: Path) -> None:
    stop_at = stop_at.resolve()
    parent = file_path.parent.resolve()
    while parent != stop_at and stop_at in parent.parents:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def _remove_import_source(src: Path) -> None:
    """从待入库区删除主文件及伴生 sidecar / Live Photo MOV。"""
    try:
        from .video import sidecar_path

        side = sidecar_path(src)
        if side.is_file():
            side.unlink(missing_ok=True)
    except Exception:
        pass
    if src.suffix.lower() in {".heic", ".heif"}:
        for ext in (".MOV", ".mov"):
            companion = src.with_name(src.stem + ext)
            if companion.is_file():
                try:
                    companion.unlink(missing_ok=True)
                except OSError:
                    pass
    try:
        src.unlink(missing_ok=True)
    except OSError:
        pass
    _cleanup_empty_parents(src, config.import_root)


def discard_import(*, paths: list[str] | None = None, all_items: bool = False) -> dict:
    """从待入库区删除文件（不进相册）。HEIC 会连带删同名实况 MOV。"""
    root = config.import_root
    if not root.exists():
        return {"ok": True, "removed": 0, "paths": []}

    targets: list[Path] = []
    if all_items:
        targets = [p for p in root.rglob("*") if p.is_file() and is_media(p)]
    else:
        seen: set[str] = set()
        for rel in paths or []:
            rel = str(rel or "").replace("\\", "/").strip().lstrip("/")
            if not rel or rel in seen:
                continue
            seen.add(rel)
            try:
                fp = import_path(rel)
            except ValueError:
                continue
            if fp.is_file():
                targets.append(fp)

    removed: list[str] = []
    for src in targets:
        try:
            rel = str(src.relative_to(root)).replace("\\", "/")
        except ValueError:
            continue
        # HEIC：连带实况伴生 MOV
        if src.suffix.lower() in {".heic", ".heif"}:
            for ext in (".MOV", ".mov"):
                companion = src.with_name(src.stem + ext)
                if companion.is_file():
                    try:
                        companion.unlink(missing_ok=True)
                        removed.append(
                            str(companion.relative_to(root)).replace("\\", "/")
                        )
                    except OSError:
                        pass
        try:
            from .video import sidecar_path

            side = sidecar_path(src)
            if side.is_file():
                side.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            src.unlink(missing_ok=True)
            removed.append(rel)
            _cleanup_empty_parents(src, root)
        except OSError:
            pass

    invalidate_import_list_cache()
    return {"ok": True, "removed": len(removed), "paths": removed}

def rearrange(
    album_rel: str,
    *,
    datetime_str: str | None = None,
    title: str | None = None,
    description: str | None = None,
    reflection: str | None = None,
    location: str | None = None,
) -> dict:
    return ingest_one(
        album_rel,
        datetime_str=datetime_str,
        title=title,
        description=description,
        reflection=reflection,
        location=location,
        from_import=False,
    )


def update_meta_only(album_rel: str, fields: dict) -> dict:
    need_move = ("datetime" in fields) or ("title" in fields)
    # 改时间/简述会重排目录：直接走 rearrange，避免先写一遍元数据再整文件搬迁
    if need_move:
        return rearrange(
            album_rel,
            datetime_str=fields.get("datetime"),
            title=fields.get("title"),
            description=fields.get("description"),
            reflection=fields.get("reflection"),
            location=fields.get("location"),
        )
    path = album_path(album_rel)
    meta = apply_meta_dict(path, fields)
    try:
        from . import media_index

        patch = {}
        for key in ("datetime", "title", "description", "location"):
            if key in fields:
                patch[key] = getattr(meta, key, None)
        if "location" in fields:
            patch["lat"] = meta.lat
            patch["lng"] = meta.lng
        media_index.patch_media_meta(album_rel, patch)
    except Exception:
        _index_upsert(album_rel)
    return {
        "ok": True,
        "path": album_rel,
        "renamed": False,
        "message": "元数据已保存",
        "meta": meta.to_dict(),
    }


def update_meta_batch(paths: list[str], fields: dict) -> dict:
    """批量更新已入库照片元数据；fields 仅包含需要改的键。"""
    clean = dict(fields or {})
    if not clean:
        return {"ok": False, "results": [], "message": "没有可应用的字段"}
    need_move = ("datetime" in clean) or ("title" in clean)
    results = []
    for rel in paths:
        try:
            if need_move:
                r = rearrange(
                    rel,
                    datetime_str=clean.get("datetime"),
                    title=clean.get("title"),
                    description=clean.get("description"),
                    reflection=clean.get("reflection"),
                    location=clean.get("location"),
                )
                results.append(
                    {
                        "ok": True,
                        "path": r.get("path", rel),
                        "message": r.get("message", ""),
                        "renamed": bool(r.get("renamed")),
                    }
                )
            else:
                path = album_path(rel)
                meta = apply_meta_dict(path, clean)
                try:
                    from . import media_index

                    patch = {}
                    for key in ("datetime", "title", "description", "location"):
                        if key in clean:
                            patch[key] = getattr(meta, key, None)
                    if "location" in clean:
                        patch["lat"] = meta.lat
                        patch["lng"] = meta.lng
                    media_index.patch_media_meta(rel, patch, invalidate=False)
                except Exception:
                    _index_upsert(rel)
                results.append(
                    {
                        "ok": True,
                        "path": rel,
                        "message": "元数据已保存",
                        "renamed": False,
                    }
                )
        except Exception as e:
            results.append({"ok": False, "path": rel, "message": str(e)})
    if not need_move:
        try:
            from . import media_index

            media_index.invalidate_browse_caches()
        except Exception:
            pass
    ok_n = sum(1 for r in results if r["ok"])
    return {
        "ok": ok_n == len(results),
        "results": results,
        "message": f"成功 {ok_n}/{len(results)}",
        "need_move": need_move,
    }


def scan_timeline() -> dict:
    try:
        from . import media_index

        media_index.ensure_index_ready()
        indexed = media_index.timeline_from_index()
        if indexed is not None:
            return indexed
    except Exception:
        pass
    return _scan_timeline_fs()


def timeline_outline(
    scopes: list | None = None,
    media_paths: list | None = None,
    uploaded_by_share_id: int | None = None,
    *,
    brief: bool = False,
) -> dict:
    try:
        from . import media_index

        media_index.ensure_index_ready()
        return media_index.timeline_outline(
            scopes=scopes,
            media_paths=media_paths,
            uploaded_by_share_id=uploaded_by_share_id,
            brief=brief,
        )
    except Exception:
        data = _scan_timeline_fs()
        years = []
        total = 0
        for y in data.get("years") or []:
            months = []
            y_photos = 0
            y_img = 0
            y_vid = 0
            titles: dict[str, int] = {}
            for m in y.get("months") or []:
                photos = list(m.get("photos") or [])
                if scopes or media_paths or uploaded_by_share_id:
                    photos = [
                        ph
                        for ph in photos
                        if _path_visible(
                            ph.get("path") or "",
                            scopes,
                            media_paths,
                            uploaded_by_share_id,
                        )
                    ]
                img = sum(1 for p in photos if p.get("kind") != "video")
                vid = len(photos) - img
                months.append(
                    {
                        "month": m.get("month"),
                        "photo_count": len(photos),
                        "image_count": img,
                        "video_count": vid,
                    }
                )
                y_photos += len(photos)
                y_img += img
                y_vid += vid
                for p in photos:
                    t = ((p.get("meta") or {}).get("title") or "").strip()
                    if t:
                        titles[t] = titles.get(t, 0) + 1
            if not y_photos:
                continue
            top = sorted(titles.items(), key=lambda x: (-x[1], x[0]))[:5]
            years.append(
                {
                    "year": y.get("year"),
                    "photo_count": y_photos,
                    "image_count": y_img,
                    "video_count": y_vid,
                    "month_count": len(months),
                    "top_titles": [t for t, _ in top],
                    "months": months,
                }
            )
            total += y_photos
        return {"years": years, "total": total, "from_index": False}


def timeline_month(
    month: str,
    *,
    limit: int = 200,
    offset: int = 0,
    scopes: list | None = None,
    media_paths: list | None = None,
    uploaded_by_share_id: int | None = None,
    kind: str | None = None,
) -> dict:
    try:
        from . import media_index

        media_index.ensure_index_ready()
        if media_index.index_count() > 0:
            return media_index.timeline_month(
                month,
                limit=limit,
                offset=offset,
                scopes=scopes,
                media_paths=media_paths,
                uploaded_by_share_id=uploaded_by_share_id,
                kind=kind,
            )
    except Exception:
        pass
    data = _scan_timeline_fs()
    photos = []
    for y in data.get("years") or []:
        for m in y.get("months") or []:
            if m.get("month") == month:
                photos = list(m.get("photos") or [])
                break
    if scopes or media_paths or uploaded_by_share_id:
        photos = [
            ph
            for ph in photos
            if _path_visible(
                ph.get("path") or "", scopes, media_paths, uploaded_by_share_id
            )
        ]
    k = (kind or "").strip().lower()
    if k == "video":
        photos = [ph for ph in photos if (ph.get("kind") == "video")]
    elif k == "image":
        photos = [ph for ph in photos if (ph.get("kind") != "video")]
    total = len(photos)
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    chunk = photos[offset : offset + limit]
    return {
        "month": month,
        "year": month[:4] if len(month) >= 4 else "",
        "photos": chunk,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(chunk) < total,
        "from_index": False,
        "kind": kind or "all",
    }


def timeline_paths(
    *,
    year: str | None = None,
    month: str | None = None,
    scopes: list | None = None,
    media_paths: list | None = None,
    uploaded_by_share_id: int | None = None,
    kind: str | None = None,
) -> dict:
    try:
        from . import media_index

        media_index.ensure_index_ready()
        if media_index.index_count() > 0:
            return media_index.timeline_paths(
                year=year,
                month=month,
                scopes=scopes,
                media_paths=media_paths,
                uploaded_by_share_id=uploaded_by_share_id,
                kind=kind,
            )
    except Exception:
        pass
    data = _scan_timeline_fs()
    paths = []
    k = (kind or "").strip().lower()
    for y in data.get("years") or []:
        if year and y.get("year") != year:
            continue
        for m in y.get("months") or []:
            if month and m.get("month") != month:
                continue
            for ph in m.get("photos") or []:
                p = ph.get("path") or ""
                if scopes or media_paths or uploaded_by_share_id:
                    if not _path_visible(p, scopes, media_paths, uploaded_by_share_id):
                        continue
                if k == "video" and ph.get("kind") != "video":
                    continue
                if k == "image" and ph.get("kind") == "video":
                    continue
                paths.append(p)
    return {"paths": paths, "total": len(paths), "from_index": False, "kind": kind or "all"}


def map_summary(
    scopes: list | None = None,
    media_paths: list | None = None,
    uploaded_by_share_id: int | None = None,
) -> dict:
    try:
        from . import media_index

        media_index.ensure_index_ready()
        if media_index.index_count() > 0:
            return media_index.map_summary(
                scopes=scopes,
                media_paths=media_paths,
                uploaded_by_share_id=uploaded_by_share_id,
            )
    except Exception:
        pass
    data = _list_map_photos_fs()
    points = data.get("points") or []
    if scopes or media_paths or uploaded_by_share_id:
        points = [
            pt
            for pt in points
            if _path_visible(
                pt.get("path") or "", scopes, media_paths, uploaded_by_share_id
            )
        ]
    lats = [p["lat"] for p in points]
    lngs = [p["lng"] for p in points]
    return {
        "total": int(data.get("total") or len(points)),
        "points": len(points),
        "skipped": int(data.get("skipped") or 0),
        "scope": data.get("scope") or "china",
        "has_foreign": bool(data.get("has_foreign")),
        "bounds": (
            {
                "south": min(lats),
                "west": min(lngs),
                "north": max(lats),
                "east": max(lngs),
            }
            if points
            else None
        ),
        "from_index": False,
    }


def map_clusters(
    zoom: int,
    *,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
    scopes: list | None = None,
    media_paths: list | None = None,
    uploaded_by_share_id: int | None = None,
    limit: int = 800,
    kind: str | None = None,
) -> dict:
    try:
        from . import media_index

        media_index.ensure_index_ready()
        if media_index.index_count() > 0:
            return media_index.map_clusters(
                zoom,
                west=west,
                south=south,
                east=east,
                north=north,
                scopes=scopes,
                media_paths=media_paths,
                uploaded_by_share_id=uploaded_by_share_id,
                limit=limit,
                kind=kind,
            )
    except Exception:
        pass
    data = list_map_photos(kind=kind)
    points = data.get("points") or []
    if scopes or media_paths or uploaded_by_share_id:
        points = [
            pt
            for pt in points
            if _path_visible(
                pt.get("path") or "", scopes, media_paths, uploaded_by_share_id
            )
        ]
    from .media_index import _map_cell

    cell = _map_cell(zoom)
    buckets: dict = {}
    for p in points:
        if west is not None and south is not None and east is not None and north is not None:
            if not (
                float(south) - cell <= p["lat"] <= float(north) + cell
                and float(west) - cell <= p["lng"] <= float(east) + cell
            ):
                continue
        gy = round(p["lat"] / cell)
        gx = round(p["lng"] / cell)
        key = (gy, gx)
        b = buckets.setdefault(key, {"photos": [], "lat": 0.0, "lng": 0.0})
        b["photos"].append(p)
        b["lat"] += p["lat"]
        b["lng"] += p["lng"]
    clusters = []
    for (gy, gx), b in list(buckets.items()):
        photos = sorted(
            b["photos"],
            key=lambda x: ((x.get("meta") or {}).get("datetime") or ""),
            reverse=True,
        )
        clusters.append(
            {
                "lat": b["lat"] / len(photos),
                "lng": b["lng"] / len(photos),
                "count": len(photos),
                "gy": int(gy),
                "gx": int(gx),
                "cell": cell,
                "cover": photos[0],
            }
        )
    clusters.sort(key=lambda c: -c["count"])
    return {"clusters": clusters[:limit], "zoom": int(zoom), "cell": cell, "from_index": False}


def map_cluster_photos(
    *,
    gy: int,
    gx: int,
    cell: float,
    limit: int = 200,
    offset: int = 0,
    scopes: list | None = None,
    media_paths: list | None = None,
    uploaded_by_share_id: int | None = None,
) -> dict:
    try:
        from . import media_index

        media_index.ensure_index_ready()
        if media_index.index_count() > 0:
            return media_index.map_cluster_photos(
                gy=gy,
                gx=gx,
                cell=cell,
                limit=limit,
                offset=offset,
                scopes=scopes,
                media_paths=media_paths,
                uploaded_by_share_id=uploaded_by_share_id,
            )
    except Exception:
        pass
    return {
        "photos": [],
        "total": 0,
        "offset": 0,
        "limit": limit,
        "has_more": False,
        "lat": 0,
        "lng": 0,
        "count": 0,
        "gy": gy,
        "gx": gx,
        "cell": cell,
        "from_index": False,
    }


def _scan_timeline_fs() -> dict:
    root = config.album_root
    years: dict[str, dict[str, list[dict]]] = {}
    if not root.exists():
        return {"years": []}

    for p in sorted(root.rglob("*")):
        if not is_media(p):
            continue
        # 旁白旁路不是独立媒资
        if ".narration." in p.name:
            continue
        # skip non-library folders
        parts = p.relative_to(root).parts
        if not parts:
            continue
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
            continue
        if not parts[0].isdigit() or len(parts[0]) != 4:
            continue

        rel = str(p.relative_to(root)).replace("\\", "/")
        meta = read_meta(p)
        year = parts[0]
        month = parts[1] if len(parts) > 1 else f"{year}-01"
        years.setdefault(year, {}).setdefault(month, []).append(
            {
                "path": rel,
                "name": p.name,
                "kind": "video" if is_video(p) else "image",
                "meta": meta.to_dict(),
            }
        )

    result = []
    for year in sorted(years.keys(), reverse=True):
        months = []
        for month in sorted(years[year].keys(), reverse=True):
            months.append({"month": month, "photos": years[year][month]})
        result.append({"year": year, "months": months})
    return {"years": result}


def list_map_photos(kind: str | None = None) -> dict:
    """返回带坐标的照片点位（GPS 优先，其次根据地点文本匹配）。"""
    try:
        from . import media_index

        media_index.ensure_index_ready()
        indexed = media_index.map_points_from_index(kind=kind)
        if indexed is not None:
            return indexed
    except Exception:
        pass
    return _list_map_photos_fs()


def _list_map_photos_fs() -> dict:
    """返回带坐标的照片点位（GPS 优先，其次根据地点文本匹配）。"""
    root = config.album_root
    points = []
    skipped = 0
    if not root.exists():
        return {
            "points": [],
            "skipped": 0,
            "total": 0,
            "scope": "china",
            "has_foreign": False,
            "map_mode": "offline",
        }

    for p in sorted(root.rglob("*")):
        if not is_media(p):
            continue
        if ".narration." in p.name:
            continue
        parts = p.relative_to(root).parts
        if not parts or not parts[0].isdigit() or len(parts[0]) != 4:
            continue
        if parts[0] in {"app", "data", "inbox", "_staging"}:
            continue
        rel = str(p.relative_to(root)).replace("\\", "/")
        meta = read_meta(p)
        lat, lng = meta.lat, meta.lng
        source = "gps"
        if lat is None or lng is None:
            resolved = resolve_location(meta.location)
            if resolved:
                lat, lng = resolved
                source = "place"
            else:
                skipped += 1
                continue
        points.append(
            {
                "path": rel,
                "name": p.name,
                "lat": lat,
                "lng": lng,
                "source": source,
                "kind": "video" if is_video(p) else "image",
                "meta": {
                    "title": meta.title,
                    "location": meta.location,
                    "datetime": meta.datetime,
                },
            }
        )

    # 中国大致范围（含港澳台近海）；任一不在此范围则按世界视野
    def _in_china(lat: float, lng: float) -> bool:
        # 南界约海南三亚；过低会把泰国中心点误判成「国内」
        return 18.0 <= lat <= 54.5 and 73.0 <= lng <= 135.5

    has_foreign = any(not _in_china(p["lat"], p["lng"]) for p in points)
    return {
        "points": points,
        "skipped": skipped,
        "total": len(points) + skipped,
        "scope": "world" if has_foreign else "china",
        "has_foreign": has_foreign,
        "map_mode": "offline",
    }


def get_photo(album_rel: str) -> dict:
    album_rel = canonicalize_album_rel(album_rel)
    path = album_path(album_rel)
    if not path.exists() or not is_media(path) or ".narration." in path.name:
        raise FileNotFoundError(album_rel)

    # 优先读索引：减少灯箱翻页时的 EXIF/ffprobe
    indexed = None
    try:
        from . import media_index

        indexed = media_index.lookup_media(album_rel)
    except Exception:
        indexed = None

    st = path.stat()
    kind = "video" if is_video(path) else "image"
    if indexed and indexed.get("kind"):
        kind = indexed["kind"] or kind

    if indexed and indexed.get("meta"):
        meta_dict = dict(indexed["meta"])
    else:
        meta_dict = read_meta(path).to_dict()

    out = {
        "path": album_rel,
        "name": path.name,
        "size": st.st_size,
        "kind": kind,
        "meta": meta_dict,
        "has_live": False,
        "live_video_path": None,
    }
    if kind == "video":
        from .video import cover_path, probe_duration, read_sidecar

        dur = indexed.get("duration") if indexed else None
        side = read_sidecar(path)
        if dur is None:
            dur = side.get("duration")
        if dur is None:
            dur = probe_duration(path)
        out["duration"] = dur
        out["cover_time"] = side.get("cover_time")
        out["has_cover"] = cover_path(path).exists()
    else:
        narr = narration_file(path)
        if narr and narr.is_file():
            from .video import probe_duration

            narr_rel = str(narr.relative_to(config.album_root)).replace("\\", "/")
            out["has_audio"] = True
            out["audio_path"] = narr_rel
            aud = indexed.get("audio_duration") if indexed else None
            if aud is None:
                aud = probe_duration(narr)
            out["audio_duration"] = aud
        else:
            out["has_audio"] = False
            out["audio_path"] = None
            out["audio_duration"] = None
        from .ops import live_video_for
        live = live_video_for(path)
        if live is not None:
            out["has_live"] = True
            out["live_video_path"] = str(live.relative_to(config.album_root)).replace("\\", "/")
    return out


def thumb_path_for(album_rel: str, size: int = 320) -> Path:
    key = hashlib.md5(f"{album_rel}:{size}".encode()).hexdigest()
    return thumb_dir() / f"{key}.jpg"


def normalize_thumb_size(size: int) -> int:
    """合并相近尺寸，减少树莓派上重复生成多种缩略图。

    含看图预览档（1280/1600），避免每次对单反原图现场解码。
    """
    s = int(size or 320)
    if s <= 160:
        return 160
    if s <= 360:
        return 320
    if s <= 720:
        return 640
    if s <= 1000:
        return 800
    if s <= 1440:
        return 1280
    return 1600


def invalidate_thumbs(album_rel: str) -> None:
    """删除某相对路径下所有可能生成过的缩略图缓存。"""
    if not album_rel:
        return
    rel = str(album_rel).replace("\\", "/")
    sizes = {160, 320, 640, 800, 1280, 1600, 2000}
    sizes.update(range(64, 801, 16))
    for size in sizes:
        p = thumb_path_for(rel, size)
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass
    if "\\" in str(album_rel) or "/" in rel:
        alt = str(album_rel).replace("/", "\\")
        if alt != rel:
            for size in sizes:
                p = thumb_path_for(alt, size)
                if p.exists():
                    try:
                        p.unlink()
                    except OSError:
                        pass


def _save_thumb_jpeg(im: Image.Image, out: Path, size: int) -> None:
    # EXIF 方向校正，避免预览/缩略图歪了还要二次请求
    try:
        from PIL import ImageOps
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    im = im.convert("RGB")
    # 树莓派：双线性更快；小图再降一点质量
    try:
        resample = Image.Resampling.BILINEAR
    except AttributeError:
        resample = Image.BILINEAR
    im.thumbnail((size, size), resample)
    if size <= 320:
        quality = 72
    elif size <= 800:
        quality = 78
    else:
        quality = 82  # 看图预览稍高一点
    out.parent.mkdir(parents=True, exist_ok=True)
    # optimize 在树莓派上很慢，大预览关掉
    im.save(out, "JPEG", quality=quality, optimize=(size <= 640), progressive=True)


def ensure_thumb(album_rel: str, size: int = 320) -> Path:
    size = normalize_thumb_size(size)
    src = album_path(album_rel)
    out = thumb_path_for(album_rel, size)
    if is_video(src):
        from .video import cover_path, extract_poster

        cover = cover_path(src)
        # 自定义封面优先
        if cover.exists():
            if (
                not out.exists()
                or cover.stat().st_mtime > out.stat().st_mtime
            ):
                with Image.open(cover) as im:
                    _save_thumb_jpeg(im, out, size)
            return out
        if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
            return out
        if extract_poster(src, out, size=size):
            return out
        im = Image.new("RGB", (size, size), (40, 48, 56))
        im.save(out, "JPEG", quality=72)
        return out
    if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
        return out
    from .heif_support import ensure_heif_support, is_heic_path

    if is_heic_path(src):
        ensure_heif_support()
    with Image.open(src) as im:
        # 大图先降采样读入，减轻树莓派内存/CPU（单反 20–45MP 尤其关键）
        try:
            im.draft("RGB", (size * 2, size * 2))
        except Exception:
            pass
        _save_thumb_jpeg(im, out, size)
    return out


def ensure_preview(album_rel: str, size: int = 1600) -> Path:
    """看图用预览 JPEG（落盘缓存，不改原件）。"""
    return ensure_thumb(album_rel, size=size)


def import_preview_path(import_rel: str, size: int) -> Path:
    key = hashlib.md5(f"import:{import_rel}:{size}".encode()).hexdigest()
    d = thumb_dir() / "import-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{key}.jpg"


def playable_path(source: str, rel: str, mtime: float, size: int) -> Path:
    from .video import playable_cache_key

    key = playable_cache_key(source, rel, mtime, size)
    d = thumb_dir() / "play-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{key}.mp4"


def ensure_playable(
    rel: str,
    source: str = "album",
    max_height: int = 1080,
    *,
    client_hevc: bool = False,
    client_h264: bool = False,
) -> Path:
    """返回浏览器可直接播放的文件路径（原件或转码缓存）。

    策略：能秒开就秒开（含 H.264 MOV），后台再预热 mp4 缓存；
    仅 HEVC 等必须转码的才阻塞等待。
    若客户端声明能播 HEVC（如 Safari），则直接返回原件，避免树莓派转码。
    """
    from .video import (
        ensure_browser_mp4,
        is_browser_native,
        is_stream_copy_ok,
        schedule_warm_playable,
        stream_codecs,
        video_readable,
    )

    if source == "import":
        src = import_path(rel)
    else:
        src = album_path(rel)
    if not src.exists() or not is_video(src):
        raise FileNotFoundError(rel)

    ok, reason = video_readable(src)
    if not ok:
        raise ValueError(f"视频无法播放：{reason}")

    st = src.stat()
    out = playable_path(source, rel, st.st_mtime, st.st_size)
    if out.exists() and out.stat().st_mtime >= st.st_mtime and out.stat().st_size > 1024:
        return out

    info = stream_codecs(src)
    v = (info.get("vcodec") or "").lower()
    # 客户端能解 HEVC：直接出原件，省掉 Pi 转码
    if client_hevc and v in {"hevc", "h265", "hev1", "hvc1"}:
        return src

    # 浏览器可直出：立刻返回原件，后台慢慢做 mp4 缓存
    if is_browser_native(src) or is_stream_copy_ok(src):
        if src.suffix.lower() != ".mp4":
            schedule_warm_playable(src, out, max_height=max_height)
        return src

    # 客户端声明 H.264 且源已是 H.264 容器怪异时仍优先原件
    if client_h264 and v in {"h264", "avc1", "avc"}:
        return src

    # 必须转码（如 HEVC on Chromium）：阻塞生成一次，之后走缓存
    return ensure_browser_mp4(src, out, max_height=max_height)


def ensure_import_preview(import_rel: str, size: int = 160) -> Path:
    """待入库区列表预览：落盘缓存；视频抽帧封面，图片缩略。"""
    size = normalize_thumb_size(size)
    src = import_path(import_rel)
    if not src.exists() or not is_media(src):
        raise FileNotFoundError(import_rel)
    out = import_preview_path(import_rel, size)
    if out.exists() and out.stat().st_mtime >= src.stat().st_mtime and out.stat().st_size > 50:
        return out

    if is_video(src):
        from .video import extract_poster

        # 待入库列表用较短超时，避免异常视频卡死 worker
        if extract_poster(src, out, size=size, timeout=45):
            return out
        im = Image.new("RGB", (size, size), (28, 42, 54))
        im.save(out, "JPEG", quality=72)
        return out

    from .heif_support import ensure_heif_support, is_heic_path

    if is_heic_path(src):
        ensure_heif_support()
    try:
        with Image.open(src) as im:
            try:
                im.draft("RGB", (size * 2, size * 2))
            except Exception:
                pass
            # GIF 等多帧：取第一帧
            try:
                im.seek(0)
            except Exception:
                pass
            _save_thumb_jpeg(im, out, size)
    except Exception:
        im = Image.new("RGB", (size, size), (36, 44, 54))
        im.save(out, "JPEG", quality=72)
    return out


def set_video_cover(album_rel: str, at_time: float) -> dict:
    from .video import set_cover_frame

    path = album_path(album_rel)
    result = set_cover_frame(path, float(at_time))
    invalidate_thumbs(album_rel)
    result["path"] = album_rel
    result["thumb"] = f"/api/thumb?path={album_rel}&size=240&t={int(path.stat().st_mtime)}"
    return result


# ----- 回收站 -----


def trash_root() -> Path:
    root = config.album_root / TRASH_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _companion_paths(media: Path) -> list[Path]:
    from .video import cover_path, sidecar_path

    out: list[Path] = []
    for p in (
        sidecar_path(media),
        cover_path(media),
        media.with_name(media.name + ".live.mov"),
    ):
        if p.exists() and p.is_file():
            out.append(p)
    out.extend(narration_files(media))
    # 去重保序
    seen: set[str] = set()
    uniq: list[Path] = []
    for p in out:
        key = str(p.resolve())
        if key in seen:
            continue
        seen.add(key)
        uniq.append(p)
    return uniq


def narration_files(media: Path) -> list[Path]:
    """旁白音频：{filename}.narration.{ext}"""
    if not media.parent.exists():
        return []
    return sorted(
        p
        for p in media.parent.glob(media.name + ".narration.*")
        if p.is_file()
        and p.suffix.lower() in {".webm", ".m4a", ".mp3", ".ogg", ".wav", ".aac", ".mp4"}
    )


def narration_file(media: Path) -> Path | None:
    files = narration_files(media)
    return files[0] if files else None


def narration_dest(media: Path, ext: str = ".webm") -> Path:
    ext = ext if ext.startswith(".") else f".{ext}"
    return media.with_name(media.name + ".narration" + ext.lower())


def _sniff_audio_ext(data: bytes, filename: str | None) -> str:
    allowed = {".webm", ".m4a", ".mp3", ".ogg", ".wav", ".aac", ".mp4"}
    name = Path(filename or "").name
    ext = Path(name).suffix.lower()
    if len(data) >= 8 and data[4:8] == b"ftyp":
        return ".m4a"
    if data.startswith(b"\x1aE\xdf\xa3"):
        return ".webm"
    if data.startswith(b"OggS"):
        return ".ogg"
    if data.startswith(b"ID3") or data[:2] == b"\xff\xfb":
        return ".mp3"
    if data.startswith(b"RIFF"):
        return ".wav"
    if ext == ".mp4":
        return ".m4a"
    if ext in allowed:
        return ext
    return ".m4a"


def _transcode_narration_m4a(data: bytes, src_ext: str) -> bytes | None:
    """转成 AAC/M4A，电脑 Chrome 与手机 Safari 都能播。"""
    import os
    import tempfile

    from .video import FFMPEG, _run

    suf = src_ext if str(src_ext).startswith(".") else f".{src_ext or 'bin'}"
    fd, inp = tempfile.mkstemp(suffix=suf)
    os.close(fd)
    outp = inp + ".m4a"
    try:
        Path(inp).write_bytes(data)
        r = _run(
            [
                FFMPEG,
                "-y",
                "-fflags",
                "+genpts",
                "-i",
                inp,
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "96k",
                "-ar",
                "44100",
                "-ac",
                "1",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                outp,
            ],
            timeout=90,
        )
        dest = Path(outp)
        if r.returncode == 0 and dest.is_file() and dest.stat().st_size > 64:
            return dest.read_bytes()
        return None
    except Exception:
        return None
    finally:
        for p in (inp, outp):
            try:
                os.unlink(p)
            except OSError:
                pass


def ensure_narration_m4a(media: Path) -> Path | None:
    """旧 webm 旁白转成 m4a，避免 Safari/幻灯片解不了 Opus。"""
    narr = narration_file(media)
    if not narr or not narr.is_file():
        return None
    if narr.suffix.lower() == ".m4a":
        return narr
    converted = _transcode_narration_m4a(narr.read_bytes(), narr.suffix)
    if not converted:
        return narr
    dest = narration_dest(media, ".m4a")
    dest.write_bytes(converted)
    if dest.resolve() != narr.resolve():
        try:
            narr.unlink()
        except OSError:
            pass
    return dest


def save_narration(album_rel: str, data: bytes, *, filename: str | None = None) -> dict:
    src = album_path(album_rel)
    if not src.exists() or not is_media(src):
        raise FileNotFoundError(album_rel)
    if is_video(src):
        raise ValueError("视频请使用自身音轨；旁白仅支持图片")
    for old in narration_files(src):
        try:
            old.unlink()
        except OSError:
            pass
    ext = _sniff_audio_ext(data, filename)
    converted = _transcode_narration_m4a(data, ext)
    if converted:
        data = converted
        ext = ".m4a"
    dest = narration_dest(src, ext)
    dest.write_bytes(data)
    dur = None
    try:
        from .video import probe_duration

        dur = probe_duration(dest)
    except Exception:
        dur = None
    narr_rel = str(dest.relative_to(config.album_root)).replace("\\", "/")
    try:
        _index_upsert(album_rel)
    except Exception:
        pass
    return {
        "ok": True,
        "path": album_rel,
        "audio_path": narr_rel,
        "audio_duration": dur,
        "has_audio": True,
        "message": "旁白已保存",
    }


def delete_narration(album_rel: str) -> dict:
    src = album_path(album_rel)
    if not src.exists():
        raise FileNotFoundError(album_rel)
    removed = 0
    for p in narration_files(src):
        try:
            p.unlink()
            removed += 1
        except OSError:
            pass
    _index_upsert(album_rel)
    return {
        "ok": True,
        "path": album_rel,
        "removed": removed,
        "has_audio": False,
        "message": "已删除旁白" if removed else "没有旁白可删",
    }


def move_companions(src: Path, dest: Path) -> None:
    """把旁路文件（侧车/封面/实况/旁白）随主文件改到新文件名。"""
    if src.resolve() == dest.resolve():
        return
    for c in _companion_paths(src):
        new_name = _remap_companion_name(src.name, dest.name, c.name)
        target = dest.parent / new_name
        try:
            if target.exists():
                c.unlink(missing_ok=True)
            else:
                shutil.move(str(c), str(target))
        except OSError:
            pass


def _remap_companion_name(old_media: str, new_media: str, companion: str) -> str:
    if companion.startswith(old_media):
        return new_media + companion[len(old_media) :]
    return companion


def _read_trash_meta(entry_dir: Path) -> dict | None:
    meta_file = entry_dir / "meta.json"
    if not meta_file.is_file():
        return None
    try:
        data = json.loads(meta_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    data["id"] = data.get("id") or entry_dir.name
    return data


def _trash_media_file(entry_dir: Path, meta: dict) -> Path | None:
    name = meta.get("filename")
    if name:
        p = entry_dir / name
        if p.is_file() and is_media(p):
            return p
    medias = [p for p in entry_dir.iterdir() if p.is_file() and is_media(p)]
    return medias[0] if medias else None


def trash_one(album_rel: str) -> dict:
    """将已入库媒体移入回收站（含侧车/封面/实况旁路）。"""
    rel = str(album_rel).replace("\\", "/").lstrip("/")
    parts = Path(rel).parts
    if parts and parts[0] == TRASH_DIRNAME:
        raise ValueError("已在回收站中")
    if not parts or not parts[0].isdigit() or len(parts[0]) != 4:
        raise ValueError("只能删除相册归档中的媒体")

    src = album_path(rel)
    if not src.exists() or not is_media(src):
        raise FileNotFoundError(f"找不到媒体: {rel}")

    photo_meta = read_meta(src)
    companions = _companion_paths(src)
    trash_id = datetime.now().strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:10]
    entry_dir = trash_root() / trash_id
    entry_dir.mkdir(parents=True, exist_ok=False)

    dest = entry_dir / src.name
    shutil.move(str(src), str(dest))
    moved_companions: list[str] = []
    for c in companions:
        target = entry_dir / c.name
        shutil.move(str(c), str(target))
        moved_companions.append(c.name)

    entry = {
        "id": trash_id,
        "original_path": rel,
        "filename": src.name,
        "deleted_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "media_datetime": photo_meta.datetime,
        "title": photo_meta.title,
        "kind": "video" if is_video(dest) else "image",
        "companions": moved_companions,
    }
    (entry_dir / "meta.json").write_text(
        json.dumps(entry, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    invalidate_thumbs(rel)
    _cleanup_empty_parents(src, config.album_root)
    _index_delete(rel)
    trash_rel = str(dest.relative_to(config.album_root)).replace("\\", "/")
    entry["path"] = trash_rel
    entry["ok"] = True
    entry["message"] = "已移入回收站"
    return entry


def trash_batch(paths: list[str]) -> dict:
    results = []
    for rel in paths:
        try:
            results.append(trash_one(rel))
        except Exception as e:
            results.append({"ok": False, "path": rel, "message": str(e)})
    ok_n = sum(1 for r in results if r.get("ok"))
    return {
        "ok": ok_n == len(results) and bool(results),
        "results": results,
        "message": f"已移入回收站 {ok_n}/{len(results)}",
    }


def list_trash(*, sort: str = "deleted_at") -> dict:
    sort_key = sort if sort in ("deleted_at", "media_datetime") else "deleted_at"
    root = trash_root()
    items: list[dict] = []
    for entry_dir in root.iterdir():
        if not entry_dir.is_dir():
            continue
        meta = _read_trash_meta(entry_dir)
        if not meta:
            continue
        media = _trash_media_file(entry_dir, meta)
        if not media:
            continue
        trash_rel = str(media.relative_to(config.album_root)).replace("\\", "/")
        items.append(
            {
                "id": meta["id"],
                "path": trash_rel,
                "original_path": meta.get("original_path") or "",
                "filename": media.name,
                "name": media.name,
                "deleted_at": meta.get("deleted_at") or "",
                "media_datetime": meta.get("media_datetime"),
                "title": meta.get("title") or media.stem,
                "kind": meta.get("kind") or ("video" if is_video(media) else "image"),
                "companions": meta.get("companions") or [],
            }
        )

    if sort_key == "media_datetime":
        items.sort(key=lambda x: x.get("media_datetime") or "", reverse=True)
    else:
        items.sort(key=lambda x: x.get("deleted_at") or "", reverse=True)

    return {"items": items, "sort": sort_key, "count": len(items)}


def restore_one(trash_id: str) -> dict:
    tid = Path(str(trash_id)).name
    if not tid or tid in (".", ".."):
        raise ValueError("无效的回收站条目")
    entry_dir = trash_root() / tid
    if not entry_dir.is_dir():
        raise FileNotFoundError(f"回收站条目不存在: {tid}")
    meta = _read_trash_meta(entry_dir)
    if not meta:
        raise FileNotFoundError(f"回收站元数据缺失: {tid}")
    media = _trash_media_file(entry_dir, meta)
    if not media:
        raise FileNotFoundError(f"回收站媒体缺失: {tid}")

    original = (meta.get("original_path") or "").replace("\\", "/").lstrip("/")
    if not original:
        raise ValueError("缺少原始路径，无法恢复")
    old_name = meta.get("filename") or media.name
    target = album_path(original)
    target.parent.mkdir(parents=True, exist_ok=True)
    target, renamed = unique_path(target)
    shutil.move(str(media), str(target))

    for cname in meta.get("companions") or []:
        csrc = entry_dir / cname
        if not csrc.is_file():
            continue
        new_cname = _remap_companion_name(old_name, target.name, cname)
        shutil.move(str(csrc), str(target.parent / new_cname))

    # 清掉条目目录（含 meta.json 与残留）
    shutil.rmtree(entry_dir, ignore_errors=True)

    new_rel = str(target.relative_to(config.album_root)).replace("\\", "/")
    _index_upsert(new_rel)
    return {
        "ok": True,
        "id": tid,
        "path": new_rel,
        "original_path": original,
        "renamed": renamed,
        "message": "已恢复"
        + ("（目标处已有同名文件，已自动改名）" if renamed else ""),
    }


def restore_trash(ids: list[str]) -> dict:
    results = []
    for tid in ids:
        try:
            results.append(restore_one(tid))
        except Exception as e:
            results.append({"ok": False, "id": tid, "message": str(e)})
    ok_n = sum(1 for r in results if r.get("ok"))
    return {
        "ok": ok_n == len(results) and bool(results),
        "results": results,
        "message": f"已恢复 {ok_n}/{len(results)}",
    }


def purge_one(trash_id: str) -> dict:
    tid = Path(str(trash_id)).name
    if not tid or tid in (".", ".."):
        raise ValueError("无效的回收站条目")
    entry_dir = trash_root() / tid
    if not entry_dir.is_dir():
        raise FileNotFoundError(f"回收站条目不存在: {tid}")
    meta = _read_trash_meta(entry_dir) or {}
    media = _trash_media_file(entry_dir, meta) if meta else None
    if media is None:
        medias = [p for p in entry_dir.iterdir() if p.is_file() and is_media(p)]
        media = medias[0] if medias else None

    # 彻底删除前清掉原路径 + 回收站路径的全部缩略图
    thumb_keys: list[str] = []
    if meta.get("original_path"):
        thumb_keys.append(str(meta["original_path"]).replace("\\", "/"))
    if media:
        trash_rel = str(media.relative_to(config.album_root)).replace("\\", "/")
        thumb_keys.append(trash_rel)
    for p in entry_dir.iterdir():
        if p.is_file() and is_media(p):
            thumb_keys.append(str(p.relative_to(config.album_root)).replace("\\", "/"))
    for key in dict.fromkeys(thumb_keys):
        invalidate_thumbs(key)

    shutil.rmtree(entry_dir, ignore_errors=True)
    return {"ok": True, "id": tid, "message": "已彻底删除"}


def purge_trash(ids: list[str]) -> dict:
    results = []
    for tid in ids:
        try:
            results.append(purge_one(tid))
        except Exception as e:
            results.append({"ok": False, "id": tid, "message": str(e)})
    ok_n = sum(1 for r in results if r.get("ok"))
    return {
        "ok": ok_n == len(results) and bool(results),
        "results": results,
        "message": f"已彻底删除 {ok_n}/{len(results)}",
    }
