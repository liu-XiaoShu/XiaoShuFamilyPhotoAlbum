#!/usr/bin/env python3
"""启动小树时光相册局域网服务。

默认 HTTP（局域网方便扫码）。若担心明文被窃听，可用：
  python run.py --https
会自动生成 data/certs/localhost.pem（自签），浏览器需信任一次。

忘记超级用户密码：
  python run.py --reset-admin-password
"""
from __future__ import annotations

import argparse
import getpass
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / ".vendor"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))

import uvicorn

from app.config import config

CERT_DIR = ROOT / "data" / "certs"
CERT_FILE = CERT_DIR / "localhost.pem"
KEY_FILE = CERT_DIR / "localhost-key.pem"


def _ensure_self_signed() -> tuple[Path, Path]:
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    if CERT_FILE.is_file() and KEY_FILE.is_file():
        return CERT_FILE, KEY_FILE
    try:
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                str(KEY_FILE),
                "-out",
                str(CERT_FILE),
                "-days",
                "825",
                "-nodes",
                "-subj",
                "/CN=xiaoshu-album",
                "-addext",
                "subjectAltName=DNS:localhost,IP:127.0.0.1",
            ],
            check=True,
            capture_output=True,
        )
        return CERT_FILE, KEY_FILE
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    try:
        from datetime import datetime, timedelta, timezone

        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name(
            [x509.NameAttribute(NameOID.COMMON_NAME, "xiaoshu-album")]
        )
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=825))
            .add_extension(
                x509.SubjectAlternativeName(
                    [
                        x509.DNSName("localhost"),
                        x509.IPAddress(__import__("ipaddress").IPv4Address("127.0.0.1")),
                    ]
                ),
                critical=False,
            )
            .sign(key, hashes.SHA256())
        )
        KEY_FILE.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            )
        )
        CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        return CERT_FILE, KEY_FILE
    except Exception as e:
        raise SystemExit(
            f"无法生成 HTTPS 证书：{e}\n请安装 openssl，或 pip install cryptography"
        ) from e


def _reset_admin_password(username: str | None) -> None:
    from app.services import auth

    auth.init_db()
    if not auth.has_admin():
        raise SystemExit("尚未创建超级用户。请先启动服务，打开 /login 完成初始化。")
    print("重置超级用户密码（无需旧密码）")
    if username:
        print(f"将用户名设为: {username}")
    else:
        cur = None
        try:
            with auth.connect() as con:
                row = con.execute("SELECT username FROM admin WHERE id = 1").fetchone()
                cur = row["username"] if row else None
        except Exception:
            pass
        if cur:
            print(f"当前用户名: {cur}（回车保持不变）")
        typed = input("新用户名（可选）: ").strip()
        username = typed or None
    while True:
        pw = getpass.getpass("新密码: ")
        pw2 = getpass.getpass("确认密码: ")
        if pw != pw2:
            print("两次输入不一致，请重试。")
            continue
        try:
            result = auth.reset_admin_password(pw, username=username)
            print(result.get("message") or "已重置")
            return
        except ValueError as e:
            print(f"无效：{e}")


def main() -> None:
    parser = argparse.ArgumentParser(description="小树时光相册")
    parser.add_argument(
        "--https",
        action="store_true",
        help="启用 HTTPS（自签证书，防局域网嗅探）",
    )
    parser.add_argument(
        "--reset-admin-password",
        action="store_true",
        help="交互式重置超级用户密码（忘记密码时使用）",
    )
    parser.add_argument(
        "--admin-user",
        default=None,
        help="与 --reset-admin-password 一起用，指定新用户名",
    )
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args()

    if args.reset_admin_password:
        _reset_admin_password(args.admin_user)
        return

    host = args.host or config.data.get("host", "0.0.0.0")
    port = int(args.port or config.data.get("port", 8765))
    scheme = "https" if args.https else "http"
    print(f"小树时光相册 → {scheme}://127.0.0.1:{port}")
    print(f"局域网访问 → {scheme}://<本机IP>:{port}")
    print(f"登录页 → {scheme}://127.0.0.1:{port}/login")
    print(f"相册根目录: {config.album_root}")
    print(f"导入目录:   {config.import_root}")
    if args.https:
        print("提示: 自签证书首次访问需在浏览器点「继续访问」；扫码设备同样需信任。")
        cert, key = _ensure_self_signed()
        uvicorn.run(
            "app.main:app",
            host=host,
            port=port,
            reload=False,
            ssl_certfile=str(cert),
            ssl_keyfile=str(key),
        )
    else:
        print("提示: HTTP 在不可信网络可能被同网段嗅探；家庭局域网通常可接受。需要加密请加 --https")
        print("忘记超管密码: python run.py --reset-admin-password")
        uvicorn.run("app.main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
