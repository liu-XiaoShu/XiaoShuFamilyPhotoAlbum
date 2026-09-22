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
    "host": "0.0.0.0",
    "port": 8765,
    "title_max_len": 30,
    "album_title": "小树时光相册",
    "album_icon": "",  # 空则用内置默认图标；否则为相对项目根的路径
}


class AppConfig:
    def __init__(self) -> None:
        self._lock = Lock()
        self.data = dict(_DEFAULT)
        self.load()

    def load(self) -> None:
        if CONFIG_PATH.exists():
            try:
                loaded = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                self.data.update({k: v for k, v in loaded.items() if k in _DEFAULT})
            except (json.JSONDecodeError, OSError):
                pass
        Path(self.data["import_root"]).mkdir(parents=True, exist_ok=True)
        Path(self.data["album_root"]).mkdir(parents=True, exist_ok=True)

    def save(self) -> None:
        with self._lock:
            CONFIG_PATH.write_text(
                json.dumps(self.data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    def update(self, **kwargs: str | int) -> dict:
        with self._lock:
            for k, v in kwargs.items():
                if k in self.data and v is not None:
                    self.data[k] = v
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


config = AppConfig()
