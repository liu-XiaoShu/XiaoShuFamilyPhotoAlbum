from __future__ import annotations

import json
from pathlib import Path
from threading import Lock

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"

_DEFAULT = {
    # 媒资与代码分离：默认归档到项目下 album/
    "album_root": str(ROOT / "album"),
    "import_root": str(ROOT / "inbox"),
    # 缩略图缓存（会随相册增大，可迁到外接盘）
    "thumb_root": str(ROOT / "data" / "thumbs"),
    "host": "0.0.0.0",
    "port": 8765,
    "title_max_len": 30,
    "album_title": "小树时光相册",
    "album_icon": "",  # 空则用内置默认图标；否则为相对项目根的路径
    # 地图：auto/amap=高德在线；offline=本地离线包
    "map_provider": "auto",
}


class AppConfig:
    def __init__(self) -> None:
        self._lock = Lock()
        self.data = dict(_DEFAULT)
        self.load()

    def load(self) -> None:
        if CONFIG_PATH.is_dir():
            # Docker 若在宿主机缺文件时可能挂成空目录，导致无法读写配置
            try:
                CONFIG_PATH.rmdir()
            except OSError:
                # 非空目录：挪走再重建文件
                bak = CONFIG_PATH.with_name("config.json.bad_dir")
                try:
                    if bak.exists():
                        import shutil

                        shutil.rmtree(bak, ignore_errors=True)
                    CONFIG_PATH.rename(bak)
                except OSError:
                    pass
        if CONFIG_PATH.is_file():
            try:
                loaded = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                self.data.update({k: v for k, v in loaded.items() if k in _DEFAULT})
            except (json.JSONDecodeError, OSError):
                pass
        else:
            try:
                self.save()
            except OSError:
                pass
        Path(self.data["import_root"]).mkdir(parents=True, exist_ok=True)
        Path(self.data["album_root"]).mkdir(parents=True, exist_ok=True)
        self.thumb_root.mkdir(parents=True, exist_ok=True)

    def save(self) -> None:
        with self._lock:
            if CONFIG_PATH.is_dir():
                raise OSError(f"配置路径是目录而非文件：{CONFIG_PATH}")
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            CONFIG_PATH.write_text(
                json.dumps(self.data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    def update(self, **kwargs: str | int) -> dict:
        with self._lock:
            for k, v in kwargs.items():
                if k in self.data and v is not None:
                    self.data[k] = v
            if CONFIG_PATH.is_dir():
                raise OSError(f"配置路径是目录而非文件：{CONFIG_PATH}")
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            CONFIG_PATH.write_text(
                json.dumps(self.data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return dict(self.data)

    @property
    def album_root(self) -> Path:
        return self._resolve_data_path(self.data["album_root"])

    @property
    def import_root(self) -> Path:
        return self._resolve_data_path(self.data["import_root"])

    @property
    def thumb_root(self) -> Path:
        return self._resolve_data_path(self.data["thumb_root"])

    @staticmethod
    def _resolve_data_path(value: str) -> Path:
        p = Path(str(value)).expanduser()
        if not p.is_absolute():
            p = ROOT / p
        return p.resolve()

    @property
    def title_max_len(self) -> int:
        return int(self.data["title_max_len"])

    @property
    def album_title(self) -> str:
        t = str(self.data.get("album_title") or "").strip()
        return t or "小树时光相册"

    @property
    def album_icon(self) -> str:
        return str(self.data.get("album_icon") or "").strip()

    @property
    def map_provider(self) -> str:
        v = str(self.data.get("map_provider") or "auto").strip().lower()
        return v if v in {"auto", "amap", "offline"} else "auto"


config = AppConfig()
