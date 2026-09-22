"""HEIC/HEIF 支持：注册解码器，供缩略图与读 EXIF；原件始终字节级保留。"""

from __future__ import annotations

_HEIF_READY = False
_HEIF_TRIED = False


def ensure_heif_support() -> bool:
    """注册 pillow-heif。成功返回 True（可解码预览）；失败则仅能存原件。"""
    global _HEIF_READY, _HEIF_TRIED
    if _HEIF_TRIED:
        return _HEIF_READY
    _HEIF_TRIED = True
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
        _HEIF_READY = True
    except Exception:
        _HEIF_READY = False
    return _HEIF_READY


def is_heic_path(path) -> bool:
    from pathlib import Path

    return Path(path).suffix.lower() in {".heic", ".heif"}
