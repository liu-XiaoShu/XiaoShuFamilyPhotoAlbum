from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

_VENDOR = Path(__file__).resolve().parents[1] / ".vendor"
if _VENDOR.exists() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import ROOT, config
from .services import album_migrate, auth, geo, image_edit, library, media_index, offline_map
from .services.heif_support import ensure_heif_support

ensure_heif_support()

STATIC = Path(__file__).parent / "static"
MAP_XYZ = ROOT / "data" / "map_pack" / "xyz"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    auth.init_db()
    try:
        media_index.init_media_tables()
        media_index.start_rebuild_async()
    except Exception:
        pass
    yield


app = FastAPI(title="小树时光相册", version="1.0.0", lifespan=lifespan)


class ConfigUpdate(BaseModel):
    album_root: Optional[str] = None
    import_root: Optional[str] = None
    album_title: Optional[str] = None


class MapPackUpdate(BaseModel):
    force: bool = False


class IngestItem(BaseModel):
    path: str
    datetime: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    reflection: Optional[str] = None
    location: Optional[str] = None


class IngestBatch(BaseModel):
    items: List[IngestItem]


class MetaUpdate(BaseModel):
    datetime: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    reflection: Optional[str] = None
    location: Optional[str] = None


class BatchMetaUpdate(BaseModel):
    paths: List[str]
    datetime: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    # 勾选哪些字段要写入（前端只传要改的）
    apply_datetime: bool = False
    apply_title: bool = False
    apply_description: bool = False
    apply_location: bool = False


class CropBox(BaseModel):
    left: float = Field(ge=0, le=1)
    top: float = Field(ge=0, le=1)
    right: float = Field(ge=0, le=1)
    bottom: float = Field(ge=0, le=1)


class EditSave(BaseModel):
    mode: str = Field(description="overwrite | save_as")
    rotate: int = 0
    crop: Optional[CropBox] = None
    delete_old: bool = True
    # 视频剪辑（秒）；图片忽略
    trim_start: Optional[float] = None
    trim_end: Optional[float] = None


class CoverUpdate(BaseModel):
    at_time: float = Field(ge=0, description="封面帧时间（秒）")


class TrashPaths(BaseModel):
    paths: List[str]


class TrashIds(BaseModel):
    ids: List[str]


class AuthSetup(BaseModel):
    username: str = "admin"
    password: str


class AuthLogin(BaseModel):
    username: str = "admin"
    password: str


class AuthPasswordChange(BaseModel):
    old_password: str
    new_password: str


class ShareCreate(BaseModel):
    label: str = "访客分享"
    can_edit: bool = False
    can_upload: bool = False
    album_scopes: List[str] = Field(default_factory=list)
    media_paths: List[str] = Field(default_factory=list)
    expires_days: Optional[int] = None


class ShareUpdate(BaseModel):
    label: Optional[str] = None
    can_edit: Optional[bool] = None
    can_upload: Optional[bool] = None
    album_scopes: Optional[List[str]] = None
    media_paths: Optional[List[str]] = None
    enabled: Optional[bool] = None


class ShareEnter(BaseModel):
    token: str


def current_principal(request: Request) -> dict:
    return auth.get_principal(request.cookies.get(auth.SESSION_COOKIE))


def require_settings(p: dict = Depends(current_principal)) -> dict:
    if not p.get("can_settings"):
        raise HTTPException(403, "需要超级用户权限")
    return p


def require_edit(p: dict = Depends(current_principal)) -> dict:
    if not p.get("can_edit"):
        raise HTTPException(403, "当前账号无权编辑")
    return p


def require_upload(p: dict = Depends(current_principal)) -> dict:
    if not p.get("can_upload"):
        raise HTTPException(403, "当前账号无权入库")
    return p


def require_trash(p: dict = Depends(current_principal)) -> dict:
    if not p.get("can_trash"):
        raise HTTPException(403, "当前账号无权使用回收站")
    return p


def require_purge(p: dict = Depends(current_principal)) -> dict:
    if not p.get("can_purge"):
        raise HTTPException(403, "仅超级用户可彻底删除")
    return p


def _guard_album_path(path: str, p: dict) -> str:
    rel = (path or "").replace("\\", "/").lstrip("/")
    if rel.startswith(".trash/") or rel == ".trash":
        if not (p.get("can_trash") or p.get("can_settings") or p.get("open_mode")):
            raise HTTPException(403, "无权访问回收站内容")
        return rel
    if not auth.path_allowed(
        rel, p.get("album_scopes") or [], p.get("media_paths") or []
    ):
        raise HTTPException(403, "无权访问该相册内容")
    return rel


def _filter_timeline(data: dict, p: dict) -> dict:
    scopes = p.get("album_scopes") or []
    media_paths = p.get("media_paths") or []
    if not scopes and not media_paths:
        return data
    years = []
    for y in data.get("years") or []:
        months = []
        for m in y.get("months") or []:
            photos = [
                ph
                for ph in (m.get("photos") or [])
                if auth.path_allowed(ph.get("path") or "", scopes, media_paths)
            ]
            if photos:
                months.append({**m, "photos": photos})
        if months:
            years.append({**y, "months": months})
    return {"years": years}


def _set_session_cookie(response: Response, token: str, request: Request | None = None) -> None:
    secure = False
    if request is not None:
        secure = request.url.scheme == "https" or (
            request.headers.get("x-forwarded-proto", "").lower() == "https"
        )
    response.set_cookie(
        key=auth.SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        secure=secure,
        max_age=auth.SESSION_DAYS * 86400,
        path="/",
    )


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "name": config.album_title,
        "version": "1.0.0",
        "author": "xiaoshu",
    }


@app.get("/api/index/status")
def index_status(p: dict = Depends(require_settings)):
    return media_index.status()


@app.post("/api/index/rebuild")
def index_rebuild(p: dict = Depends(require_settings)):
    return media_index.start_rebuild_async()


@app.get("/api/me")
def me(p: dict = Depends(current_principal)):
    return {"ok": True, **p}


@app.post("/api/auth/setup")
def auth_setup(body: AuthSetup, request: Request, response: Response):
    try:
        result = auth.setup_admin(body.username, body.password)
        token = auth.login_admin(body.username, body.password)
        _set_session_cookie(response, token, request)
        return {**result, "me": auth.get_principal(token)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/auth/login")
def auth_login(body: AuthLogin, request: Request, response: Response):
    try:
        token = auth.login_admin(body.username, body.password)
        _set_session_cookie(response, token, request)
        return {"ok": True, "me": auth.get_principal(token)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response):
    auth.logout(request.cookies.get(auth.SESSION_COOKIE))
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    return {"ok": True}


@app.post("/api/auth/password")
def auth_password(body: AuthPasswordChange, p: dict = Depends(require_settings)):
    try:
        return auth.change_admin_password(body.old_password, body.new_password)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/auth/share-enter")
def auth_share_enter(body: ShareEnter, request: Request, response: Response):
    try:
        token = auth.login_share(body.token)
        _set_session_cookie(response, token, request)
        return {"ok": True, "me": auth.get_principal(token)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/shares")
def shares_list(p: dict = Depends(require_settings)):
    return {"items": auth.list_shares()}


@app.post("/api/shares")
def shares_create(body: ShareCreate, request: Request, p: dict = Depends(require_settings)):
    scopes = [s.strip().strip("/") for s in (body.album_scopes or []) if str(s).strip()]
    paths = [s.replace("\\", "/").lstrip("/") for s in (body.media_paths or []) if str(s).strip()]
    if not scopes and not paths:
        raise HTTPException(
            400,
            "请选择要分享的年份相册，或勾选具体图片/视频（不允许空范围分享全部）",
        )
    # 选了具体文件时，以 media_paths 为准，忽略年份（避免误放开整年）
    if paths:
        scopes = []
    item = auth.create_share(
        label=body.label,
        can_edit=body.can_edit,
        can_upload=body.can_upload,
        album_scopes=scopes,
        media_paths=paths,
        expires_days=body.expires_days,
    )
    base = str(request.base_url).rstrip("/")
    item["url"] = f"{base}/?share={item['token']}"
    return {"ok": True, "item": item}


@app.put("/api/shares/{share_id}")
def shares_update(share_id: int, body: ShareUpdate, p: dict = Depends(require_settings)):
    fields = body.model_dump(exclude_unset=True)
    try:
        return {"ok": True, "item": auth.update_share(share_id, **fields)}
    except FileNotFoundError:
        raise HTTPException(404, "分享不存在")


@app.delete("/api/shares/{share_id}")
def shares_delete(share_id: int, p: dict = Depends(require_settings)):
    auth.delete_share(share_id)
    return {"ok": True}


@app.get("/api/shares/{share_id}/qr")
def shares_qr(share_id: int, request: Request, p: dict = Depends(require_settings)):
    try:
        item = auth.get_share(share_id)
    except FileNotFoundError:
        raise HTTPException(404, "分享不存在")
    base = str(request.base_url).rstrip("/")
    url = f"{base}/?share={item['token']}"
    try:
        png = auth.qr_png_bytes(url)
    except Exception as e:
        raise HTTPException(500, f"二维码生成失败: {e}")
    return Response(content=png, media_type="image/png")


def _config_payload() -> dict:
    years = [p.name for p in album_migrate.list_year_dirs(config.album_root)]
    return {
        "album_root": str(config.album_root),
        "import_root": str(config.import_root),
        "title_max_len": config.title_max_len,
        "album_title": config.album_title,
        "album_icon": config.album_icon,
        "album_icon_url": "/api/brand/icon",
        "map_pack": offline_map.pack_status(),
        "suggested_album_root": str(ROOT / "album"),
        "album_years": years,
        "album_year_count": len(years),
    }


@app.get("/api/config")
def get_config(p: dict = Depends(current_principal)):
    data = _config_payload()
    if not p.get("can_settings"):
        data = {
            "album_title": data["album_title"],
            "album_icon_url": data["album_icon_url"],
            "title_max_len": data["title_max_len"],
            "map_pack": data["map_pack"],
            "album_years": data["album_years"],
            "album_year_count": data["album_year_count"],
        }
    return data


@app.put("/api/config")
def put_config(body: ConfigUpdate, p: dict = Depends(require_settings)):
    """更新配置；修改相册根目录时搬迁 YYYY/ 年目录到新路径。"""
    migration = None
    updates: dict = {}

    if body.import_root is not None:
        ir = album_migrate.resolve_album_path(body.import_root)
        ir.mkdir(parents=True, exist_ok=True)
        updates["import_root"] = str(ir)

    if body.album_root is not None:
        old = config.album_root
        try:
            new = album_migrate.resolve_album_path(body.album_root)
            migration = album_migrate.migrate_album_root(old, new)
            updates["album_root"] = str(new)
        except Exception as e:
            raise HTTPException(400, str(e))

    if body.album_title is not None:
        title = str(body.album_title).strip() or "小树时光相册"
        if len(title) > 40:
            raise HTTPException(400, "相册名称最多 40 字")
        updates["album_title"] = title

    if updates:
        config.update(**updates)

    out = {"ok": True, **_config_payload()}
    if migration is not None:
        out["migration"] = migration
        out["message"] = migration.get("message") or "已保存"
    else:
        out["message"] = "已保存"
    return out


@app.get("/api/brand/icon")
def brand_icon():
    """自定义图标或内置默认 SVG。"""
    rel = config.album_icon
    if rel:
        fp = (ROOT / rel).resolve()
        try:
            if ROOT.resolve() in fp.parents or fp == ROOT.resolve():
                if fp.is_file():
                    return FileResponse(fp)
        except Exception:
            pass
    default = STATIC / "brand-default.svg"
    return FileResponse(default, media_type="image/svg+xml")


@app.post("/api/brand/icon")
async def brand_icon_upload(file: UploadFile = File(...), p: dict = Depends(require_settings)):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "空文件")
    if len(raw) > 2 * 1024 * 1024:
        raise HTTPException(400, "图标请小于 2MB")
    name = file.filename or "icon.png"
    ext = Path(name).suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".ico"}:
        raise HTTPException(400, "仅支持 png / jpg / webp / svg / ico")
    brand_dir = ROOT / "data" / "brand"
    brand_dir.mkdir(parents=True, exist_ok=True)
    # 清掉旧图标
    for old in brand_dir.glob("icon.*"):
        try:
            old.unlink()
        except OSError:
            pass
    dest = brand_dir / f"icon{ext}"
    dest.write_bytes(raw)
    rel = str(dest.relative_to(ROOT)).replace("\\", "/")
    config.update(album_icon=rel)
    return {"ok": True, "album_icon": rel, "album_icon_url": "/api/brand/icon", "message": "图标已更新"}


@app.delete("/api/brand/icon")
def brand_icon_reset(p: dict = Depends(require_settings)):
    brand_dir = ROOT / "data" / "brand"
    if brand_dir.is_dir():
        for old in brand_dir.glob("icon.*"):
            try:
                old.unlink()
            except OSError:
                pass
    config.update(album_icon="")
    return {"ok": True, "album_icon": "", "album_icon_url": "/api/brand/icon", "message": "已恢复默认图标"}


@app.get("/api/map/pack")
def map_pack_status():
    return offline_map.pack_status()


@app.post("/api/map/pack/update")
def map_pack_update(body: MapPackUpdate = MapPackUpdate(), p: dict = Depends(require_settings)):
    """联网更新/补全离线标准地图包（异步）。"""
    return offline_map.start_update_async(force=body.force)


@app.get("/api/geo/resolve")
def geo_resolve(q: str = ""):
    """地点文本 → 匹配级别与坐标（编辑时预览）。"""
    hit = geo.resolve_location_detail(q)
    if not hit:
        return {"ok": False, "q": q}
    return {"ok": True, "q": q, **hit}


@app.get("/api/map/tiles/{z}/{x}/{y}.png")
def map_tile(z: int, x: int, y: int):
    """兼容旧 URL；优先返回展开后的静态 PNG。"""
    if z < 0 or z > 14 or x < 0 or y < 0:
        raise HTTPException(400, "invalid tile")
    n = 1 << z
    if x >= n or y >= n:
        raise HTTPException(404, "out of range")
    static_path = MAP_XYZ / str(z) / str(x) / f"{y}.png"
    if static_path.is_file():
        return FileResponse(
            static_path,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )
    data = offline_map.read_tile(z, x, y)
    if not data:
        import base64

        data = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/import/list")
def import_list(p: dict = Depends(require_upload)):
    return {"items": library.list_import_images()}


@app.post("/api/import/upload")
async def import_upload(
    files: List[UploadFile] = File(...),
    paths: Optional[List[str]] = Form(None),
    p: dict = Depends(require_upload),
):
    path_list = paths or []
    payload = []
    for i, f in enumerate(files):
        rel = path_list[i] if i < len(path_list) and path_list[i] else (f.filename or "image")
        data = await f.read()
        payload.append((rel, data))
    return library.save_uploads(payload)


@app.post("/api/import/parse")
def import_parse(p: dict = Depends(require_upload)):
    return {"items": library.parse_import_meta()}


@app.post("/api/import/ingest")
def import_ingest(body: IngestBatch, p: dict = Depends(require_upload)):
    results = []
    for item in body.items:
        try:
            r = library.ingest_one(
                item.path,
                datetime_str=item.datetime,
                title=item.title,
                description=item.description,
                reflection=item.reflection,
                location=item.location,
                from_import=True,
            )
            results.append(r)
        except Exception as e:
            results.append({"ok": False, "path": item.path, "message": str(e)})
    return {"results": results}


@app.get("/api/timeline")
def timeline(p: dict = Depends(current_principal)):
    return _filter_timeline(library.scan_timeline(), p)


@app.get("/api/map/photos")
def map_photos(p: dict = Depends(current_principal)):
    data = library.list_map_photos()
    scopes = p.get("album_scopes") or []
    media_paths = p.get("media_paths") or []
    if not scopes and not media_paths:
        return data
    points = [
        pt
        for pt in (data.get("points") or [])
        if auth.path_allowed(pt.get("path") or "", scopes, media_paths)
    ]
    return {**data, "points": points, "total": len(points) + int(data.get("skipped") or 0)}


@app.get("/api/photo")
def photo(path: str, p: dict = Depends(current_principal)):
    try:
        path = _guard_album_path(path, p)
        return library.get_photo(path)
    except FileNotFoundError:
        raise HTTPException(404, "照片不存在")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.put("/api/photo/meta")
def photo_meta(path: str, body: MetaUpdate, p: dict = Depends(require_edit)):
    try:
        path = _guard_album_path(path, p)
        fields = body.model_dump(exclude_unset=True)
        return library.update_meta_only(path, fields)
    except FileNotFoundError:
        raise HTTPException(404, "照片不存在")
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/photo/meta/batch")
def photo_meta_batch(body: BatchMetaUpdate, p: dict = Depends(require_edit)):
    if not body.paths:
        raise HTTPException(400, "未选择照片")
    for path in body.paths:
        _guard_album_path(path, p)
    fields = {}
    if body.apply_datetime:
        fields["datetime"] = body.datetime
    if body.apply_title:
        fields["title"] = body.title
    if body.apply_description:
        fields["description"] = body.description
    if body.apply_location:
        fields["location"] = body.location
    if not fields:
        raise HTTPException(400, "请至少勾选一个要修改的字段")
    try:
        return library.update_meta_batch(body.paths, fields)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/photo/trash")
def photo_trash(body: TrashPaths, p: dict = Depends(require_edit)):
    if not body.paths:
        raise HTTPException(400, "未选择照片")
    for path in body.paths:
        _guard_album_path(path, p)
    try:
        return library.trash_batch(body.paths)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/trash")
def trash_list(sort: str = "deleted_at", p: dict = Depends(require_trash)):
    if sort not in ("deleted_at", "media_datetime"):
        raise HTTPException(400, "sort 须为 deleted_at 或 media_datetime")
    data = library.list_trash(sort=sort)
    scopes = p.get("album_scopes") or []
    if scopes:
        items = [
            it
            for it in (data.get("items") or [])
            if auth.path_allowed(it.get("original_path") or "", scopes)
        ]
        data = {**data, "items": items, "count": len(items)}
    return data


@app.post("/api/trash/restore")
def trash_restore(body: TrashIds, p: dict = Depends(require_trash)):
    if not body.ids:
        raise HTTPException(400, "未选择条目")
    try:
        return library.restore_trash(body.ids)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/trash/purge")
def trash_purge(body: TrashIds, p: dict = Depends(require_purge)):
    if not body.ids:
        raise HTTPException(400, "未选择条目")
    try:
        return library.purge_trash(body.ids)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/photo/edit")
def photo_edit(path: str, body: EditSave, p: dict = Depends(require_edit)):
    if body.mode not in ("overwrite", "save_as"):
        raise HTTPException(400, "mode 须为 overwrite 或 save_as")
    try:
        path = _guard_album_path(path, p)
        from .services.naming import is_video
        from .services import video as video_svc

        full = library.album_path(path)
        if is_video(full):
            result = video_svc.save_video_edit(
                path,
                mode=body.mode,
                rotate=body.rotate,
                trim_start=body.trim_start,
                trim_end=body.trim_end,
                delete_old=body.delete_old,
            )
        else:
            crop = body.crop.model_dump() if body.crop else None
            result = image_edit.save_edit(
                path,
                mode=body.mode,
                rotate=body.rotate,
                crop=crop,
                delete_old=body.delete_old,
            )
        for key in ("old_path", "path"):
            rel = result.get(key)
            if rel:
                library.invalidate_thumbs(rel)
        new_rel = result.get("path") or path
        try:
            library.ensure_thumb(new_rel, size=320)
            library.ensure_thumb(new_rel, size=240)
        except Exception:
            pass
        result["thumb_bust"] = int(library.album_path(new_rel).stat().st_mtime)
        return result
    except FileNotFoundError:
        raise HTTPException(404, "媒体不存在")
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/file")
def file_raw(path: str, source: str = "album", p: dict = Depends(current_principal)):
    try:
        if source == "import":
            if not p.get("can_upload"):
                raise HTTPException(403, "无权访问导入文件")
            fp = library.import_path(path)
        else:
            path = _guard_album_path(path, p)
            fp = library.album_path(path)
        if not fp.exists():
            raise HTTPException(404, "文件不存在")
        return FileResponse(fp)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/photo/cover")
def photo_cover(path: str, body: CoverUpdate, p: dict = Depends(require_edit)):
    """将视频当前时刻设为封面。"""
    try:
        path = _guard_album_path(path, p)
        return library.set_video_cover(path, body.at_time)
    except FileNotFoundError:
        raise HTTPException(404, "视频不存在")
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/photo/audio")
async def photo_audio_upload(
    path: str, file: UploadFile = File(...), p: dict = Depends(require_edit)
):
    """为图片保存旁白音频（webm/m4a 等）。"""
    try:
        path = _guard_album_path(path, p)
        data = await file.read()
        if not data:
            raise HTTPException(400, "空音频")
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(400, "旁白请小于 20MB")
        return library.save_narration(path, data, filename=file.filename)
    except FileNotFoundError:
        raise HTTPException(404, "照片不存在")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, str(e))


@app.delete("/api/photo/audio")
def photo_audio_delete(path: str, p: dict = Depends(require_edit)):
    try:
        path = _guard_album_path(path, p)
        return library.delete_narration(path)
    except FileNotFoundError:
        raise HTTPException(404, "照片不存在")
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/thumb")
def thumb(path: str, size: int = 320, p: dict = Depends(current_principal)):
    try:
        path = _guard_album_path(path, p)
        tp = library.ensure_thumb(path, size=min(max(size, 64), 800))
        return FileResponse(
            tp,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "no-cache, must-revalidate",
            },
        )
    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(404, "文件不存在")
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/preview")
def preview(
    path: str,
    source: str = "album",
    size: int = 1600,
    p: dict = Depends(current_principal),
):
    """浏览器预览图。HEIC 等转为 JPEG，不改动相册原件。"""
    import io

    from PIL import Image

    from .services.heif_support import ensure_heif_support, is_heic_path

    try:
        if source == "import":
            if not p.get("can_upload"):
                raise HTTPException(403, "无权访问导入文件")
            fp = library.import_path(path)
        else:
            path = _guard_album_path(path, p)
            fp = library.album_path(path)
        if not fp.exists():
            raise FileNotFoundError(path)
        size = min(max(int(size), 64), 2000)
        if source != "import" and is_heic_path(fp):
            rel = path
            tp = library.ensure_thumb(rel, size=size)
            return FileResponse(tp, media_type="image/jpeg")
        if is_heic_path(fp) or fp.suffix.lower() in {".tif", ".tiff", ".bmp"}:
            if is_heic_path(fp):
                ensure_heif_support()
            with Image.open(fp) as im:
                im = im.convert("RGB")
                im.thumbnail((size, size))
                buf = io.BytesIO()
                im.save(buf, format="JPEG", quality=88)
            return Response(
                content=buf.getvalue(),
                media_type="image/jpeg",
                headers={"Cache-Control": "no-cache"},
            )
        return FileResponse(fp)
    except FileNotFoundError:
        raise HTTPException(404, "文件不存在")
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/login")
def login_page():
    return FileResponse(STATIC / "login.html")


# 离线地图静态瓦片（比每次查 SQLite 快很多）
if MAP_XYZ.is_dir():
    app.mount("/map-tiles", StaticFiles(directory=str(MAP_XYZ)), name="map-tiles")

app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
