"""鉴权与分享：SQLite（data/auth.sqlite）存管理员、会话、分享链接。"""
from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from ..config import ROOT

DB_PATH = ROOT / "data" / "auth.sqlite"
SESSION_COOKIE = "xiaoshu_session"
SESSION_DAYS = 30
PBKDF2_ITERS = 120_000


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat(timespec="seconds")


def _hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERS
    )
    return f"pbkdf2${PBKDF2_ITERS}${salt.hex()}${digest.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters_s, salt_hex, dig_hex = stored.split("$", 3)
        if algo != "pbkdf2":
            return False
        iters = int(iters_s)
        salt = bytes.fromhex(salt_hex)
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iters
        )
        return secrets.compare_digest(digest.hex(), dig_hex)
    except Exception:
        return False


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init_db() -> None:
    with connect() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS admin (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              username TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS shares (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              token TEXT NOT NULL UNIQUE,
              label TEXT,
              can_edit INTEGER NOT NULL DEFAULT 0,
              can_upload INTEGER NOT NULL DEFAULT 0,
              album_scopes TEXT NOT NULL DEFAULT '[]',
              media_paths TEXT NOT NULL DEFAULT '[]',
              enabled INTEGER NOT NULL DEFAULT 1,
              expires_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              share_id INTEGER,
              expires_at TEXT NOT NULL,
              created_at TEXT NOT NULL,
              last_seen_at TEXT,
              FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
            CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
            """
        )
        cols = {r[1] for r in con.execute("PRAGMA table_info(shares)").fetchall()}
        if "media_paths" not in cols:
            con.execute(
                "ALTER TABLE shares ADD COLUMN media_paths TEXT NOT NULL DEFAULT '[]'"
            )


def has_admin() -> bool:
    with connect() as con:
        row = con.execute("SELECT 1 FROM admin WHERE id = 1").fetchone()
        return bool(row)


def setup_admin(username: str, password: str) -> dict:
    username = (username or "").strip() or "admin"
    _validate_password(password)
    if has_admin():
        raise ValueError("管理员已存在，请直接登录")
    now = _iso()
    with connect() as con:
        con.execute(
            "INSERT INTO admin (id, username, password_hash, created_at, updated_at) VALUES (1,?,?,?,?)",
            (username, _hash_password(password), now, now),
        )
    return {"ok": True, "username": username, "message": "超级用户已创建"}


def _validate_password(password: str) -> None:
    if len(password) < 8:
        raise ValueError("密码至少 8 位")
    if password.strip() != password or not password.strip():
        raise ValueError("密码首尾不能有空格")
    classes = 0
    if any(c.islower() for c in password):
        classes += 1
    if any(c.isupper() for c in password):
        classes += 1
    if any(c.isdigit() for c in password):
        classes += 1
    if any(not c.isalnum() for c in password):
        classes += 1
    if classes < 2:
        raise ValueError("密码需至少包含字母与数字（或符号）两类")


def change_admin_password(old_password: str, new_password: str) -> dict:
    _validate_password(new_password)
    with connect() as con:
        row = con.execute("SELECT password_hash FROM admin WHERE id = 1").fetchone()
        if not row:
            raise ValueError("尚未创建超级用户")
        if not _verify_password(old_password, row["password_hash"]):
            raise ValueError("原密码不正确")
        con.execute(
            "UPDATE admin SET password_hash = ?, updated_at = ? WHERE id = 1",
            (_hash_password(new_password), _iso()),
        )
    return {"ok": True, "message": "密码已更新"}


def reset_admin_password(new_password: str, *, username: str | None = None) -> dict:
    """本机脚本重置：无需旧密码。可选改用户名。"""
    _validate_password(new_password)
    with connect() as con:
        row = con.execute("SELECT username FROM admin WHERE id = 1").fetchone()
        if not row:
            raise ValueError("尚未创建超级用户，请先启动服务并在页面初始化")
        name = (username or "").strip() or row["username"]
        con.execute(
            "UPDATE admin SET username = ?, password_hash = ?, updated_at = ? WHERE id = 1",
            (name, _hash_password(new_password), _iso()),
        )
        # 作废全部会话，强制重新登录
        con.execute("DELETE FROM sessions")
    return {"ok": True, "username": name, "message": f"已重置超级用户「{name}」密码，请重新登录"}


def login_admin(username: str, password: str) -> str:
    with connect() as con:
        row = con.execute(
            "SELECT username, password_hash FROM admin WHERE id = 1"
        ).fetchone()
        if not row:
            raise ValueError("尚未创建超级用户，请先初始化")
        if username.strip() and username.strip() != row["username"]:
            raise ValueError("用户名或密码错误")
        if not _verify_password(password, row["password_hash"]):
            raise ValueError("用户名或密码错误")
        return _create_session(con, kind="admin", share_id=None)


def login_share(share_token: str) -> str:
    token = (share_token or "").strip()
    if not token:
        raise ValueError("无效的分享码")
    with connect() as con:
        row = con.execute(
            "SELECT * FROM shares WHERE token = ? AND enabled = 1", (token,)
        ).fetchone()
        if not row:
            raise ValueError("分享链接无效或已停用")
        if row["expires_at"]:
            try:
                exp = datetime.fromisoformat(row["expires_at"])
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                if exp < _now():
                    raise ValueError("分享链接已过期")
            except ValueError as e:
                if "过期" in str(e) or "无效" in str(e):
                    raise
        return _create_session(con, kind="share", share_id=int(row["id"]))


def _create_session(
    con: sqlite3.Connection, *, kind: str, share_id: int | None
) -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    expires = now + timedelta(days=SESSION_DAYS)
    con.execute(
        "INSERT INTO sessions (token, kind, share_id, expires_at, created_at, last_seen_at) VALUES (?,?,?,?,?,?)",
        (token, kind, share_id, _iso(expires), _iso(now), _iso(now)),
    )
    return token


def logout(session_token: str | None) -> None:
    if not session_token:
        return
    with connect() as con:
        con.execute("DELETE FROM sessions WHERE token = ?", (session_token,))


def _parse_scopes(raw: str | None) -> list[str]:
    try:
        data = json.loads(raw or "[]")
        if isinstance(data, list):
            return [str(x).strip().replace("\\", "/") for x in data if str(x).strip()]
    except json.JSONDecodeError:
        pass
    return []


def get_principal(session_token: str | None) -> dict[str, Any]:
    """返回当前身份能力。无会话且未建管理员 → 视为本机开放模式（兼容旧用法）。"""
    open_mode = not has_admin()
    # 已启用超管后：未登录访客默认不可浏览任何媒资（须走分享会话）
    deny_paths = [] if open_mode else ["__none__"]
    base = {
        "authenticated": False,
        "kind": "anonymous",
        "username": None,
        "is_admin": False,
        "can_edit": open_mode,
        "can_upload": open_mode,
        "can_settings": open_mode,
        "can_trash": open_mode,
        "can_purge": open_mode,
        "album_scopes": [],  # 空 = 全部（仅 open_mode / 超管）
        "media_paths": deny_paths,  # 非空 = 仅这些文件；__none__ 表示拒绝全部
        "needs_setup": open_mode,
        "open_mode": open_mode,
        "share_label": None,
    }
    if not session_token:
        return base

    with connect() as con:
        row = con.execute(
            "SELECT * FROM sessions WHERE token = ?", (session_token,)
        ).fetchone()
        if not row:
            return base
        try:
            exp = datetime.fromisoformat(row["expires_at"])
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if exp < _now():
                con.execute("DELETE FROM sessions WHERE token = ?", (session_token,))
                return base
        except ValueError:
            con.execute("DELETE FROM sessions WHERE token = ?", (session_token,))
            return base

        con.execute(
            "UPDATE sessions SET last_seen_at = ? WHERE token = ?",
            (_iso(), session_token),
        )

        if row["kind"] == "admin":
            admin = con.execute("SELECT username FROM admin WHERE id = 1").fetchone()
            return {
                **base,
                "authenticated": True,
                "kind": "admin",
                "username": admin["username"] if admin else "admin",
                "is_admin": True,
                "can_edit": True,
                "can_upload": True,
                "can_settings": True,
                "can_trash": True,
                "can_purge": True,
                "album_scopes": [],
                "media_paths": [],
                "needs_setup": False,
                "open_mode": False,
            }

        share = con.execute(
            "SELECT * FROM shares WHERE id = ?", (row["share_id"],)
        ).fetchone()
        if not share or not share["enabled"]:
            con.execute("DELETE FROM sessions WHERE token = ?", (session_token,))
            return base
        if share["expires_at"]:
            try:
                sexp = datetime.fromisoformat(share["expires_at"])
                if sexp.tzinfo is None:
                    sexp = sexp.replace(tzinfo=timezone.utc)
                if sexp < _now():
                    con.execute("DELETE FROM sessions WHERE token = ?", (session_token,))
                    return base
            except ValueError:
                pass
        can_edit = bool(share["can_edit"])
        can_upload = bool(share["can_upload"])
        media_paths = _parse_scopes(
            share["media_paths"] if "media_paths" in share.keys() else "[]"
        )
        return {
            **base,
            "authenticated": True,
            "kind": "share",
            "username": None,
            "is_admin": False,
            "can_edit": can_edit,
            "can_upload": can_upload,
            "can_settings": False,
            "can_trash": can_edit,
            "can_purge": False,
            "album_scopes": _parse_scopes(share["album_scopes"]),
            "media_paths": media_paths,
            "needs_setup": False,
            "open_mode": False,
            "share_label": share["label"] or "访客",
            "share_id": share["id"],
        }


def path_allowed(
    rel: str,
    scopes: list[str],
    media_paths: list[str] | None = None,
) -> bool:
    """media_paths 非空时仅允许这些文件；否则用 scopes 年/月前缀；都空=全部。"""
    rel = (rel or "").replace("\\", "/").lstrip("/")
    if not rel:
        return False
    if rel.startswith(".trash/") or rel == ".trash":
        return False
    paths = [p.replace("\\", "/").lstrip("/") for p in (media_paths or []) if p]
    if paths:
        return rel in set(paths)
    if not scopes:
        return True
    for scope in scopes:
        s = scope.strip().replace("\\", "/").strip("/")
        if not s:
            continue
        if rel == s or rel.startswith(s + "/"):
            return True
    return False


def create_share(
    *,
    label: str = "",
    can_edit: bool = False,
    can_upload: bool = False,
    album_scopes: list[str] | None = None,
    media_paths: list[str] | None = None,
    expires_days: int | None = None,
) -> dict:
    token = secrets.token_urlsafe(18)
    now = _now()
    expires_at = None
    if expires_days and expires_days > 0:
        expires_at = _iso(now + timedelta(days=int(expires_days)))
    scopes = [
        str(x).strip().replace("\\", "/").strip("/")
        for x in (album_scopes or [])
        if str(x).strip()
    ]
    paths = [
        str(x).strip().replace("\\", "/").lstrip("/")
        for x in (media_paths or [])
        if str(x).strip()
    ]
    with connect() as con:
        cur = con.execute(
            """INSERT INTO shares
               (token, label, can_edit, can_upload, album_scopes, media_paths, enabled, expires_at, created_at, updated_at)
               VALUES (?,?,?,?,?,?,1,?,?,?)""",
            (
                token,
                (label or "").strip() or "访客分享",
                1 if can_edit else 0,
                1 if can_upload else 0,
                json.dumps(scopes, ensure_ascii=False),
                json.dumps(paths, ensure_ascii=False),
                expires_at,
                _iso(now),
                _iso(now),
            ),
        )
        sid = cur.lastrowid
    return get_share(sid)


def list_shares() -> list[dict]:
    with connect() as con:
        rows = con.execute(
            "SELECT * FROM shares ORDER BY id DESC"
        ).fetchall()
    return [_share_dict(r) for r in rows]


def get_share(share_id: int) -> dict:
    with connect() as con:
        row = con.execute("SELECT * FROM shares WHERE id = ?", (share_id,)).fetchone()
    if not row:
        raise FileNotFoundError("分享不存在")
    return _share_dict(row)


def get_share_by_token(token: str) -> dict | None:
    with connect() as con:
        row = con.execute(
            "SELECT * FROM shares WHERE token = ?", (token.strip(),)
        ).fetchone()
    return _share_dict(row) if row else None


def update_share(share_id: int, **fields: Any) -> dict:
    allowed = {
        "label",
        "can_edit",
        "can_upload",
        "album_scopes",
        "media_paths",
        "enabled",
        "expires_at",
    }
    sets = []
    vals: list[Any] = []
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k in ("album_scopes", "media_paths"):
            items = [
                str(x).strip().replace("\\", "/").strip("/")
                for x in (v or [])
                if str(x).strip()
            ]
            if k == "media_paths":
                items = [x.lstrip("/") for x in items]
            v = json.dumps(items, ensure_ascii=False)
        elif k in ("can_edit", "can_upload", "enabled"):
            v = 1 if v else 0
        sets.append(f"{k} = ?")
        vals.append(v)
    if not sets:
        return get_share(share_id)
    sets.append("updated_at = ?")
    vals.append(_iso())
    vals.append(share_id)
    with connect() as con:
        con.execute(f"UPDATE shares SET {', '.join(sets)} WHERE id = ?", vals)
    return get_share(share_id)


def delete_share(share_id: int) -> None:
    with connect() as con:
        con.execute("DELETE FROM shares WHERE id = ?", (share_id,))


def _share_dict(row: sqlite3.Row) -> dict:
    keys = set(row.keys())
    return {
        "id": row["id"],
        "token": row["token"],
        "label": row["label"],
        "can_edit": bool(row["can_edit"]),
        "can_upload": bool(row["can_upload"]),
        "album_scopes": _parse_scopes(row["album_scopes"]),
        "media_paths": _parse_scopes(row["media_paths"] if "media_paths" in keys else "[]"),
        "enabled": bool(row["enabled"]),
        "expires_at": row["expires_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def qr_png_bytes(text: str, box_size: int = 6) -> bytes:
    import io

    import qrcode

    qr = qrcode.QRCode(version=None, box_size=box_size, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
