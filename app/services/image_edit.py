from __future__ import annotations

import io
import shutil
import tempfile
from pathlib import Path

from PIL import Image

from ..config import config
from .library import album_path, ingest_one, move_companions, _companion_paths
from .metadata import read_meta, write_meta
from .naming import is_image

# 90° 步进用无损转置，避免插值缩放
_TRANSPOSE_MAP = {
    90: Image.Transpose.ROTATE_270,   # UI 顺时针 90 = Pillow 逆时针 270
    -90: Image.Transpose.ROTATE_90,
    180: Image.Transpose.ROTATE_180,
    -180: Image.Transpose.ROTATE_180,
    270: Image.Transpose.ROTATE_90,
    -270: Image.Transpose.ROTATE_270,
}


def _open_image(path: Path) -> Image.Image:
    return Image.open(path)


def _normalize_rotate(degrees: int) -> int:
    d = int(degrees) % 360
    if d > 180:
        d -= 360
    return d


def _apply_rotate(im: Image.Image, degrees: int) -> Image.Image:
    d = _normalize_rotate(degrees)
    if d == 0:
        return im
    op = _TRANSPOSE_MAP.get(d)
    if op is not None:
        return im.transpose(op)
    # 非直角：保留尺寸语义，仅作兜底（正常 UI 只发 90 步进）
    return im.rotate(-d, expand=True, resample=Image.Resampling.BICUBIC)


def _save_preserving_pixels(path: Path, im: Image.Image) -> None:
    """保存像素时不改分辨率（裁剪除外），并尽量降低二次压缩损失。"""
    suffix = path.suffix.lower()
    buf = io.BytesIO()
    if suffix in {".jpg", ".jpeg"}:
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.save(
            buf,
            format="JPEG",
            quality=100,
            subsampling=0,
            optimize=False,
        )
    elif suffix == ".png":
        im.save(buf, format="PNG", compress_level=6)
    elif suffix == ".webp":
        im.save(buf, format="WEBP", quality=100, method=6, lossless=True)
    else:
        im.save(buf, format="PNG", compress_level=6)
    path.write_bytes(buf.getvalue())


def save_edit(
    album_rel: str,
    *,
    mode: str,
    rotate: int = 0,
    crop: dict | None = None,
    delete_old: bool = True,
) -> dict:
    """
    mode: 'overwrite' | 'save_as'
    仅旋转/裁剪像素区域，不主动缩放分辨率。
    """
    src = album_path(album_rel)
    if not src.exists() or not is_image(src):
        raise FileNotFoundError(album_rel)
    if src.suffix.lower() in {".heic", ".heif"}:
        raise ValueError("HEIC/实况照片请保持原件；暂不支持旋转裁剪写回（以免损伤画质）")

    meta = read_meta(src)

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / src.name
        shutil.copy2(src, work)

        if rotate or crop:
            with _open_image(work) as im:
                if rotate:
                    im = _apply_rotate(im, int(rotate))
                if crop:
                    w, h = im.size
                    box = (
                        int(float(crop["left"]) * w),
                        int(float(crop["top"]) * h),
                        int(float(crop["right"]) * w),
                        int(float(crop["bottom"]) * h),
                    )
                    if box[2] <= box[0] or box[3] <= box[1]:
                        raise ValueError("裁剪区域无效")
                    im = im.crop(box)
                _save_preserving_pixels(work, im)

        write_meta(work, meta)

        if mode == "overwrite":
            shutil.copy2(work, src)
            write_meta(src, meta)
            # 确保原图 mtime 更新，缩略图按 mtime 判定才会重建
            src.touch(exist_ok=True)
            return {
                "ok": True,
                "path": album_rel,
                "mode": "overwrite",
                "message": "已覆盖原图（分辨率未缩放）",
            }

        staging_name = f"_edit_{src.stem}{src.suffix}"
        staging = config.album_root / "_staging"
        staging.mkdir(exist_ok=True)
        staged = staging / staging_name
        shutil.copy2(work, staged)
        write_meta(staged, meta)

        rel_staged = str(staged.relative_to(config.album_root)).replace("\\", "/")
        result = ingest_one(
            rel_staged,
            datetime_str=meta.datetime,
            title=meta.title,
            description=meta.description,
            reflection=meta.reflection,
            location=meta.location,
            from_import=False,
        )

        if delete_old and result.get("ok"):
            new_path = result.get("path")
            if new_path and new_path != album_rel:
                try:
                    new_full = album_path(new_path)
                    # ingest 已搬大部分旁路；再兜底一次
                    move_companions(src, new_full)
                except Exception:
                    pass
                try:
                    src.unlink(missing_ok=True)
                except OSError:
                    pass
                for leftover in _companion_paths(src):
                    try:
                        leftover.unlink(missing_ok=True)
                    except OSError:
                        pass

        result["mode"] = "save_as"
        result["old_path"] = album_rel
        return result
