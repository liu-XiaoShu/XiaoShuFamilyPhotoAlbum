"""相册根目录迁移：只搬迁 YYYY/ 年目录（含视频侧车与封面），不碰代码与 data/。"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from ..config import ROOT
from .naming import unique_path

_YEAR_DIR = re.compile(r"^\d{4}$")

# 禁止把相册根设到这些目录内部（避免媒资混进代码/缓存）
_FORBIDDEN_PREFIXES = (
    ROOT / "app",
    ROOT / "data",
    ROOT / ".vendor",
    ROOT / ".venv",
    ROOT / "scripts",
    ROOT / "__pycache__",
)


def is_year_dir(path: Path) -> bool:
    return path.is_dir() and bool(_YEAR_DIR.match(path.name))


def list_year_dirs(root: Path) -> list[Path]:
    if not root.exists() or not root.is_dir():
        return []
    return sorted(p for p in root.iterdir() if is_year_dir(p))


def resolve_album_path(raw: str | Path) -> Path:
    p = Path(str(raw)).expanduser()
    if not p.is_absolute():
        p = (Path.cwd() / p).resolve()
    else:
        p = p.resolve()
    return p


def _is_under(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def validate_new_album_root(old: Path, new: Path) -> None:
    if not str(new):
        raise ValueError("相册根目录不能为空")
    if new.exists() and not new.is_dir():
        raise ValueError(f"目标路径不是目录：{new}")
    for ban in _FORBIDDEN_PREFIXES:
        if new == ban.resolve() or _is_under(new, ban):
            raise ValueError(f"不能把相册根设在系统目录内：{ban.name}/")
    # 新根不能落在旧根某个年目录内部（否则无法把该年整棵搬走）
    if old.exists():
        for yd in list_year_dirs(old):
            if new == yd.resolve() or _is_under(new, yd):
                raise ValueError(f"新路径不能落在年目录内：{yd.name}/")


def _merge_move(src: Path, dest: Path) -> None:
    """把 src 挪到 dest；dest 已存在则递归合并，文件冲突则改名。"""
    if src.resolve() == dest.resolve():
        return
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        return

    if not dest.is_dir() or not src.is_dir():
        alt, _ = unique_path(dest)
        shutil.move(str(src), str(alt))
        return

    for child in list(src.iterdir()):
        target = dest / child.name
        if not target.exists():
            shutil.move(str(child), str(target))
        elif child.is_dir() and target.is_dir():
            _merge_move(child, target)
        else:
            alt, _ = unique_path(target)
            shutil.move(str(child), str(alt))

    try:
        src.rmdir()
    except OSError:
        # 残留空壳或隐藏文件时尽量清掉空目录
        for leftover in list(src.iterdir()):
            if leftover.is_dir():
                shutil.rmtree(leftover, ignore_errors=True)
            else:
                try:
                    leftover.unlink()
                except OSError:
                    pass
        try:
            src.rmdir()
        except OSError:
            pass


def _clear_staging(root: Path) -> None:
    staging = root / "_staging"
    if staging.is_dir():
        shutil.rmtree(staging, ignore_errors=True)


def migrate_album_root(old_raw: str | Path, new_raw: str | Path) -> dict:
    """
    将旧相册根下的 YYYY/ 目录搬到新根。
    相对路径（如 2026/2026-09/xxx.jpg）保持不变，缩略图缓存可继续命中。
    """
    old = resolve_album_path(old_raw)
    new = resolve_album_path(new_raw)

    if old == new:
        new.mkdir(parents=True, exist_ok=True)
        return {
            "changed": False,
            "moved": [],
            "errors": [],
            "old_root": str(old),
            "new_root": str(new),
            "message": "路径未变化",
        }

    validate_new_album_root(old, new)
    new.mkdir(parents=True, exist_ok=True)

    years = list_year_dirs(old)
    moved: list[str] = []
    errors: list[str] = []

    for yd in years:
        dest = new / yd.name
        try:
            if _is_under(new, yd):
                raise ValueError(f"目标落在 {yd.name}/ 内，已跳过")
            _merge_move(yd, dest)
            moved.append(yd.name)
        except Exception as e:
            errors.append(f"{yd.name}: {e}")

    # 回收站随相册根一并搬迁
    old_trash = old / ".trash"
    if old_trash.is_dir():
        try:
            _merge_move(old_trash, new / ".trash")
            moved.append(".trash")
        except Exception as e:
            errors.append(f".trash: {e}")

    _clear_staging(old)
    # 新根下的暂存可保留空目录供编辑使用
    (new / "_staging").mkdir(exist_ok=True)

    if errors and not moved:
        raise RuntimeError("迁移失败：" + "；".join(errors))

    parts = []
    if moved:
        parts.append(f"已搬迁 {len(moved)} 个年份：{', '.join(moved)}")
    else:
        parts.append("新路径下无年目录需要搬迁（或旧根为空）")
    if errors:
        parts.append("部分失败：" + "；".join(errors))

    return {
        "changed": True,
        "moved": moved,
        "errors": errors,
        "old_root": str(old),
        "new_root": str(new),
        "message": "。".join(parts),
    }
