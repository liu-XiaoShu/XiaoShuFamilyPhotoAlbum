from __future__ import annotations

import hashlib
import re
from datetime import datetime
from pathlib import Path

ILLEGAL_CHARS = re.compile(r'[/\\:*?"<>|\r\n\t]')
DATE_IN_NAME = re.compile(r"((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})")
# 文件名里的日期+时间：2021-10-17-120530 / 2021-10-17-00:00 / 20211017_043015
DATETIME_IN_NAME = re.compile(
    r"((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[-_ T](\d{2})[:.\-]?(\d{2})(?:[:.\-]?(\d{2}))?"
)
DATETIME_COMPACT = re.compile(
    r"(?:^|[^\d])((?:19|20)\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})"
)
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
    ".jpe",
    ".jfif",
    ".png",
    ".webp",
    ".gif",
    ".tif",
    ".tiff",
    ".bmp",
    ".heic",
    ".heif",
    ".avif",
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
    ".mpe",
    ".3gp",
    ".3g2",
    # 不含 .ts：易与 TypeScript 源码冲突；摄像机用 .mts/.m2ts
    ".mts",
    ".m2ts",
    ".flv",
    ".f4v",
    ".wmv",
    ".asf",
    ".vob",
    ".ogv",
    ".rm",
    ".rmvb",
}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS
HEIC_EXTS = {".heic", ".heif"}
MD5_NAME_LEN = 8
# 去重指纹：忽略 EXIF/XMP/容器元数据，只对像素/媒体载荷哈希。
CONTENT_HASH_ALGO = "nometa-v1"

_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_PNG_KEEP = {b"IHDR", b"PLTE", b"IDAT", b"tRNS", b"IEND"}
_WEBP_SKIP = {b"EXIF", b"XMP ", b"ICCP"}
_ISO_MEDIA = {".mp4", ".m4v", ".mov", ".3gp", ".3g2", ".heic", ".heif"}
_JPEG_EXTS = {".jpg", ".jpeg", ".jpe", ".jfif"}


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


def _dt_from_parts(
    y: str, mo: str, d: str, h: str = "0", mi: str = "0", s: str | None = None
) -> datetime | None:
    try:
        return datetime(int(y), int(mo), int(d), int(h), int(mi), int(s or 0))
    except ValueError:
        return None


def guess_datetime_from_name(name: str) -> datetime | None:
    """从文件名（或相对路径）取出拍摄时间；有时分秒则带上，否则日期 00:00:00。"""
    text = str(name or "").replace("\\", "/")
    stem = Path(text).stem
    m_new = NEW_NAME.match(stem)
    if m_new:
        try:
            return datetime.strptime(
                f"{m_new.group('date')}-{m_new.group('time')}",
                "%Y-%m-%d-%H%M%S",
            )
        except ValueError:
            pass
    # 无 md5 后缀的 YYYY-MM-DD-HHMMSS-简述
    m_stamp = re.match(
        r"^((?:19|20)\d{2}-\d{2}-\d{2})-(\d{6})(?:-|$)",
        stem,
    )
    if m_stamp:
        try:
            return datetime.strptime(f"{m_stamp.group(1)}-{m_stamp.group(2)}", "%Y-%m-%d-%H%M%S")
        except ValueError:
            pass
    for src in (stem, Path(text).name, text):
        m = DATETIME_IN_NAME.search(src)
        if m:
            dt = _dt_from_parts(*m.groups())
            if dt:
                return dt
        m = DATETIME_COMPACT.search(src)
        if m:
            dt = _dt_from_parts(*m.groups())
            if dt:
                return dt
    m = DATE_IN_NAME.search(stem) or DATE_IN_NAME.search(text)
    if not m:
        return None
    return _dt_from_parts(m.group(1), m.group(2), m.group(3))


def file_md5(path: Path, *, length: int = MD5_NAME_LEN) -> str:
    """整文件 MD5（含元数据）。去重请用 content_md5。"""
    h = hashlib.md5()
    with path.open("rb") as f:
        while True:
            chunk = f.read(4 * 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    digest = h.hexdigest()
    return digest[: max(4, min(length, 32))]


def content_md5(path: Path, *, length: int = 32) -> str:
    """抛弃元数据后的内容指纹：同画面/同影像、仅 EXIF 不同视为同一文件。"""
    ext = path.suffix.lower()
    digest = None
    try:
        if ext in _JPEG_EXTS:
            digest = _hash_jpeg_nometa(path)
        elif ext == ".png":
            digest = _hash_png_nometa(path)
        elif ext == ".webp":
            digest = _hash_webp_nometa(path)
        elif ext in _ISO_MEDIA:
            digest = _hash_iso_mdat(path)
        elif ext == ".gif":
            digest = _hash_gif_nometa(path)
    except OSError:
        digest = None
    if not digest:
        digest = file_md5(path, length=32)
    return digest[: max(4, min(length, 32))]


def _hash_jpeg_nometa(path: Path) -> str | None:
    """跳过 APP0–APP15、COM，对其余 JPEG 段（量化表/哈夫曼/扫描数据）哈希。"""
    data = path.read_bytes()
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None
    out = hashlib.md5()
    out.update(b"\xff\xd8")
    i = 2
    n = len(data)
    while i < n:
        if data[i] != 0xFF:
            out.update(data[i:])
            break
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            break
        marker = data[i]
        i += 1
        if marker == 0xD9:
            out.update(b"\xff\xd9")
            break
        if 0xD0 <= marker <= 0xD7:
            out.update(bytes((0xFF, marker)))
            continue
        if marker == 0xDA:
            out.update(b"\xff\xda")
            out.update(data[i:])
            break
        if i + 2 > n:
            break
        ln = (data[i] << 8) | data[i + 1]
        if ln < 2 or i + ln > n:
            break
        if 0xE0 <= marker <= 0xEF or marker == 0xFE:
            i += ln
            continue
        out.update(bytes((0xFF, marker)))
        out.update(data[i : i + ln])
        i += ln
    return out.hexdigest()


def _hash_png_nometa(path: Path) -> str | None:
    h = hashlib.md5()
    with path.open("rb") as f:
        sig = f.read(8)
        if sig != _PNG_SIG:
            return None
        h.update(sig)
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            length = int.from_bytes(hdr[:4], "big")
            ctype = hdr[4:8]
            payload = f.read(length)
            crc = f.read(4)
            if len(payload) < length or len(crc) < 4:
                break
            if ctype in _PNG_KEEP:
                h.update(hdr)
                h.update(payload)
            if ctype == b"IEND":
                break
    return h.hexdigest()


def _hash_webp_nometa(path: Path) -> str | None:
    with path.open("rb") as f:
        head = f.read(12)
        if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WEBP":
            return None
        h = hashlib.md5()
        h.update(b"WEBP")
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            fourcc = hdr[:4]
            size = int.from_bytes(hdr[4:8], "little")
            payload = f.read(size)
            if size % 2 == 1:
                f.read(1)
            if len(payload) < size:
                break
            if fourcc not in _WEBP_SKIP:
                h.update(fourcc)
                h.update(payload)
    return h.hexdigest()


def _hash_iso_mdat(path: Path) -> str | None:
    """MP4/MOV/HEIC：只哈希 mdat 媒体载荷，忽略 moov/meta 里的时间、GPS、标题。"""
    h = hashlib.md5()
    found = False
    with path.open("rb") as f:
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            size = int.from_bytes(hdr[:4], "big")
            typ = hdr[4:8]
            if size == 1:
                ext = f.read(8)
                if len(ext) < 8:
                    break
                size = int.from_bytes(ext, "big")
                hdr_len = 16
            elif size == 0:
                if typ == b"mdat":
                    found = True
                    while True:
                        chunk = f.read(4 * 1024 * 1024)
                        if not chunk:
                            break
                        h.update(chunk)
                break
            else:
                hdr_len = 8
            payload_len = size - hdr_len
            if payload_len < 0:
                break
            if typ == b"mdat":
                found = True
                remain = payload_len
                while remain > 0:
                    chunk = f.read(min(remain, 4 * 1024 * 1024))
                    if not chunk:
                        break
                    h.update(chunk)
                    remain -= len(chunk)
            else:
                try:
                    f.seek(payload_len, 1)
                except OSError:
                    break
    return h.hexdigest() if found else None


def _hash_gif_nometa(path: Path) -> str | None:
    data = path.read_bytes()
    if len(data) < 6 or data[:3] != b"GIF":
        return None
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        if i + 2 <= n and data[i] == 0x21 and data[i + 1] == 0xFE:
            i += 2
            while i < n:
                blk = data[i]
                i += 1
                if blk == 0:
                    break
                i += blk
            continue
        out.append(data[i])
        i += 1
    return hashlib.md5(bytes(out)).hexdigest()


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
