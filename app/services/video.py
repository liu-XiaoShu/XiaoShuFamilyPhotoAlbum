from __future__ import annotations

"""视频：ffprobe 元数据、封面抽帧、剪辑/旋转（ffmpeg）。"""

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from threading import Lock, Thread
from typing import Any, Optional

from ..config import config
from .metadata import PhotoMeta, sync_coords_from_location
from .naming import guess_datetime_from_name, is_video, parse_datetime, unique_path

FFPROBE = shutil.which("ffprobe") or "ffprobe"
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"

# 浏览器（尤其 Chromium）可直接播的编码；HEVC 仅 Safari/部分设备，树莓派浏览器通常不行
_BROWSER_VCODECS = {"h264", "avc1", "avc", "vp8", "vp9", "av1", "libvpx", "libvpx-vp9"}
_BROWSER_ACODECS = {
    "aac",
    "mp3",
    "mp4a",
    "opus",
    "vorbis",
    "flac",
    "pcm_s16le",
    "pcm_s16be",
}
_BROWSER_CONTAINERS = {".mp4", ".m4v", ".webm"}

_play_locks: dict[str, Lock] = {}
_play_locks_guard = Lock()


def _lock_key(key: str) -> Lock:
    with _play_locks_guard:
        lock = _play_locks.get(key)
        if lock is None:
            lock = Lock()
            _play_locks[key] = lock
        return lock


def stream_codecs(path: Path) -> dict[str, Any]:
    """返回 {vcodec, acodec, container, has_audio}。"""
    info = probe(path)
    vcodec = ""
    acodec = ""
    for stream in info.get("streams") or []:
        ctype = (stream.get("codec_type") or "").lower()
        name = (stream.get("codec_name") or "").lower()
        if ctype == "video" and not vcodec:
            vcodec = name
        elif ctype == "audio" and not acodec:
            acodec = name
    fmt = ((info.get("format") or {}).get("format_name") or "").lower()
    return {
        "vcodec": vcodec,
        "acodec": acodec,
        "container": path.suffix.lower(),
        "format_name": fmt,
        "has_audio": bool(acodec),
    }


def is_browser_native(path: Path) -> bool:
    """原文件是否可直接给 HTML5 <video> 播放（保守判断）。"""
    if not path.exists() or not is_video(path):
        return False
    try:
        if path.stat().st_size < 8192:
            return False
    except OSError:
        return False
    info = stream_codecs(path)
    v = info["vcodec"]
    a = info["acodec"]
    suf = info["container"]
    if not v or v not in _BROWSER_VCODECS:
        return False
    if a and a not in _BROWSER_ACODECS:
        return False
    if suf in _BROWSER_CONTAINERS:
        return True
    # Chromium 多数能播 H.264 MOV；优先秒开，避免整文件 remux 卡住
    if suf == ".mov" and v in {"h264", "avc1", "avc"}:
        return True
    return False


def is_stream_copy_ok(path: Path) -> bool:
    """可否仅 remux（不重新编码）。"""
    info = stream_codecs(path)
    v = info.get("vcodec") or ""
    a = info.get("acodec") or ""
    return v in {"h264", "avc1", "avc"} and (not a or a in {"aac", "mp3", "mp4a"})


def video_readable(path: Path) -> tuple[bool, str]:
    """快速判断容器是否可读。返回 (ok, reason)。"""
    if not path.exists():
        return False, "文件不存在"
    try:
        size = path.stat().st_size
    except OSError:
        return False, "无法读取文件"
    if size < 1024:
        return False, "文件过小或未传完（损坏）"
    info = stream_codecs(path)
    if not info.get("vcodec"):
        return False, "无法识别视频编码（可能损坏或缺 moov）"
    return True, ""


_warm_started: set[str] = set()


def schedule_warm_playable(src: Path, out: Path, *, max_height: int = 1080) -> None:
    """后台预热 mp4 缓存，不挡当前播放。"""
    key = str(out.resolve())
    if key in _warm_started:
        return
    if out.exists() and out.stat().st_size > 1024:
        return
    _warm_started.add(key)

    def _run() -> None:
        try:
            ensure_browser_mp4(src, out, max_height=max_height, force=True)
        except Exception:
            pass
        finally:
            _warm_started.discard(key)

    Thread(target=_run, daemon=True, name="warm-playable").start()


def ensure_browser_mp4(
    src: Path,
    out: Path,
    *,
    max_height: int = 1080,
    timeout: int = 1800,
    force: bool = False,
) -> Path:
    """生成浏览器可播的 H.264+AAC MP4；已原生可播则返回 src。落盘到 out（带缓存语义由调用方管）。"""
    if not src.exists() or not is_video(src):
        raise FileNotFoundError(str(src))
    ok, reason = video_readable(src)
    if not ok:
        raise ValueError(f"视频无法播放：{reason}")
    if not force and is_browser_native(src):
        return src

    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and out.stat().st_mtime >= src.stat().st_mtime and out.stat().st_size > 1024:
        return out

    lock = _lock_key(str(out.resolve()))
    with lock:
        if out.exists() and out.stat().st_mtime >= src.stat().st_mtime and out.stat().st_size > 1024:
            return out

        info = stream_codecs(src)
        v = info["vcodec"]
        a = info["acodec"]
        # 视频已是 H.264 且音轨兼容 → 优先 remux（含 .mov→.mp4，快）
        can_remux = v in {"h264", "avc1", "avc"} and (not a or a in {"aac", "mp3", "mp4a"})

        tmp = out.with_suffix(out.suffix + ".partial")
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass

        if can_remux:
            cmd = [
                FFMPEG,
                "-y",
                "-i",
                str(src),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                str(tmp),
            ]
            r = _run(cmd, timeout=min(timeout, 300))
            if r.returncode == 0 and tmp.exists() and tmp.stat().st_size > 1024:
                tmp.replace(out)
                return out
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

        # 完整转码：兼容树莓派 + Chromium
        h = max(240, int(max_height or 1080))
        vf = f"scale=-2:min(ih\\,{h}),format=yuv420p"
        cmd = [
            FFMPEG,
            "-y",
            "-i",
            str(src),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            str(tmp),
        ]
        r = _run(cmd, timeout=timeout)
        if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 1024:
            err = (r.stderr or b"").decode("utf-8", errors="ignore")[-600:]
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise RuntimeError(f"视频转码失败：{err or 'ffmpeg error'}")
        tmp.replace(out)
        return out


def playable_cache_key(source: str, rel: str, mtime: float, size: int) -> str:
    raw = f"{source}:{rel}:{mtime}:{size}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def sidecar_path(media: Path) -> Path:
    return media.with_name(media.name + ".xiaoshu.json")


def cover_path(media: Path) -> Path:
    return media.with_name(media.name + ".cover.jpg")


def _run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def probe(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    cmd = [
        FFPROBE,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    try:
        r = _run(cmd, timeout=60)
        if r.returncode != 0:
            return {}
        return json.loads(r.stdout.decode("utf-8", errors="ignore") or "{}")
    except (OSError, json.JSONDecodeError, subprocess.TimeoutExpired):
        return {}


def probe_duration(path: Path) -> float | None:
    info = probe(path)
    try:
        d = float((info.get("format") or {}).get("duration") or 0)
        return d if d > 0 else None
    except (TypeError, ValueError):
        return None


def _tags_from_probe(info: dict) -> dict[str, str]:
    tags = {}
    fmt = info.get("format") or {}
    for k, v in (fmt.get("tags") or {}).items():
        tags[str(k).lower()] = str(v)
    for stream in info.get("streams") or []:
        for k, v in (stream.get("tags") or {}).items():
            tags.setdefault(str(k).lower(), str(v))
    return tags


def _parse_probe_datetime(tags: dict[str, str]) -> str | None:
    for key in (
        "com.apple.quicktime.creationdate",
        "creation_time",
        "contentcreatedate",
        "date",
        "timedate",
    ):
        raw = tags.get(key)
        if not raw:
            continue
        text = raw.replace("T", " ").replace("Z", "").strip()
        if "+" in text[10:]:
            text = text.split("+", 1)[0].strip()
        dt = parse_datetime(text[:19])
        if dt:
            return dt.strftime("%Y-%m-%d %H:%M:%S")
    return None


def parse_iso6709(raw: str | None) -> tuple[float, float] | None:
    """解析 Apple QuickTime ISO6709，如 +30.2875+120.1551+012.000/。"""
    if not raw:
        return None
    text = str(raw).strip().rstrip("/")
    m = re.match(r"^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)", text)
    if not m:
        return None
    try:
        lat = float(m.group(1))
        lng = float(m.group(2))
        if abs(lat) > 90 or abs(lng) > 180:
            return None
        return lat, lng
    except ValueError:
        return None


def read_sidecar(path: Path) -> dict:
    side = sidecar_path(path)
    if not side.exists():
        return {}
    try:
        data = json.loads(side.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_sidecar(path: Path, meta: PhotoMeta, extra: dict | None = None) -> None:
    payload = meta.to_dict()
    if extra:
        payload.update(extra)
    side = sidecar_path(path)
    side.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_video_meta(path: Path) -> PhotoMeta:
    meta = PhotoMeta()
    info = probe(path)
    tags = _tags_from_probe(info)
    meta.datetime = _parse_probe_datetime(tags)
    meta.title = tags.get("title") or tags.get("com.apple.quicktime.title")
    meta.description = (
        tags.get("comment")
        or tags.get("description")
        or tags.get("com.apple.quicktime.description")
    )
    loc = tags.get("location") or tags.get("com.apple.quicktime.location.iso6709")
    if loc:
        coords = parse_iso6709(loc)
        if coords:
            meta.lat, meta.lng = coords
        elif not loc.startswith("+") and ":" not in loc[:3]:
            meta.location = loc

    side = read_sidecar(path)
    for key in ("datetime", "title", "description", "reflection", "location"):
        if side.get(key):
            setattr(meta, key, side.get(key))
    if side.get("lat") is not None and side.get("lng") is not None:
        try:
            meta.lat = float(side["lat"])
            meta.lng = float(side["lng"])
        except (TypeError, ValueError):
            pass

    if not parse_datetime(meta.datetime):
        guessed = guess_datetime_from_name(path.name) or guess_datetime_from_name(str(path))
        if guessed:
            meta.datetime = guessed.strftime("%Y-%m-%d %H:%M:%S")
    if not meta.title:
        from .naming import parse_title_from_filename

        meta.title = parse_title_from_filename(path.name)
    return meta


def write_video_meta(path: Path, meta: PhotoMeta) -> None:
    if meta.location and (meta.lat is None or meta.lng is None):
        sync_coords_from_location(meta)
    duration = probe_duration(path)
    prev = read_sidecar(path)
    extra = {"duration": duration, "kind": "video"}
    if prev.get("cover_time") is not None:
        extra["cover_time"] = prev.get("cover_time")
    write_sidecar(path, meta, extra)


def extract_poster(
    src: Path, dest: Path, size: int = 320, at_time: float | None = None, *, timeout: int = 90
) -> bool:
    """抽一帧作为封面 JPEG。at_time 为秒；默认取约 12% 处。

    先尝试快速 seek（-ss 在 -i 前），失败再准确 seek，兼容更多容器格式。
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    dur = probe_duration(src) or 0
    if at_time is None:
        ss = 1.0 if dur <= 0 else min(max(dur * 0.12, 0.3), max(dur - 0.2, 0.0))
    else:
        ss = float(at_time)
        if dur > 0:
            ss = min(max(ss, 0.0), max(dur - 0.05, 0.0))
        else:
            ss = max(ss, 0.0)

    def _try(ss_before: bool) -> bool:
        try:
            if dest.exists():
                dest.unlink(missing_ok=True)
        except OSError:
            pass
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y"]
        if ss_before:
            cmd += ["-ss", f"{ss:.3f}", "-i", str(src)]
        else:
            cmd += ["-i", str(src), "-ss", f"{ss:.3f}"]
        cmd += [
            "-frames:v",
            "1",
            "-an",
            "-q:v",
            "4",
            "-vf",
            f"scale={size}:{size}:force_original_aspect_ratio=decrease",
            str(dest),
        ]
        try:
            r = _run(cmd, timeout=timeout)
            return r.returncode == 0 and dest.exists() and dest.stat().st_size > 50
        except (OSError, subprocess.TimeoutExpired):
            return False

    if _try(True):
        return True
    return _try(False)


def set_cover_frame(path: Path, at_time: float, size: int = 720) -> dict:
    """把指定时刻设为视频封面（旁路 .cover.jpg + sidecar）。"""
    if not path.exists() or not is_video(path):
        raise FileNotFoundError(str(path))
    dest = cover_path(path)
    ok = extract_poster(path, dest, size=size, at_time=float(at_time))
    if not ok:
        raise RuntimeError("抽取封面失败，请换一帧重试")
    meta = read_video_meta(path)
    prev = read_sidecar(path)
    extra = {
        "duration": prev.get("duration") or probe_duration(path),
        "kind": "video",
        "cover_time": float(at_time),
    }
    write_sidecar(path, meta, extra)
    return {
        "ok": True,
        "cover_time": float(at_time),
        "cover": str(dest.name),
        "message": f"已设封面（{at_time:.1f}s）",
    }


def _rotate_filter(degrees: int) -> str | None:
    d = int(degrees) % 360
    if d == 0:
        return None
    if d == 90:
        return "transpose=1"  # 顺时针 90
    if d == 180:
        return "transpose=1,transpose=1"
    if d == 270:
        return "transpose=2"  # 逆时针 90 = 顺时针 270
    return f"rotate={-d}*PI/180"


def save_video_edit(
    album_rel: str,
    *,
    mode: str,
    rotate: int = 0,
    trim_start: float | None = None,
    trim_end: float | None = None,
    delete_old: bool = True,
) -> dict:
    from .library import album_path, ingest_one

    src = album_path(album_rel)
    if not src.exists() or not is_video(src):
        raise FileNotFoundError(album_rel)

    meta = read_video_meta(src)
    duration = probe_duration(src)
    t0 = float(trim_start or 0)
    t1 = float(trim_end) if trim_end is not None else None
    if t0 < 0:
        t0 = 0.0
    if duration is not None and t1 is not None and t1 > duration:
        t1 = duration
    if t1 is not None and t1 <= t0:
        raise ValueError("剪辑结束时间必须大于开始时间")

    need_process = bool(rotate) or t0 > 0.05 or (t1 is not None and duration and t1 < duration - 0.05)

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / ("out" + src.suffix.lower())
        if not need_process:
            shutil.copy2(src, work)
        else:
            cmd = [FFMPEG, "-y"]
            if t0 > 0:
                cmd += ["-ss", f"{t0:.3f}"]
            cmd += ["-i", str(src)]
            if t1 is not None:
                # 相对裁切长度
                cmd += ["-t", f"{max(0.1, t1 - t0):.3f}"]
            vf = _rotate_filter(int(rotate or 0))
            if vf:
                cmd += ["-vf", vf]
            # 兼容多数浏览器：H.264 + AAC
            out_suf = src.suffix.lower()
            if out_suf in {".mp4", ".m4v", ".mov"}:
                cmd += [
                    "-c:v",
                    "libx264",
                    "-preset",
                    "fast",
                    "-crf",
                    "20",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "160k",
                    "-movflags",
                    "+faststart",
                ]
                work = Path(tmp) / "out.mp4"
            elif out_suf == ".webm":
                cmd += ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-c:a", "libopus"]
            else:
                # 其它容器统一转 mp4 便于播放
                work = Path(tmp) / "out.mp4"
                cmd += [
                    "-c:v",
                    "libx264",
                    "-preset",
                    "fast",
                    "-crf",
                    "20",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                ]
            cmd.append(str(work))
            r = _run(cmd, timeout=1800)
            if r.returncode != 0 or not work.exists():
                err = (r.stderr or b"").decode("utf-8", errors="ignore")[-800:]
                raise RuntimeError(f"视频处理失败：{err or 'ffmpeg error'}")

        write_video_meta(work, meta)

        if mode == "overwrite":
            # 扩展名可能从 avi→mp4
            final = src
            if work.suffix.lower() != src.suffix.lower():
                final = src.with_suffix(work.suffix)
                if final.exists() and final.resolve() != src.resolve():
                    final, _ = unique_path(final)
                shutil.copy2(work, final)
                write_video_meta(final, meta)
                side_old = sidecar_path(src)
                cover_old = cover_path(src)
                if final.resolve() != src.resolve():
                    try:
                        src.unlink(missing_ok=True)
                    except OSError:
                        pass
                    if side_old.exists():
                        try:
                            side_old.unlink()
                        except OSError:
                            pass
                    if cover_old.exists():
                        cover_new = cover_path(final)
                        try:
                            shutil.move(str(cover_old), str(cover_new))
                        except OSError:
                            try:
                                cover_old.unlink()
                            except OSError:
                                pass
                new_rel = str(final.relative_to(config.album_root)).replace("\\", "/")
                return {
                    "ok": True,
                    "path": new_rel,
                    "mode": "overwrite",
                    "message": "已覆盖原视频",
                    "kind": "video",
                }
            shutil.copy2(work, src)
            write_video_meta(src, meta)
            return {
                "ok": True,
                "path": album_rel,
                "mode": "overwrite",
                "message": "已覆盖原视频",
                "kind": "video",
            }

        staging = config.album_root / "_staging"
        staging.mkdir(exist_ok=True)
        staged = staging / f"_edit_{src.stem}{work.suffix}"
        staged, _ = unique_path(staged)
        shutil.copy2(work, staged)
        write_video_meta(staged, meta)
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
                    src.unlink(missing_ok=True)
                    sp = sidecar_path(src)
                    if sp.exists():
                        sp.unlink()
                    cp = cover_path(src)
                    if cp.exists():
                        cp.unlink()
                except OSError:
                    pass
        result["mode"] = "save_as"
        result["old_path"] = album_rel
        result["kind"] = "video"
        return result
