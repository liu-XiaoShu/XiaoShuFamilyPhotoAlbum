from __future__ import annotations

import io
import re
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import piexif
from PIL import Image, PngImagePlugin

from .naming import guess_datetime_from_name, parse_title_from_filename

REFLECTION_MARK = "---感悟---"
XMP_NS = "xiaoshu"
XMP_REFLECTION = "Reflection"


@dataclass
class PhotoMeta:
    datetime: str | None = None
    title: str | None = None
    description: str | None = None
    reflection: str | None = None
    location: str | None = None
    lat: float | None = None
    lng: float | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _decode_xp_string(raw) -> str | None:
    """解码 EXIF XP* 字段（piexif 常返回 UTF-16LE 的 int 元组，而非 bytes）。"""
    if raw is None:
        return None
    try:
        if isinstance(raw, str):
            text = raw
        elif isinstance(raw, (bytes, bytearray)):
            text = bytes(raw).decode("utf-16le", errors="ignore")
        elif isinstance(raw, (tuple, list)):
            text = bytes(int(x) & 0xFF for x in raw).decode("utf-16le", errors="ignore")
        else:
            return None
        text = text.replace("\x00", "").strip()
        return text or None
    except Exception:
        return None


def _dms_to_deg(value, ref: bytes | str | None) -> float | None:
    try:
        deg = value[0][0] / float(value[0][1])
        minutes = value[1][0] / float(value[1][1])
        seconds = value[2][0] / float(value[2][1])
        result = deg + minutes / 60.0 + seconds / 3600.0
        ref_s = ref.decode("ascii", errors="ignore") if isinstance(ref, bytes) else str(ref or "")
        if ref_s in ("S", "W"):
            result = -result
        return result
    except Exception:
        return None


def _deg_to_dms(deg: float) -> tuple:
    d = abs(float(deg))
    degrees = int(d)
    minutes_f = (d - degrees) * 60.0
    minutes = int(minutes_f)
    seconds = (minutes_f - minutes) * 60.0
    return ((degrees, 1), (minutes, 1), (int(round(seconds * 10000)), 10000))


def _dt_to_exif(dt: datetime) -> str:
    return dt.strftime("%Y:%m:%d %H:%M:%S")


def _apply_gps_to_exif(exif_dict: dict, lat: float | None, lng: float | None) -> None:
    """写入或清除 GPS IFD。"""
    if lat is None or lng is None:
        exif_dict["GPS"] = {}
        return
    gps = exif_dict.setdefault("GPS", {})
    gps[piexif.GPSIFD.GPSVersionID] = (2, 3, 0, 0)
    gps[piexif.GPSIFD.GPSLatitudeRef] = b"N" if lat >= 0 else b"S"
    gps[piexif.GPSIFD.GPSLatitude] = _deg_to_dms(lat)
    gps[piexif.GPSIFD.GPSLongitudeRef] = b"E" if lng >= 0 else b"W"
    gps[piexif.GPSIFD.GPSLongitude] = _deg_to_dms(lng)


def sync_coords_from_location(meta: PhotoMeta) -> PhotoMeta:
    """根据地点文本解析坐标，供写入 GPS / 地图使用。"""
    from .geo import resolve_location

    if not meta.location:
        meta.lat = None
        meta.lng = None
        return meta
    resolved = resolve_location(meta.location)
    if resolved:
        meta.lat, meta.lng = resolved
    return meta


def _exif_to_iso(value: bytes | str | None) -> str | None:
    if not value:
        return None
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8", errors="ignore")
        except Exception:
            return None
    text = str(value).strip()
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text[:19] if len(text) >= 19 else text, fmt).strftime(
                "%Y-%m-%d %H:%M:%S"
            )
        except ValueError:
            continue
    return text


def _split_description(raw: str | None) -> tuple[str | None, str | None]:
    if not raw:
        return None, None
    if REFLECTION_MARK in raw:
        desc, refl = raw.split(REFLECTION_MARK, 1)
        return desc.strip() or None, refl.strip() or None
    return raw.strip() or None, None


def _join_description(description: str | None, reflection: str | None) -> str | None:
    desc = (description or "").strip()
    refl = (reflection or "").strip()
    if desc and refl:
        return f"{desc}\n\n{REFLECTION_MARK}\n{refl}"
    if refl:
        return f"{REFLECTION_MARK}\n{refl}"
    return desc or None


def _extract_xmp_reflection(data: bytes) -> str | None:
    try:
        text = data.decode("utf-8", errors="ignore")
    except Exception:
        return None
    m = re.search(
        rf"(?:{XMP_NS}:Reflection|Reflection)=[\"']([^\"']*)[\"']",
        text,
    )
    if m:
        return m.group(1).strip() or None
    m2 = re.search(
        rf"<{XMP_NS}:Reflection[^>]*>([^<]*)</{XMP_NS}:Reflection>",
        text,
    )
    if m2:
        return m2.group(1).strip() or None
    return None


def _build_simple_xmp(meta: PhotoMeta) -> str:
    title = meta.title or ""
    desc = meta.description or ""
    loc = meta.location or ""
    refl = meta.reflection or ""
    create = ""
    if meta.datetime:
        try:
            create = datetime.strptime(meta.datetime, "%Y-%m-%d %H:%M:%S").strftime(
                "%Y-%m-%dT%H:%M:%S"
            )
        except ValueError:
            create = meta.datetime
    return f"""<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
 <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
  <rdf:Description rdf:about=''
    xmlns:dc='http://purl.org/dc/elements/1.1/'
    xmlns:xmp='http://ns.adobe.com/xap/1.0/'
    xmlns:photoshop='http://ns.adobe.com/photoshop/1.0/'
    xmlns:{XMP_NS}='https://xiaoshu.local/ns/1.0/'>
   <dc:title><rdf:Alt><rdf:li xml:lang='x-default'>{_xml_escape(title)}</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li xml:lang='x-default'>{_xml_escape(desc)}</rdf:li></rdf:Alt></dc:description>
   <photoshop:City>{_xml_escape(loc)}</photoshop:City>
   <xmp:CreateDate>{_xml_escape(create)}</xmp:CreateDate>
   <{XMP_NS}:Reflection>{_xml_escape(refl)}</{XMP_NS}:Reflection>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>"""


def _xml_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def read_meta(path: Path) -> PhotoMeta:
    from .naming import is_heic, is_video

    if is_video(path):
        from .video import read_video_meta

        return read_video_meta(path)

    from .heif_support import ensure_heif_support

    if is_heic(path):
        ensure_heif_support()

    meta = PhotoMeta()
    suffix = path.suffix.lower()

    try:
        with Image.open(path) as im:
            # PNG text chunks
            if hasattr(im, "text") and im.text:
                meta.title = im.text.get("Title") or im.text.get("title") or meta.title
                raw_desc = im.text.get("Description") or im.text.get("description")
                d, r = _split_description(raw_desc)
                meta.description = d
                meta.reflection = r or im.text.get("Reflection") or meta.reflection
                meta.location = im.text.get("Location") or im.text.get("location") or meta.location
                lat_t = im.text.get("GPSLatitude") or im.text.get("Lat")
                lng_t = im.text.get("GPSLongitude") or im.text.get("Lng")
                if lat_t and lng_t:
                    try:
                        meta.lat = float(lat_t)
                        meta.lng = float(lng_t)
                    except ValueError:
                        pass
                if im.text.get("DateTime"):
                    meta.datetime = _exif_to_iso(im.text.get("DateTime"))

            exif_bytes = im.info.get("exif")
            if exif_bytes:
                try:
                    exif = piexif.load(exif_bytes)
                    z0 = exif.get("0th", {})
                    ex = exif.get("Exif", {})
                    if piexif.ExifIFD.DateTimeOriginal in ex:
                        meta.datetime = _exif_to_iso(ex[piexif.ExifIFD.DateTimeOriginal])
                    elif piexif.ImageIFD.DateTime in z0:
                        meta.datetime = _exif_to_iso(z0[piexif.ImageIFD.DateTime])
                    if piexif.ImageIFD.ImageDescription in z0:
                        raw = z0[piexif.ImageIFD.ImageDescription]
                        if isinstance(raw, bytes):
                            raw = raw.decode("utf-8", errors="ignore")
                        d, r = _split_description(raw)
                        meta.description = meta.description or d
                        meta.reflection = meta.reflection or r
                    if piexif.ImageIFD.XPTitle in z0:
                        title = _decode_xp_string(z0[piexif.ImageIFD.XPTitle])
                        if title:
                            meta.title = meta.title or title
                    if piexif.ImageIFD.XPComment in z0 and not meta.location:
                        comment = _decode_xp_string(z0[piexif.ImageIFD.XPComment])
                        if comment and comment.startswith("地点:"):
                            meta.location = comment[3:].strip() or None
                    gps = exif.get("GPS") or {}
                    if piexif.GPSIFD.GPSLatitude in gps and piexif.GPSIFD.GPSLongitude in gps:
                        lat = _dms_to_deg(
                            gps[piexif.GPSIFD.GPSLatitude],
                            gps.get(piexif.GPSIFD.GPSLatitudeRef),
                        )
                        lng = _dms_to_deg(
                            gps[piexif.GPSIFD.GPSLongitude],
                            gps.get(piexif.GPSIFD.GPSLongitudeRef),
                        )
                        if lat is not None and lng is not None:
                            meta.lat = lat
                            meta.lng = lng
                except Exception:
                    pass

            xmp = im.info.get("xmp") or im.info.get("XML:com.adobe.xmp")
            if xmp:
                if isinstance(xmp, str):
                    xmp = xmp.encode("utf-8", errors="ignore")
                refl = _extract_xmp_reflection(xmp)
                if refl:
                    meta.reflection = meta.reflection or refl
    except Exception:
        pass

    # HEIC：旁路 sidecar 覆盖（编辑元数据时不重编码原件）
    if is_heic(path):
        from .video import read_sidecar

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

    if not meta.datetime:
        guessed = guess_datetime_from_name(path.name)
        if guessed:
            meta.datetime = guessed.strftime("%Y-%m-%d %H:%M:%S")

    if not meta.title:
        meta.title = parse_title_from_filename(path.name)

    return meta


def write_meta(path: Path, meta: PhotoMeta) -> None:
    """Write metadata into image file in-place (pixels unchanged when possible)."""
    from .naming import is_heic, is_video

    if is_video(path):
        from .video import write_video_meta

        write_video_meta(path, meta)
        return

    # HEIC/HEIF：不重编码，元数据写入旁路 JSON，保证画质与相机原件一致
    if is_heic(path):
        _write_heic_sidecar(path, meta)
        return

    # 有地点无坐标时自动解析，保证地图能上图
    if meta.location and (meta.lat is None or meta.lng is None):
        sync_coords_from_location(meta)
    # 注意：仅有 GPS、无地点文本时不要清坐标（否则地图点进编辑再保存会丢点）

    suffix = path.suffix.lower()
    dt = None
    if meta.datetime:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(meta.datetime[:19], fmt) if fmt != "%Y-%m-%d" else datetime.strptime(meta.datetime[:10], fmt)
                break
            except ValueError:
                continue

    combined_desc = _join_description(meta.description, meta.reflection)

    if suffix in {".jpg", ".jpeg"}:
        _write_jpeg_meta(path, meta, dt, combined_desc)
    elif suffix == ".png":
        _write_png_meta(path, meta, dt, combined_desc)
    elif suffix == ".webp":
        _write_webp_meta(path, meta, dt, combined_desc)
    # 其它格式：暂不强制写元数据，避免损坏文件


def _write_heic_sidecar(path: Path, meta: PhotoMeta) -> None:
    from .video import read_sidecar, write_sidecar

    if meta.location and (meta.lat is None or meta.lng is None):
        sync_coords_from_location(meta)
    prev = read_sidecar(path)
    extra = {"kind": "heic"}
    if prev.get("live_video"):
        extra["live_video"] = prev.get("live_video")
    write_sidecar(path, meta, extra)


def _load_existing_exif(path: Path) -> dict:
    try:
        with Image.open(path) as im:
            raw = im.info.get("exif")
            if raw:
                return piexif.load(raw)
    except Exception:
        pass
    return {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}


def _write_jpeg_meta(
    path: Path, meta: PhotoMeta, dt: datetime | None, combined_desc: str | None
) -> None:
    """只注入 EXIF，不重编码像素，避免画质下降。"""
    exif_dict = _load_existing_exif(path)
    z0 = exif_dict.setdefault("0th", {})
    ex = exif_dict.setdefault("Exif", {})

    if dt:
        encoded = _dt_to_exif(dt).encode("utf-8")
        ex[piexif.ExifIFD.DateTimeOriginal] = encoded
        ex[piexif.ExifIFD.DateTimeDigitized] = encoded
        z0[piexif.ImageIFD.DateTime] = encoded

    if combined_desc is not None:
        z0[piexif.ImageIFD.ImageDescription] = combined_desc.encode("utf-8")

    if meta.title:
        z0[piexif.ImageIFD.XPTitle] = meta.title.encode("utf-16le") + b"\x00\x00"

    if meta.location:
        z0[piexif.ImageIFD.XPComment] = (
            f"地点:{meta.location}".encode("utf-16le") + b"\x00\x00"
        )

    _apply_gps_to_exif(exif_dict, meta.lat, meta.lng)

    exif_bytes = piexif.dump(exif_dict)
    raw = path.read_bytes()
    try:
        path.write_bytes(piexif.insert(exif_bytes, raw))
    except Exception:
        # 少数 JPEG 结构 insert 失败时，用 quality=100 兜底重写（仍不改分辨率）
        with Image.open(path) as im:
            buf = io.BytesIO()
            save_kwargs = {"exif": exif_bytes, "quality": 100, "subsampling": 0}
            if "icc_profile" in im.info:
                save_kwargs["icc_profile"] = im.info["icc_profile"]
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.save(buf, format="JPEG", **save_kwargs)
            path.write_bytes(buf.getvalue())


def _write_png_meta(
    path: Path, meta: PhotoMeta, dt: datetime | None, combined_desc: str | None
) -> None:
    """PNG 文本块写入；PNG 本身无损，不改分辨率。"""
    with Image.open(path) as im:
        pnginfo = PngImagePlugin.PngInfo()
        if meta.title:
            pnginfo.add_text("Title", meta.title)
        if combined_desc:
            pnginfo.add_text("Description", combined_desc)
        if meta.reflection:
            pnginfo.add_text("Reflection", meta.reflection)
        if meta.location:
            pnginfo.add_text("Location", meta.location)
        if meta.lat is not None and meta.lng is not None:
            pnginfo.add_text("GPSLatitude", f"{meta.lat:.7f}")
            pnginfo.add_text("GPSLongitude", f"{meta.lng:.7f}")
        if dt:
            pnginfo.add_text("DateTime", _dt_to_exif(dt))
        xmp = _build_simple_xmp(meta)
        pnginfo.add_text("XML:com.adobe.xmp", xmp)

        buf = io.BytesIO()
        # 保持原 mode，避免调色板/透明通道被错误转换
        im.save(buf, format="PNG", pnginfo=pnginfo, compress_level=6)
        path.write_bytes(buf.getvalue())


def _write_webp_meta(
    path: Path, meta: PhotoMeta, dt: datetime | None, combined_desc: str | None
) -> None:
    exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
    if dt:
        encoded = _dt_to_exif(dt).encode("utf-8")
        exif_dict["Exif"][piexif.ExifIFD.DateTimeOriginal] = encoded
        exif_dict["0th"][piexif.ImageIFD.DateTime] = encoded
    if combined_desc:
        exif_dict["0th"][piexif.ImageIFD.ImageDescription] = combined_desc.encode("utf-8")
    if meta.title:
        exif_dict["0th"][piexif.ImageIFD.XPTitle] = meta.title.encode("utf-16le") + b"\x00\x00"
    if meta.location:
        exif_dict["0th"][piexif.ImageIFD.XPComment] = (
            f"地点:{meta.location}".encode("utf-16le") + b"\x00\x00"
        )
    _apply_gps_to_exif(exif_dict, meta.lat, meta.lng)
    exif_bytes = piexif.dump(exif_dict)
    with Image.open(path) as im:
        buf = io.BytesIO()
        im.save(buf, format="WEBP", exif=exif_bytes, lossless=True, quality=100)
        path.write_bytes(buf.getvalue())


def apply_meta_dict(path: Path, data: dict) -> PhotoMeta:
    current = read_meta(path)
    prev_location = current.location
    for key in ("datetime", "title", "description", "reflection", "location"):
        if key in data and data[key] is not None:
            setattr(current, key, data[key] if data[key] != "" else None)
    if "location" in data and data["location"] is not None:
        # 地点文本变更时同步 GPS；用户主动清空地点时才清坐标
        if current.location:
            sync_coords_from_location(current)
        elif prev_location and not current.location:
            current.lat = None
            current.lng = None
    elif current.location and (current.lat is None or current.lng is None):
        sync_coords_from_location(current)
    write_meta(path, current)
    return current
