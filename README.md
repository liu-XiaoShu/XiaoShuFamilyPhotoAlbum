# 小树时光相册

<p align="center">
  <strong>局域网轻量家庭相册</strong><br/>
  文件系统即图库 · 元数据随图走 · 时光 / 经典 / 离线地图
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-v1.0-0e9fbf?style=flat-square" />
  <img alt="python" src="https://img.shields.io/badge/python-3.8%2B-blue?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-Private%2FTBD-lightgrey?style=flat-square" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-informational?style=flat-square" />
</p>

**作者：** xiaoshu  

把照片和视频按时间整理到本机目录，在浏览器里浏览、编辑，并通过二维码在局域网内安全分享。

---

## ✨ 特性

- **时光 / 经典 / 地图** 三种浏览方式（离线 OSM 瓦片）
- **入库整理**：拖放或扫描 `inbox/`，解析 EXIF，批量修正后归档
- **规范命名**：`年/月/YYYY-MM-DD-HHMMSS-简述-md5.ext`，批量入库不互相覆盖
- **元数据进文件**：时间、简述、描述、地点写进图片/侧车，换机不丢
- **单图编辑**：旋转裁剪、视频剪辑与封面、旁白录音
- **超级用户 + 分享二维码**：免登打开，但年份/单文件权限严格
- **回收站**软删除；**SQLite 媒资索引**加速时间线与地图
- **主题**：科技清新 / 科技赛博

---

## 🚀 快速开始

### 环境

- Python **3.8+**
- 可选：`ffmpeg`（视频封面/剪辑）、`openssl`（`--https` 自签证书）

### 安装与启动

```bash
git clone <你的仓库地址>.git
cd 小树时光相册

# 依赖装到项目内 .vendor（推荐，不污染系统环境）
python3 -m pip install --target .vendor -r requirements.txt

# 可选：复制示例配置（不复制也可用内置默认路径 album/、inbox/）
cp config.example.json config.json

python3 run.py
```

浏览器打开：

| 入口 | 地址 |
|------|------|
| 本机 | http://127.0.0.1:8765 |
| 局域网 | http://\<本机IP\>:8765 |
| 登录 | http://127.0.0.1:8765/login |

首次访问会进入登录页，创建超级用户后即可使用。

### 常用命令

```bash
python3 run.py                      # HTTP 启动（默认 8765）
python3 run.py --https              # HTTPS（自签证书）
python3 run.py --reset-admin-password   # 忘记超管密码时重置
```

---

## 📁 目录结构

```text
小树时光相册/
├── app/                 # FastAPI 后端 + 静态前端
├── album/               # 相册根（媒资，默认不入库 Git）
├── inbox/               # 待入库
├── data/
│   ├── geo/             # 地点 → GPS（places.sqlite）
│   ├── map_pack/        # 离线地图（*.mbtiles 不入库）
│   └── …                # 鉴权库、缩略图等运行时数据
├── scripts/             # 迁移 / 种子脚本
├── config.example.json  # 配置示例
├── requirements.txt
├── run.py               # 启动入口
└── 设计需求.md           # 产品与技术定稿说明
```

### 文件命名（v1.0）

```text
album/2026/2026-09/2026-09-21-162600-杭州游玩-ea0730b7.jpg
       └年┘ └─月──┘ └日期┘ └时分秒┘ └──简述──┘ └md5─┘
```

旁白、封面、实况、侧车 JSON 会随主文件一起改名。

旧库批量升级命名：

```bash
PYTHONPATH=".vendor:." python3 scripts/migrate_filenames_v1.py
```

---

## 📖 使用流程

1. 将照片/视频放入 `inbox/`（或在页面拖放）
2. **相册管理 → 入库**：解析 → 修正 → 入库选中项
3. **相册浏览**：时光 / 经典 / 地图
4. **设置**：品牌、主题、地图包、分享二维码
5. **关于**：版本与功能说明

更完整的设计说明见 [`设计需求.md`](./设计需求.md)。

---

## 🔒 隐私与安全

- 默认仅监听局域网；HTTP 在不可信网络可能被嗅探，可用 `--https`
- 未登录不能浏览相册；分享链接按范围授权，无法靠猜路径越权
- **请勿**把 `album/`、`inbox/`、`data/auth.sqlite`、个人图标提交到公开仓库  
  （已在 `.gitignore` 中忽略）

---

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python · FastAPI · uvicorn |
| 图像/视频 | Pillow · piexif · pillow-heif · ffmpeg |
| 前端 | 原生 HTML/CSS/JS · Leaflet |
| 数据 | 文件系统相册 + SQLite（鉴权 / 索引 / 地点） |

---

## 📄 许可证

作者 **xiaoshu** · 版本 **v1.0**  

（若对外开源，请在此补充 License 文件与声明。）

---

## 🙏 致谢

- [OpenStreetMap](https://www.openstreetmap.org/) 及贡献者（离线地图数据）
- [Leaflet](https://leafletjs.com/)
- Pillow / FastAPI / uvicorn 等开源社区
