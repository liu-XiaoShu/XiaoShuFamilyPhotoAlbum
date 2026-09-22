"""访客统计与黑名单：记录访问、来源、IP；同网段尽量解析 MAC（ARP）。"""
from __future__ import annotations

import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional
from urllib.parse import parse_qs, urlparse

from ..config import ROOT

DB_PATH = ROOT / "data" / "visitors.sqlite"
_ACTIVE_WINDOW_SEC = 5 * 60
_SKIP_PREFIXES = (
    "/api/health",
    "/api/visitors",
    "/api/thumb",  # 缩略图请求极多，不计入访问以免拖慢树莓派
    "/favicon",
    "/styles.css",
    "/app.js",
    "/login.js",
    "/vendor/",
    "/api/brand/icon",
    "/api/map/",
    "/map-tiles/",
)
_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat(timespec="seconds")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH), timeout=30)
    con.row_factory = sqlite3.Row
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
            CREATE TABLE IF NOT EXISTS visits (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              ip TEXT NOT NULL,
              mac TEXT DEFAULT '',
              path TEXT NOT NULL,
              method TEXT DEFAULT 'GET',
              user_agent TEXT DEFAULT '',
              referer TEXT DEFAULT '',
              source TEXT DEFAULT 'direct',
              share_token TEXT DEFAULT '',
              media_path TEXT DEFAULT '',
              session_hint TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
            CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits(ip);
            CREATE INDEX IF NOT EXISTS idx_visits_media ON visits(media_path);
            CREATE TABLE IF NOT EXISTS blacklist (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL CHECK (kind IN ('ip', 'mac')),
              value TEXT NOT NULL,
              reason TEXT DEFAULT '',
              created_at TEXT NOT NULL,
              UNIQUE(kind, value)
            );
            CREATE INDEX IF NOT EXISTS idx_bl_value ON blacklist(kind, value);
            CREATE TABLE IF NOT EXISTS ingest_records (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              actor_kind TEXT NOT NULL,
              share_id INTEGER,
              actor_label TEXT NOT NULL,
              path TEXT NOT NULL,
              name TEXT NOT NULL,
              kind TEXT NOT NULL DEFAULT 'image',
              size INTEGER NOT NULL DEFAULT 0,
              title TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_ingest_ts ON ingest_records(ts);
            CREATE INDEX IF NOT EXISTS idx_ingest_share ON ingest_records(share_id);
            CREATE INDEX IF NOT EXISTS idx_ingest_actor ON ingest_records(actor_kind, actor_label);
            """
        )


def lookup_mac(ip: str) -> str:
    """从本机 ARP 表查局域网 MAC；跨网段或容器网桥上常为空。"""
    if not ip or ip.startswith("127.") or ip == "::1":
        return ""
    try:
        text = Path("/proc/net/arp").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 4 and parts[0] == ip:
            mac = parts[3].lower()
            if mac and mac != "00:00:00:00:00:00" and re.match(
                r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$", mac
            ):
                return mac
    return ""


def _client_ip(headers: dict, client_host: str | None) -> str:
    xff = (headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if xff:
        return xff
    real = (headers.get("x-real-ip") or "").strip()
    if real:
        return real
    return (client_host or "").strip() or "unknown"


def detect_source(path: str, query: str, referer: str, headers: dict) -> tuple[str, str]:
    """返回 (source, share_token)。"""
    qs = parse_qs(query or "")
    token = (qs.get("share") or qs.get("t") or [""])[0].strip()
    if token:
        return "share", token[:64]
    ref = referer or ""
    if "/login" in path:
        return "login", ""
    if "share=" in ref or "/s/" in ref:
        return "share_link", ""
    ua = (headers.get("user-agent") or "").lower()
    if "micromessenger" in ua:
        return "wechat", ""
    if "qr" in (qs.get("from") or [""])[0].lower():
        return "qr", ""
    if ref:
        try:
            host = urlparse(ref).netloc
            if host:
                return f"referer:{host[:80]}", ""
        except Exception:
            pass
    return "direct", ""


def extract_media_path(path: str, query: str) -> str:
    if path.startswith(("/api/thumb", "/api/media", "/api/file", "/api/preview", "/api/photo")):
        qs = parse_qs(query or "")
        p = (qs.get("path") or [""])[0].strip()
        return p[:500]
    return ""


def should_skip(path: str) -> bool:
    if not path:
        return True
    for p in _SKIP_PREFIXES:
        if path.startswith(p):
            return True
    if path.endswith((".css", ".js", ".map", ".ico", ".woff2", ".png", ".svg")):
        if path.startswith("/api/"):
            return False
        return True
    return False


def is_blacklisted(ip: str, mac: str = "") -> Optional[dict]:
    with connect() as con:
        row = con.execute(
            "SELECT id, kind, value, reason, created_at FROM blacklist WHERE kind='ip' AND value=?",
            (ip,),
        ).fetchone()
        if row:
            return dict(row)
        if mac:
            row = con.execute(
                "SELECT id, kind, value, reason, created_at FROM blacklist WHERE kind='mac' AND value=?",
                (mac.lower(),),
            ).fetchone()
            if row:
                return dict(row)
    return None


def record_visit(
    *,
    ip: str,
    path: str,
    method: str = "GET",
    user_agent: str = "",
    referer: str = "",
    query: str = "",
    headers: dict | None = None,
    session_hint: str = "",
) -> None:
    if should_skip(path):
        return
    headers = headers or {}
    mac = lookup_mac(ip)
    source, share_token = detect_source(path, query, referer, headers)
    media_path = extract_media_path(path, query)
    with _lock:
        with connect() as con:
            con.execute(
                """
                INSERT INTO visits
                  (ts, ip, mac, path, method, user_agent, referer, source, share_token, media_path, session_hint)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _iso(),
                    ip[:64],
                    mac[:32],
                    path[:500],
                    method[:16],
                    (user_agent or "")[:400],
                    (referer or "")[:400],
                    source[:80],
                    share_token,
                    media_path,
                    (session_hint or "")[:64],
                ),
            )


def list_history(limit: int = 200, offset: int = 0) -> list[dict]:
    with connect() as con:
        rows = con.execute(
            """
            SELECT id, ts, ip, mac, path, method, user_agent, referer, source, share_token, media_path
            FROM visits ORDER BY id DESC LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]


def list_current(window_sec: int = _ACTIVE_WINDOW_SEC) -> list[dict]:
    since = _iso(_now() - timedelta(seconds=window_sec))
    with connect() as con:
        rows = con.execute(
            """
            SELECT ip, mac, source,
                   MAX(ts) AS last_seen,
                   COUNT(*) AS hits,
                   MAX(path) AS last_path,
                   MAX(user_agent) AS user_agent
            FROM visits
            WHERE ts >= ?
            GROUP BY ip
            ORDER BY last_seen DESC
            """,
            (since,),
        ).fetchall()
        return [dict(r) for r in rows]


def visit_curve(days: int = 14) -> list[dict]:
    """近 N 天每日访问量；无数据的日期补 0，便于前端画满整段曲线。"""
    days = max(1, min(int(days), 90))
    today = _now().date()
    start = today - timedelta(days=days - 1)
    since = datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).isoformat(timespec="seconds")
    by_day: dict[str, dict] = {}
    with connect() as con:
        rows = con.execute(
            """
            SELECT substr(ts, 1, 10) AS day, COUNT(*) AS visits, COUNT(DISTINCT ip) AS visitors
            FROM visits
            WHERE ts >= ?
            GROUP BY substr(ts, 1, 10)
            ORDER BY day ASC
            """,
            (since,),
        ).fetchall()
        for r in rows:
            by_day[str(r["day"])] = {
                "day": str(r["day"]),
                "visits": int(r["visits"] or 0),
                "visitors": int(r["visitors"] or 0),
            }
    out: list[dict] = []
    cur = start
    while cur <= today:
        key = cur.isoformat()
        out.append(by_day.get(key, {"day": key, "visits": 0, "visitors": 0}))
        cur += timedelta(days=1)
    return out


def hot_media(limit: int = 30) -> list[dict]:
    with connect() as con:
        rows = con.execute(
            """
            SELECT media_path AS path, COUNT(*) AS hits, COUNT(DISTINCT ip) AS visitors,
                   MAX(ts) AS last_seen
            FROM visits
            WHERE media_path IS NOT NULL AND media_path != ''
            GROUP BY media_path
            ORDER BY hits DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def list_blacklist() -> list[dict]:
    with connect() as con:
        rows = con.execute(
            "SELECT id, kind, value, reason, created_at FROM blacklist ORDER BY id DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def add_blacklist(kind: str, value: str, reason: str = "") -> dict:
    kind = kind.strip().lower()
    value = value.strip().lower() if kind == "mac" else value.strip()
    if kind not in ("ip", "mac"):
        raise ValueError("kind 须为 ip 或 mac")
    if not value:
        raise ValueError("黑名单值不能为空")
    if kind == "ip" and not re.match(r"^[\d.:a-fA-F]+$", value):
        raise ValueError("IP 格式无效")
    if kind == "mac" and not re.match(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$", value):
        raise ValueError("MAC 格式无效，例 aa:bb:cc:dd:ee:ff")
    with connect() as con:
        con.execute(
            """
            INSERT INTO blacklist (kind, value, reason, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(kind, value) DO UPDATE SET reason=excluded.reason
            """,
            (kind, value, (reason or "")[:200], _iso()),
        )
        row = con.execute(
            "SELECT id, kind, value, reason, created_at FROM blacklist WHERE kind=? AND value=?",
            (kind, value),
        ).fetchone()
        return dict(row)


def remove_blacklist(item_id: int) -> bool:
    with connect() as con:
        cur = con.execute("DELETE FROM blacklist WHERE id=?", (int(item_id),))
        return cur.rowcount > 0


def summary() -> dict:
    with connect() as con:
        total = con.execute("SELECT COUNT(*) FROM visits").fetchone()[0]
        ips = con.execute("SELECT COUNT(DISTINCT ip) FROM visits").fetchone()[0]
        today = _iso(_now())[:10]
        today_n = con.execute(
            "SELECT COUNT(*) FROM visits WHERE substr(ts,1,10)=?", (today,)
        ).fetchone()[0]
        bl = con.execute("SELECT COUNT(*) FROM blacklist").fetchone()[0]
        ingest_n = 0
        try:
            ingest_n = con.execute("SELECT COUNT(*) FROM ingest_records").fetchone()[0]
        except sqlite3.Error:
            pass
    return {
        "total_visits": total,
        "unique_ips": ips,
        "today_visits": today_n,
        "blacklist_count": bl,
        "ingest_count": int(ingest_n or 0),
        "active_window_sec": _ACTIVE_WINDOW_SEC,
        "mac_note": "MAC 仅在同网段且本机 ARP 有记录时可得；Docker 桥接网络下常为空。",
    }


def record_ingest(
    *,
    principal: dict,
    path: str,
    name: str = "",
    kind: str = "image",
    size: int = 0,
    title: str = "",
) -> None:
    """入库成功后记一条，供访问数据页统计。"""
    path = (path or "").replace("\\", "/").lstrip("/")
    if not path:
        return
    kind_p = principal.get("kind") or ""
    if kind_p == "share":
        actor_kind = "share"
        share_id = principal.get("share_id")
        try:
            share_id = int(share_id) if share_id is not None else None
        except (TypeError, ValueError):
            share_id = None
        actor_label = (principal.get("share_label") or "访客").strip() or "访客"
    elif kind_p == "admin":
        actor_kind = "admin"
        share_id = None
        actor_label = "超级用户"
    else:
        actor_kind = "open"
        share_id = None
        actor_label = "开放模式"
    with connect() as con:
        con.execute(
            """
            INSERT INTO ingest_records(
              ts, actor_kind, share_id, actor_label, path, name, kind, size, title
            ) VALUES (?,?,?,?,?,?,?,?,?)
            """,
            (
                _iso(),
                actor_kind,
                share_id,
                actor_label[:80],
                path,
                (name or Path(path).name)[:200],
                "video" if kind == "video" else "image",
                max(0, int(size or 0)),
                (title or "")[:80],
            ),
        )


def ingest_share_stats() -> dict:
    """各用户入库数量与占比（读库聚合，适合树莓派）。"""
    with connect() as con:
        total = con.execute("SELECT COUNT(*) FROM ingest_records").fetchone()[0]
        rows = con.execute(
            """
            SELECT actor_kind, share_id, actor_label,
                   COUNT(*) AS count,
                   SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END) AS video_count,
                   SUM(size) AS bytes
            FROM ingest_records
            GROUP BY actor_kind, share_id, actor_label
            ORDER BY count DESC, actor_label ASC
            """
        ).fetchall()
    items = []
    for r in rows:
        n = int(r["count"] or 0)
        items.append(
            {
                "actor_kind": r["actor_kind"],
                "share_id": r["share_id"],
                "label": r["actor_label"] or "未知",
                "count": n,
                "video_count": int(r["video_count"] or 0),
                "bytes": int(r["bytes"] or 0),
                "share": round(100.0 * n / total, 1) if total else 0.0,
            }
        )
    return {"total": int(total or 0), "items": items}


def list_ingests(*, limit: int = 100, offset: int = 0, share_id: int | None = None) -> dict:
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    with connect() as con:
        if share_id is not None:
            total = con.execute(
                "SELECT COUNT(*) FROM ingest_records WHERE share_id=?",
                (int(share_id),),
            ).fetchone()[0]
            rows = con.execute(
                """
                SELECT id, ts, actor_kind, share_id, actor_label, path, name, kind, size, title
                FROM ingest_records
                WHERE share_id=?
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                (int(share_id), limit, offset),
            ).fetchall()
        else:
            total = con.execute("SELECT COUNT(*) FROM ingest_records").fetchone()[0]
            rows = con.execute(
                """
                SELECT id, ts, actor_kind, share_id, actor_label, path, name, kind, size, title
                FROM ingest_records
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
    return {
        "total": int(total or 0),
        "offset": offset,
        "limit": limit,
        "items": [dict(r) for r in rows],
    }
