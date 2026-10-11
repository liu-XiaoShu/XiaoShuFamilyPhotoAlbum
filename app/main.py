from __future__ import annotations

import json
import mimetypes
from urllib.parse import quote
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

_VENDOR = Path(__file__).resolve().parents[1] / ".vendor"
if _VENDOR.exists() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .config import ROOT, config
from .services import album_migrate, auth, geo, image_edit, library, media_index, offline_map, visitors
from .services.heif_support import ensure_heif_support

ensure_heif_support()

STATIC = Path(__file__).parent / "static"
MAP_XYZ = ROOT / "data" / "map_pack" / "xyz"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    auth.init_db()
    try:
        visitors.init_db()
    except Exception:
        pass
    try:
        # 仅在空库或相册根变更时后台建索引；勿每次启动全量重建（首屏会卡死）
        media_index.ensure_index_ready()
    except Exception:
        pass
    try:
        from .services.dedup_scan import kick_dedup_scan

        kick_dedup_scan()
    except Exception:
        pass
    yield


app = FastAPI(title="小树时光相册", version="3.0.8", lifespan=lifespan)


def _skip_visitor_log(path: str) -> bool:
    """静态资源 / 缩略图 / 瓦片等高频请求不记访客、不查 ARP。"""
    if path in ("/styles.css", "/app.js", "/favicon.ico", "/manifest.webmanifest"):
        return True
    if path.startswith(("/vendor/", "/static/", "/assets/")):
        return True
    if path.startswith(("/api/thumb", "/api/preview", "/api/map/tiles", "/api/brand/icon")):
        return True
    if path.endswith((".js", ".css", ".map", ".woff2", ".png", ".jpg", ".webp", ".ico")):
        return True
    return False


def _setup_open(path: str) -> bool:
    """还没有超级用户时，只放行注册、登录和静态页。"""
    if path in ("/", "/login", "/favicon.ico", "/manifest.webmanifest"):
        return True
    if path.startswith(
        (
            "/api/health",
            "/api/me",
            "/api/auth/setup",
            "/api/auth/login",
            "/api/auth/share-enter",
            "/api/config",
            "/api/brand/",
            "/login",
            "/vendor/",
            "/static/",
        )
    ):
        return True
    return path.endswith((".js", ".css", ".svg", ".png", ".ico", ".webmanifest", ".woff2"))


@app.middleware("http")
async def visitor_guard_and_log(request: Request, call_next):
    path = request.url.path or "/"
    if not auth.has_admin() and not _setup_open(path):
        if path.startswith("/api/"):
            return Response(
                content='{"detail":"请先创建超级用户"}',
                status_code=403,
                media_type="application/json",
            )
        return Response(status_code=302, headers={"Location": "/login"})
    skip_log = _skip_visitor_log(path)
    headers = {k.lower(): v for k, v in request.headers.items()}
    ip = visitors._client_ip(headers, request.client.host if request.client else None)
    mac = "" if skip_log else visitors.lookup_mac(ip)
    blocked = visitors.is_blacklisted(ip, mac)
    if blocked and not path.startswith("/api/health"):
        return Response(
            content='{"detail":"访问已被限制"}',
            status_code=403,
            media_type="application/json",
        )
    response = await call_next(request)
    if skip_log:
        return response
    try:
        cookie = request.cookies.get(auth.SESSION_COOKIE) or ""
        visitors.record_visit(
            ip=ip,
            path=path,
            method=request.method,
            user_agent=headers.get("user-agent", ""),
            referer=headers.get("referer", ""),
            query=request.url.query or "",
            headers=headers,
            session_hint=cookie[:16],
        )
    except Exception:
        pass
    return response


class ConfigUpdate(BaseModel):
    album_root: Optional[str] = None
    import_root: Optional[str] = None
    thumb_root: Optional[str] = None
    album_title: Optional[str] = None
    map_provider: Optional[str] = None


class MapPackUpdate(BaseModel):
    force: bool = False


class BlacklistAdd(BaseModel):
    kind: str = Field(..., description="ip 或 mac")
    value: str
    reason: str = ""


class IngestItem(BaseModel):
    path: str
    datetime: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    reflection: Optional[str] = None
    location: Optional[str] = None
    content_hash: Optional[str] = None
    skip_meta_read: bool = False


class IngestBatch(BaseModel):
    items: List[IngestItem]


class ImportDiscard(BaseModel):
    paths: List[str] = []
    all: bool = False


class ImportParse(BaseModel):
    offset: int = 0
    limit: int = 40
    paths: Optional[List[str]] = None


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

class DedupResolve(BaseModel):
    keep: str
    remove: List[str] = Field(default_factory=list)


class DedupResolveAll(BaseModel):
    strategy: str = "oldest"  # oldest | newest



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
    if not auth.media_visible(rel, p):
        raise HTTPException(403, "无权访问该相册内容")
    return rel


def _filter_timeline(data: dict, p: dict) -> dict:
    scopes = p.get("album_scopes") or []
    media_paths = p.get("media_paths") or []
    share_id = auth.share_uploader_id(p)
    if not scopes and not media_paths and not share_id:
        return data
    years = []
    for y in data.get("years") or []:
        months = []
        for m in y.get("months") or []:
            photos = [
                ph
                for ph in (m.get("photos") or [])
                if auth.media_visible(ph.get("path") or "", p)
            ]
            if photos:
                months.append({**m, "photos": photos})
        if months:
            years.append({**y, "months": months})
    return {"years": years}


def _scope_kwargs(p: dict) -> dict:
    return {
        "scopes": p.get("album_scopes") or [],
        "media_paths": p.get("media_paths") or [],
        "uploaded_by_share_id": auth.share_uploader_id(p),
    }

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
        "version": "3.0.8",
        "released_at": "2026-10-11",
        "author": "xiaoshu",
    }


@app.get("/api/index/status")
def index_status(p: dict = Depends(require_settings)):
    return media_index.status()


@app.get("/api/visitors/summary")
def visitors_summary(p: dict = Depends(require_settings)):
    return visitors.summary()


@app.get("/api/visitors/history")
def visitors_history(
    limit: int = 200,
    offset: int = 0,
    p: dict = Depends(require_settings),
):
    return {
        "items": visitors.list_history(limit=min(max(limit, 1), 500), offset=max(offset, 0))
    }


@app.get("/api/visitors/current")
def visitors_current(p: dict = Depends(require_settings)):
    return {"items": visitors.list_current(), "window_sec": visitors._ACTIVE_WINDOW_SEC}


@app.get("/api/visitors/curve")
def visitors_curve(days: int = 14, p: dict = Depends(require_settings)):
    return {"days": days, "points": visitors.visit_curve(days=days)}


@app.get("/api/visitors/hot-media")
def visitors_hot_media(limit: int = 30, p: dict = Depends(require_settings)):
    return {"items": visitors.hot_media(limit=min(max(limit, 1), 100))}


@app.get("/api/visitors/uploads")
def visitors_uploads(
    limit: int = 80,
    offset: int = 0,
    share_id: int | None = None,
    p: dict = Depends(require_settings),
):
    return visitors.list_ingests(
        limit=limit, offset=offset, share_id=share_id
    )


@app.get("/api/visitors/uploads/stats")
def visitors_uploads_stats(p: dict = Depends(require_settings)):
    return visitors.ingest_share_stats()


@app.get("/api/visitors/blacklist")
def visitors_blacklist_get(p: dict = Depends(require_settings)):
    return {"items": visitors.list_blacklist()}


@app.post("/api/visitors/blacklist")
def visitors_blacklist_add(body: BlacklistAdd, p: dict = Depends(require_settings)):
    try:
        item = visitors.add_blacklist(body.kind, body.value, body.reason or "")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "item": item}


@app.delete("/api/visitors/blacklist/{item_id}")
def visitors_blacklist_del(item_id: int, p: dict = Depends(require_settings)):
    ok = visitors.remove_blacklist(item_id)
    if not ok:
        raise HTTPException(404, "未找到该黑名单项")
    return {"ok": True}


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


def _config_payload(*, include_stats: bool = True) -> dict:
    years = [p.name for p in album_migrate.list_year_dirs(config.album_root)]
    data = {
        "album_root": str(config.album_root),
        "import_root": str(config.import_root),
        "thumb_root": str(config.thumb_root),
        "title_max_len": config.title_max_len,
        "album_title": config.album_title,
        "album_icon": config.album_icon,
        "album_icon_url": "/api/brand/icon",
        "map_provider": config.map_provider,
        "suggested_album_root": str(ROOT / "album"),
        "suggested_thumb_root": str(ROOT / "data" / "thumbs"),
        "album_years": years,
        "album_year_count": len(years),
    }
    if include_stats:
        thumb_stats = album_migrate.thumb_dir_stats(config.thumb_root)
        data["thumb_count"] = thumb_stats["count"]
        data["thumb_bytes"] = thumb_stats["bytes"]
        data["map_pack"] = offline_map.pack_status()
    else:
        data["thumb_count"] = 0
        data["thumb_bytes"] = 0
        # 轻量：仅 provider，不计瓦片（避免首屏扫盘）
        data["map_pack"] = {
            "ready": True,
            "provider_mode": offline_map.effective_provider(),
            "map_provider_pref": config.map_provider,
            "needs_gcj02": offline_map.effective_provider() == "amap",
            "max_zoom": 18 if offline_map.effective_provider() == "amap" else 11,
            "attribution": "© 高德地图"
            if offline_map.effective_provider() == "amap"
            else "© OpenStreetMap",
        }
    return data


@app.get("/api/config")
def get_config(p: dict = Depends(current_principal), stats: int = 0):
    # 首屏默认 light；设置页传 ?stats=1 再拉缩略图/地图包统计
    want_stats = bool(stats) and bool(p.get("can_settings"))
    data = _config_payload(include_stats=want_stats)
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
    thumb_migration = None
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

    if body.thumb_root is not None:
        old_t = config.thumb_root
        try:
            new_t = album_migrate.resolve_album_path(body.thumb_root)
            thumb_migration = album_migrate.migrate_thumb_root(old_t, new_t)
            updates["thumb_root"] = str(new_t)
        except Exception as e:
            raise HTTPException(400, str(e))

    if body.album_title is not None:
        title = str(body.album_title).strip() or "小树时光相册"
        if len(title) > 40:
            raise HTTPException(400, "相册名称最多 40 字")
        updates["album_title"] = title

    if body.map_provider is not None:
        mp = str(body.map_provider).strip().lower()
        if mp not in {"auto", "amap", "offline"}:
            raise HTTPException(400, "map_provider 须为 auto / amap / offline")
        updates["map_provider"] = mp

    if updates:
        config.update(**updates)
        if "map_provider" in updates:
            # 底图偏好变更后立刻失效 pack 缓存，避免仍显示旧「高德/离线」
            offline_map.invalidate_pack_status_cache()

    out = {"ok": True, **_config_payload(include_stats=True)}
    out["map_provider"] = config.map_provider
    out["map_pack"] = offline_map.pack_status()
    messages = []
    if migration is not None:
        out["migration"] = migration
        if migration.get("message"):
            messages.append(migration["message"])
    if thumb_migration is not None:
        out["thumb_migration"] = thumb_migration
        if thumb_migration.get("message"):
            messages.append(thumb_migration["message"])
    out["message"] = "；".join(messages) if messages else "已保存"
    return out


@app.get("/api/brand/icon")
def brand_icon():
    """自定义图标或内置默认 SVG。"""
    candidates: list[Path] = []
    rel = config.album_icon
    if rel:
        candidates.append((ROOT / rel).resolve())
    brand_dir = ROOT / "data" / "brand"
    if brand_dir.is_dir():
        for ext in (".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".ico"):
            candidates.append((brand_dir / f"icon{ext}").resolve())
    root_res = ROOT.resolve()
    for fp in candidates:
        try:
            if not fp.is_file():
                continue
            if root_res not in fp.parents and fp != root_res:
                continue
            media = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp",
                ".svg": "image/svg+xml",
                ".gif": "image/gif",
                ".ico": "image/x-icon",
            }.get(fp.suffix.lower(), "application/octet-stream")
            return FileResponse(
                fp,
                media_type=media,
                headers={"Cache-Control": "no-cache"},
            )
        except Exception:
            continue
    default = STATIC / "brand-default.svg"
    return FileResponse(
        default,
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-cache"},
    )


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
    for old in brand_dir.glob("icon.*"):
        try:
            old.unlink()
        except OSError:
            pass
    dest = brand_dir / f"icon{ext}"
    dest.write_bytes(raw)
    rel = str(dest.relative_to(ROOT)).replace("\\", "/")
    try:
        config.update(album_icon=rel)
    except OSError as e:
        raise HTTPException(500, f"图标已保存，但写入配置失败：{e}") from e
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
    """底图瓦片：高德在线缓存 / 离线包 → 透明占位。"""
    if z < 0 or z > 18 or x < 0 or y < 0:
        raise HTTPException(400, "invalid tile")
    n = 1 << z
    if x >= n or y >= n:
        raise HTTPException(404, "out of range")
    # 优先直接发文件（树莓派 sendfile 比读入内存更快）
    cached = offline_map.tile_cache_path(z, x, y)
    cache_hdr = (
        "public, max-age=604800"
        if offline_map.effective_provider() == "amap"
        else "public, max-age=86400"
    )
    if cached is not None and cached.is_file() and cached.stat().st_size >= 50:
        return FileResponse(
            cached,
            media_type="image/png",
            headers={"Cache-Control": cache_hdr},
        )
    data = offline_map.resolve_map_tile(z, x, y)
    if not data:
        import base64

        data = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
    # 刚写入缓存则再走文件
    cached2 = offline_map.tile_cache_path(z, x, y)
    if cached2 is not None and cached2.is_file() and cached2.stat().st_size >= 50:
        return FileResponse(
            cached2,
            media_type="image/png",
            headers={"Cache-Control": cache_hdr},
        )
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": cache_hdr},
    )


@app.get("/api/import/list")
def import_list(p: dict = Depends(require_upload)):
    """默认不读 EXIF，首屏快；点「解析」走 /api/import/parse。"""
    return {"items": library.list_import_images(with_meta=False)}


@app.post("/api/import/upload")
async def import_upload(
    files: List[UploadFile] = File(...),
    paths: Optional[List[str]] = Form(None),
    p: dict = Depends(require_upload),
):
    """流式写入导入目录，避免大视频整文件进内存。"""
    from .services.naming import MEDIA_EXTS, unique_path
    path_list = paths or []
    root = config.import_root
    root.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []
    skipped: list[str] = []
    for i, f in enumerate(files):
        rel = path_list[i] if i < len(path_list) and path_list[i] else (f.filename or "image")
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
        try:
            with dest.open("wb") as out:
                while True:
                    chunk = await f.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            from .services.ops import ensure_host_perms
            ensure_host_perms(dest.parent, is_dir=True)
            ensure_host_perms(dest)
            saved.append(str(dest.relative_to(root)).replace("\\", "/"))
        except Exception:
            try:
                if dest.exists():
                    dest.unlink()
            except OSError:
                pass
            skipped.append("/".join(parts))
        finally:
            await f.close()
    return {"ok": True, "saved": saved, "skipped": skipped, "count": len(saved)}


@app.post("/api/import/parse")
def import_parse(body: Optional[ImportParse] = None, p: dict = Depends(require_upload)):
    """分片解析，并用数据库里的内容指纹标出相册已有的相同文件。"""
    from .services.metadata import read_meta
    from .services.ops import content_hash_of

    req = body or ImportParse()
    items = library.list_import_images(with_meta=False)
    if req.paths:
        wanted = {str(p).replace("\\", "/").lstrip("/") for p in req.paths if p}
        items = [it for it in items if it.get("path") in wanted]
    total = len(items)
    offset = max(0, int(req.offset or 0))
    limit = max(1, min(int(req.limit or 40), 80))
    chunk = items[offset : offset + limit]
    out = []
    album_dups = 0
    for it in chunk:
        rel = it["path"]
        row = dict(it)
        full = library.import_path(rel)
        try:
            row["meta"] = read_meta(full).to_dict()
        except Exception:
            row["meta"] = it.get("meta") or {}
        try:
            digest = content_hash_of(full) if full.is_file() else ""
        except OSError:
            digest = ""
        found = []
        if digest:
            found = [
                p
                for p in media_index.paths_by_content_hash(digest)
                if p and not str(p).startswith(".trash/")
            ]
        row["content_hash"] = digest
        row["duplicate"] = bool(found)
        row["duplicate_of"] = found
        if found:
            album_dups += 1
        out.append(row)
    processed = offset + len(out)
    done = processed >= total
    if done:
        msg = (
            f"解析完成：相册已有重复 {album_dups} 项"
            if album_dups
            else "解析完成：未发现与相册重复的内容"
        )
    else:
        msg = f"正在解析… {processed}/{total}"
    return {
        "items": out,
        "offset": offset,
        "processed": processed,
        "total": total,
        "done": done,
        "duplicate_album": album_dups,
        "duplicate_inbox": 0,
        "message": msg,
    }


@app.post("/api/import/discard")
def import_discard(body: ImportDiscard, p: dict = Depends(require_upload)):
    """从待入库区移除（不进相册）。all=true 清空全部。"""
    if not body.all and not body.paths:
        raise HTTPException(400, "请指定要移除的路径，或 all=true 清空")
    return library.discard_import(paths=body.paths, all_items=body.all)


@app.post("/api/import/ingest")
def import_ingest(
    body: IngestBatch,
    background_tasks: BackgroundTasks,
    p: dict = Depends(require_upload),
):
    uploader = auth.share_uploader_id(p)
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
                uploaded_by_share_id=uploader,
                content_hash=item.content_hash,
                skip_meta_read=bool(item.skip_meta_read),
            )
            if r.get("ok"):
                album_rel = r.get("path") or ""
                try:
                    size = 0
                    kind = "image"
                    try:
                        fp = library.album_path(album_rel)
                        size = fp.stat().st_size if fp.is_file() else 0
                        from .services.naming import is_video

                        kind = "video" if is_video(fp) else "image"
                    except Exception:
                        pass
                    visitors.record_ingest(
                        principal=p,
                        path=album_rel,
                        name=Path(album_rel).name,
                        kind=kind,
                        size=size,
                        title=item.title or "",
                    )
                except Exception:
                    pass
                # 入库成功后后台预热经典模式常用 320 缩略图（不阻塞响应）
                if album_rel and not r.get("duplicate"):
                    background_tasks.add_task(library.ensure_thumb, album_rel, 320)
            results.append(r)
        except Exception as e:
            results.append({"ok": False, "path": item.path, "message": str(e)})
    return {"results": results}




@app.get("/api/storage")
def storage_stats(force: bool = False, p: dict = Depends(require_settings)):
    """仅超级用户：磁盘与各目录占用。force=1 时强制重扫旁路目录。"""
    from .services import ops
    return ops.storage_overview(force=force)


@app.get("/api/search")
def search_photos(
    q: str = "",
    limit: int = 60,
    offset: int = 0,
    p: dict = Depends(current_principal),
):
    return media_index.search_media(
        q,
        limit=limit,
        offset=offset,
        **_scope_kwargs(p),
    )


@app.get("/api/dedup")
def dedup_list(limit: int = 500, p: dict = Depends(require_settings)):
    from .services import ops
    from .services.dedup_scan import hash_coverage, public_state

    cap = max(1, min(int(limit or 500), 500))
    data = ops.list_duplicate_groups(limit=cap)
    cov = hash_coverage()
    data["missing"] = cov["missing"]
    data["hashed"] = cov["hashed"]
    data["total"] = cov["total"]
    data["needs_rehash"] = cov["needs_rehash"]
    data["scan"] = public_state()
    if len(data.get("groups") or []) >= cap:
        data["truncated"] = True
    return data


@app.get("/api/dedup/scan")
def dedup_scan_status(p: dict = Depends(require_settings)):
    from .services.dedup_scan import hash_coverage, public_state

    snap = public_state()
    cov = hash_coverage()
    return {
        "ok": True,
        "running": snap.get("running"),
        "done": snap.get("done") or 0,
        "updated": snap.get("updated") or 0,
        "failed": snap.get("failed") or 0,
        "error": snap.get("error"),
        "finished_at": snap.get("finished_at"),
        **cov,
    }


@app.post("/api/dedup/scan")
def dedup_scan(force: bool = False, p: dict = Depends(require_settings)):
    """后台补算或按去元数据内容重算指纹。"""
    from .services.dedup_scan import hash_coverage, public_state, start_dedup_scan

    cov = hash_coverage()
    if cov["needs_rehash"]:
        force = True
    if not force and cov["missing"] <= 0:
        st = public_state()
        st.update({"ok": True, "started": False, "message": "指纹已齐全", **cov})
        return st
    started = start_dedup_scan(force=force)
    started.update(hash_coverage())
    return started


@app.post("/api/dedup/resolve")
def dedup_resolve(body: DedupResolve, p: dict = Depends(require_settings)):
    """保留 keep，将其余 remove 移入回收站。"""
    keep = (body.keep or "").replace("\\", "/").lstrip("/")
    remove = [(x or "").replace("\\", "/").lstrip("/") for x in (body.remove or []) if x]
    remove = [x for x in remove if x and x != keep]
    if not keep:
        raise HTTPException(400, "请指定要保留的文件")
    if not remove:
        return {"ok": True, "trashed": 0, "message": "没有需要处理的重复项"}
    _guard_album_path(keep, p)
    for rel in remove:
        _guard_album_path(rel, p)
    try:
        r = library.trash_batch(remove)
        return {
            "ok": True,
            "keep": keep,
            "trashed": sum(1 for x in (r.get("results") or []) if x.get("ok")),
            "results": r.get("results") or [],
            "message": f"已保留 1 项，移入回收站 {sum(1 for x in (r.get('results') or []) if x.get('ok'))} 项",
        }
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/dedup/resolve-all")
def dedup_resolve_all(body: DedupResolveAll = DedupResolveAll(), p: dict = Depends(require_settings)):
    """每组重复自动保留一份（最早或最新），其余进回收站。"""
    from .services import ops
    strategy = (body.strategy or "oldest").lower()
    if strategy not in ("oldest", "newest"):
        raise HTTPException(400, "strategy 须为 oldest 或 newest")
    data = ops.list_duplicate_groups(limit=500)
    kept = 0
    trashed = 0
    details = []
    for g in data.get("groups") or []:
        items = list(g.get("items") or [])
        if len(items) < 2:
            continue
        items.sort(key=lambda it: (it.get("datetime") or "", it.get("path") or ""))
        keep_it = items[0] if strategy == "oldest" else items[-1]
        remove = [it["path"] for it in items if it["path"] != keep_it["path"]]
        for rel in remove:
            _guard_album_path(rel, p)
        _guard_album_path(keep_it["path"], p)
        r = library.trash_batch(remove)
        n = sum(1 for x in (r.get("results") or []) if x.get("ok"))
        kept += 1
        trashed += n
        details.append({"keep": keep_it["path"], "trashed": n})
    return {
        "ok": True,
        "groups": kept,
        "trashed": trashed,
        "details": details,
        "message": f"已处理 {kept} 组，移入回收站 {trashed} 项",
    }

@app.get("/api/timeline")
def timeline(p: dict = Depends(current_principal)):
    return _filter_timeline(library.scan_timeline(), p)


@app.get("/api/timeline/outline")
def timeline_outline(
    brief: int = 0,
    p: dict = Depends(current_principal),
):
    data = library.timeline_outline(
        **_scope_kwargs(p),
        brief=bool(brief),
    )
    # 大纲可短缓存；入库后服务端会清 SQLite 缓存
    headers = {"Cache-Control": "private, max-age=15"}
    if data.get("from_cache"):
        headers["X-Album-Cache"] = "HIT"
    return Response(
        content=json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        media_type="application/json",
        headers=headers,
    )


@app.get("/api/timeline/month")
def timeline_month(
    month: str,
    limit: int = 200,
    offset: int = 0,
    p: dict = Depends(current_principal),
):
    return library.timeline_month(
        month,
        limit=limit,
        offset=offset,
        **_scope_kwargs(p),
    )


@app.get("/api/timeline/paths")
def timeline_paths(
    year: str | None = None,
    month: str | None = None,
    p: dict = Depends(current_principal),
):
    return library.timeline_paths(
        year=year,
        month=month,
        **_scope_kwargs(p),
    )


def _maybe_gcj02_points(points: list, provider: str) -> tuple[list, str]:
    if provider != "amap":
        return points, "wgs84"
    from .services.coord import wgs84_to_gcj02

    converted = []
    for pt in points:
        try:
            lat, lng = wgs84_to_gcj02(float(pt["lat"]), float(pt["lng"]))
        except (TypeError, ValueError, KeyError):
            converted.append(pt)
            continue
        converted.append({**pt, "lat": lat, "lng": lng, "coord": "gcj02"})
    return converted, "gcj02"


@app.get("/api/map/summary")
def map_summary(p: dict = Depends(current_principal)):
    data = library.map_summary(**_scope_kwargs(p))
    provider = offline_map.effective_provider()
    bounds = data.get("bounds")
    if provider == "amap" and bounds:
        from .services.coord import wgs84_to_gcj02

        try:
            s, w = wgs84_to_gcj02(bounds["south"], bounds["west"])
            n, e = wgs84_to_gcj02(bounds["north"], bounds["east"])
            data = {
                **data,
                "bounds": {
                    "south": min(s, n),
                    "north": max(s, n),
                    "west": min(w, e),
                    "east": max(w, e),
                },
                "coord_system": "gcj02",
            }
        except (TypeError, ValueError, KeyError):
            data = {**data, "coord_system": "wgs84"}
    else:
        data = {**data, "coord_system": "wgs84" if provider != "amap" else "gcj02"}
    data["map_mode"] = provider
    return data


@app.get("/api/map/clusters")
def map_clusters(
    zoom: int = 4,
    west: float | None = None,
    south: float | None = None,
    east: float | None = None,
    north: float | None = None,
    limit: int = 800,
    p: dict = Depends(current_principal),
):
    data = library.map_clusters(
        zoom,
        west=west,
        south=south,
        east=east,
        north=north,
        limit=limit,
        **_scope_kwargs(p),
    )
    provider = offline_map.effective_provider()
    clusters = []
    for c in data.get("clusters") or []:
        cover = c.get("cover")
        covers, _ = _maybe_gcj02_points([cover] if cover else [], provider)
        pts, coord = _maybe_gcj02_points(
            [{"lat": c["lat"], "lng": c["lng"]}], provider
        )
        clusters.append(
            {
                **c,
                "lat": pts[0]["lat"] if pts else c["lat"],
                "lng": pts[0]["lng"] if pts else c["lng"],
                "cover": covers[0] if covers else cover,
            }
        )
    return {
        **data,
        "clusters": clusters,
        "coord_system": "gcj02" if provider == "amap" else "wgs84",
        "map_mode": provider,
    }


@app.get("/api/map/cluster")
def map_cluster_detail(
    gy: int,
    gx: int,
    cell: float,
    limit: int = 200,
    offset: int = 0,
    p: dict = Depends(current_principal),
):
    data = library.map_cluster_photos(
        gy=gy,
        gx=gx,
        cell=cell,
        limit=limit,
        offset=offset,
        **_scope_kwargs(p),
    )
    provider = offline_map.effective_provider()
    photos, coord = _maybe_gcj02_points(data.get("photos") or [], provider)
    center, _ = _maybe_gcj02_points(
        [{"lat": data.get("lat") or 0, "lng": data.get("lng") or 0}], provider
    )
    return {
        **data,
        "photos": photos,
        "lat": center[0]["lat"] if center else data.get("lat"),
        "lng": center[0]["lng"] if center else data.get("lng"),
        "coord_system": coord,
        "map_mode": provider,
    }


@app.get("/api/map/photos")
def map_photos(p: dict = Depends(current_principal)):
    data = library.list_map_photos()
    scopes = p.get("album_scopes") or []
    media_paths = p.get("media_paths") or []
    share_id = auth.share_uploader_id(p)
    if scopes or media_paths or share_id:
        points = [
            pt
            for pt in (data.get("points") or [])
            if auth.media_visible(pt.get("path") or "", p)
        ]
        data = {**data, "points": points, "total": len(points) + int(data.get("skipped") or 0)}
    # 高德底图为 GCJ-02，照片 GPS 为 WGS-84，需转换以免点位偏移
    provider = offline_map.effective_provider()
    points, coord = _maybe_gcj02_points(data.get("points") or [], provider)
    data = {**data, "points": points, "coord_system": coord}
    data["map_mode"] = provider
    return data


def _photo_from_index(path: str) -> dict | None:
    row = media_index.indexed_photo(path)
    if not row or row.get("kind") == "video":
        return None
    try:
        full = library.album_path(path)
        narr = library.narration_file(full)
        if narr and narr.is_file():
            row["has_audio"] = True
            row["audio_path"] = str(narr.relative_to(config.album_root)).replace("\\", "/")
        from .services.ops import live_video_for

        live = live_video_for(full)
        if live is not None:
            row["has_live"] = True
            row["live_video_path"] = str(live.relative_to(config.album_root)).replace("\\", "/")
    except Exception:
        pass
    return row


@app.get("/api/photo")
def photo(path: str, p: dict = Depends(current_principal)):
    try:
        path = _guard_album_path(path, p)
        cached = _photo_from_index(path)
        if cached:
            return cached
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
    # 超管看全部；分享访客仅看自己可见范围的条目
    if not (p.get("is_admin") or p.get("open_mode")):
        items = [
            it
            for it in (data.get("items") or [])
            if auth.media_visible(it.get("original_path") or "", p)
        ]
        data = {**data, "items": items, "count": len(items)}
    return data


def _trash_ids_visible(ids: list[str], p: dict) -> list[str]:
    """恢复/删除前校验条目对当前主体可见。"""
    if p.get("is_admin") or p.get("open_mode"):
        return ids
    allowed = []
    data = library.list_trash()
    by_id = {it.get("id"): it for it in (data.get("items") or [])}
    for tid in ids:
        it = by_id.get(tid)
        if not it:
            continue
        if auth.media_visible(it.get("original_path") or "", p):
            allowed.append(tid)
    return allowed


@app.post("/api/trash/restore")
def trash_restore(body: TrashIds, p: dict = Depends(require_trash)):
    if not body.ids:
        raise HTTPException(400, "未选择条目")
    ids = _trash_ids_visible(body.ids, p)
    if not ids:
        raise HTTPException(403, "无权操作所选回收站条目")
    try:
        return library.restore_trash(ids)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/trash/purge")
def trash_purge(body: TrashIds, p: dict = Depends(require_purge)):
    if not body.ids:
        raise HTTPException(400, "未选择条目")
    # 彻底删除仅超管（require_purge）；仍按 id 列表执行
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
        media_type, _ = mimetypes.guess_type(str(fp))
        return FileResponse(
            fp,
            media_type=media_type or "application/octet-stream",
            headers={"Cache-Control": "private, max-age=120"},
        )
    except ValueError as e:
        raise HTTPException(400, str(e))



@app.get("/api/download")
def download_file(path: str, source: str = "album", p: dict = Depends(current_principal)):
    """下载原文件（附件方式，触发浏览器保存）。"""
    try:
        if source == "import":
            if not (p.get("can_upload") or p.get("open_mode")):
                raise HTTPException(403, "无权下载导入区文件")
            fp = library.import_path(path)
            filename = fp.name
        else:
            path = _guard_album_path(path, p)
            fp = library.album_path(path)
            filename = Path(path).name or fp.name
        if not fp.exists() or not fp.is_file():
            raise HTTPException(404, "文件不存在")
        media_type, _ = mimetypes.guess_type(str(fp))
        media_type = media_type or "application/octet-stream"
        # RFC 5987：中文文件名
        star = quote(filename)
        headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{star}",
            "Cache-Control": "no-store",
        }
        return FileResponse(fp, media_type=media_type, filename=filename, headers=headers)
    except HTTPException:
        raise
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
async def thumb(path: str, size: int = 320, p: dict = Depends(current_principal)):
    try:
        path = _guard_album_path(path, p)
        size = library.normalize_thumb_size(min(max(int(size or 320), 64), 1600))
        tp = await run_in_threadpool(library.ensure_thumb, path, size)
        mtime = int(tp.stat().st_mtime)
        return FileResponse(
            tp,
            media_type="image/jpeg",
            headers={
                # 缩略图文件名含尺寸哈希，允许浏览器强缓存，减轻树莓派重复编码
                "Cache-Control": "public, max-age=604800, immutable",
                "ETag": f'"{mtime}-{size}"',
            },
        )
    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(404, "文件不存在")
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/preview")
async def preview(
    path: str,
    source: str = "album",
    size: int = 1600,
    p: dict = Depends(current_principal),
):
    """浏览器预览图。按 size 缩小并落盘缓存，不改动相册/导入原件。"""
    try:
        if source == "import":
            if not p.get("can_upload"):
                raise HTTPException(403, "无权访问导入文件")
            fp = library.import_path(path)
            if not fp.exists():
                raise FileNotFoundError(path)
            size = library.normalize_thumb_size(min(max(int(size), 64), 1600))
            tp = await run_in_threadpool(library.ensure_import_preview, path, size)
            mtime = int(tp.stat().st_mtime)
            return FileResponse(
                tp,
                media_type="image/jpeg",
                headers={
                    "Cache-Control": "private, max-age=3600",
                    "ETag": f'"{mtime}-import-prev-{size}"',
                },
            )
        path = _guard_album_path(path, p)
        fp = library.album_path(path)
        if not fp.exists():
            raise FileNotFoundError(path)
        # 看图预览上限 1600：对单反原图足够清晰，体积远小于 10MB+ 原件
        size = library.normalize_thumb_size(min(max(int(size), 64), 1600))
        tp = await run_in_threadpool(library.ensure_preview, path, size)
        mtime = int(tp.stat().st_mtime)
        return FileResponse(
            tp,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "public, max-age=604800, immutable",
                "ETag": f'"{mtime}-prev-{size}"',
            },
        )
    except FileNotFoundError:
        raise HTTPException(404, "文件不存在")
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/")
def index():
    return FileResponse(
        STATIC / "index.html",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/app.js")
def serve_app_js():
    return FileResponse(
        STATIC / "app.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/styles.css")
def serve_styles_css():
    return FileResponse(
        STATIC / "styles.css",
        media_type="text/css",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/login")
def login_page():
    return FileResponse(
        STATIC / "login.html",
        headers={"Cache-Control": "no-cache"},
    )


# 离线地图静态瓦片（比每次查 SQLite 快很多）
if MAP_XYZ.is_dir():
    app.mount("/map-tiles", StaticFiles(directory=str(MAP_XYZ)), name="map-tiles")

app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
