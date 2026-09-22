from __future__ import annotations

import hashlib
import re
from datetime import datetime
from pathlib import Path

ILLEGAL_CHARS = re.compile(r'[/\\:*?"<>|\r\n\t]')
DATE_IN_NAME = re.compile(r"(20\d{2})[-_]?(\d{2})[-_]?(\d{2})")
# 新规范：YYYY-MM-DD-HHMMSS-简述-md5前8位（冲突时可再加 -2）
NEW_NAME = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<time>\d{6})-(?P<title>.+)-(?P<md5>[0-9a-f]{8})(?:-(?P<n>\d+))?$",
    re.IGNORECASE,
)
# 旧规范：YYYY-MM-DD-简述（可能带 -2 序号）
OLD_NAME = re.compile(r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<title>.+)$")

IMAGE_EXTS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".tif",
    ".tiff",
    ".bmp",
    ".heic",
    ".heif",
}
VIDEO_EXTS = {
    ".mp4",
    ".m4v",
    ".mov",
    ".webm",
    ".mkv",
    ".avi",
    ".mpeg",
    ".mpg",
    ".3gp",
    ".ts",
    ".mts",
    ".m2ts",
}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS
HEIC_EXTS = {".heic", ".heif"}
MD5_NAME_LEN = 8


def is_image(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in IMAGE_EXTS


def is_heic(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in HEIC_EXTS


def is_video(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in VIDEO_EXTS


def is_media(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in MEDIA_EXTS


def sanitize_title(title: str | None, max_len: int = 30) -> str:
    text = (title or "").strip()
    text = ILLEGAL_CHARS.sub("_", text)
    text = re.sub(r"\s+", " ", text).strip(" ._")
    if not text:
        text = "未命名"
    if len(text) > max_len:
        text = text[:max_len].rstrip(" ._")
    return text or "未命名"


def parse_datetime(value: str | datetime | None) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    text = str(value).strip().replace("/", "-")
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%Y:%m:%d %H:%M:%S",
    ):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def guess_datetime_from_name(name: str) -> datetime | None:
    stem = Path(name).stem
    m_new = NEW_NAME.match(stem)
    if m_new:
        try:
            return datetime.strptime(
                f"{m_new.group('date')}-{m_new.group('time')}",
                "%Y-%m-%d-%H%M%S",
            )
        except ValueError:
            pass
    m = DATE_IN_NAME.search(name)
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def file_md5(path: Path, *, length: int = MD5_NAME_LEN) -> str:
    """内容 MD5；默认取前 8 位用于文件名，降低批量同秒同简述冲突。"""
    h = hashlib.md5()
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    digest = h.hexdigest()
    return digest[: max(4, min(length, 32))]


def build_rel_path(
    dt: datetime,
    title: str,
    ext: str,
    max_len: int = 30,
    *,
    content_hash: str | None = None,
) -> Path:
    """年/月/YYYY-MM-DD-HHMMSS-简述-md5.ext"""
    safe = sanitize_title(title, max_len)
    year = f"{dt.year:04d}"
    month = f"{dt.year:04d}-{dt.month:02d}"
    stamp = dt.strftime("%Y-%m-%d-%H%M%S")
    md5 = (content_hash or "").strip().lower()
    if md5:
        md5 = md5[:MD5_NAME_LEN]
        filename = f"{stamp}-{safe}-{md5}{ext.lower()}"
    else:
        filename = f"{stamp}-{safe}{ext.lower()}"
    return Path(year) / month / filename


def unique_path(target: Path, ignore: Path | None = None) -> tuple[Path, bool]:
    """Return a non-colliding path. Second value True if renamed with suffix."""
    ignore_res = ignore.resolve() if ignore else None
    if not target.exists() or (ignore_res and target.resolve() == ignore_res):
        return target, False
    stem = target.stem
    suffix = target.suffix
    parent = target.parent
    n = 2
    while True:
        candidate = parent / f"{stem}-{n}{suffix}"
        if not candidate.exists() or (ignore_res and candidate.resolve() == ignore_res):
            return candidate, True
        n += 1


def parse_title_from_filename(name: str) -> str | None:
    stem = Path(name).stem
    m_new = NEW_NAME.match(stem)
    if m_new:
        return m_new.group("title") or None
    m_old = OLD_NAME.match(stem)
    if m_old:
        title = m_old.group("title")
        # 去掉历史重名序号 -2、-3
        title = re.sub(r"-\d+$", "", title).strip("-_ ")
        return title or None
    m2 = DATE_IN_NAME.search(stem)
    if m2:
        rest = stem[m2.end() :].lstrip("-_ ")
        return rest or None
    return stem or None
