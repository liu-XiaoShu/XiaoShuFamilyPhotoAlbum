# 小树时光相册

<p align="center">
  <strong>局域网轻量家庭相册</strong><br/>
  文件系统即图库 · 元数据随图走 · 时光 / 经典 / 地图
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-v1.0-0e9fbf?style=flat-square" />
  <img alt="python" src="https://img.shields.io/badge/python-3.8%2B-blue?style=flat-square" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20Raspberry%20Pi-informational?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-personal%20use-lightgrey?style=flat-square" />
</p>

**作者：** xiaoshu · **版本：** v1.0（定稿）

把照片和视频按时间整理到本机目录，在浏览器里浏览、编辑，并通过二维码在局域网内分享给家人。适合树莓派 / NAS 一类常开小主机。

---

## 特性

- **时光 / 经典 / 地图** 三种浏览（登录默认进时光，减轻首屏负担）
- **入库整理**：拖放或选文件夹；可「移除选中 / 清空待入库」；解析 EXIF 后归档
- **规范命名**：`年/月/YYYY-MM-DD-HHMMSS-简述-md5.ext`
- **元数据进文件**：时间、简述、描述、地点写进图片/侧车
- **单图编辑**：旋转裁剪、视频剪辑与封面、旁白录音
- **超级用户 + 分享二维码**：按年份/文件范围授权；可开入库；访客可见「授权范围 ∪ 自己上传」
- **访问数据**：访客曲线、黑名单、**入库占比饼图与入库明细**（超管）
- **回收站**软删除；**SQLite 媒资索引** + 大纲缓存（目标十万级流畅浏览）
- **地图**：默认高德在线代理缓存；可切离线 OSM 包
- **主题**：科技清新 / 科技赛博
- **Docker 一键部署**（国内镜像源）+ 树莓派运维脚本

---

## 快速开始

### 环境

- Python **3.8+**（Docker 镜像为 3.11）
- 可选：`ffmpeg`（视频封面/剪辑）、`openssl`（自签 HTTPS）

### 本地运行

```bash
git clone <你的仓库地址>.git
cd 小树时光相册

python3 -m pip install --target .vendor -r requirements.txt
cp config.example.json config.json

python3 run.py          # 默认 HTTPS
python3 run.py --http   # 明文 HTTP（仅调试）
```

| 入口 | 地址 |
|------|------|
| 本机 | `https://127.0.0.1:8765`（自签证书需点继续） |
| 局域网 | `https://<本机IP>:8765` |
| 登录 | `/login` |

首次访问请**立刻创建超级用户**（未创建前为开放模式，同网段可读写，见 [安全说明](./doc/安全说明.md)）。

### Docker（树莓派 / 服务器）

见 **[部署使用说明](./doc/部署使用说明.md)**。一键脚本：

```bash
cp -n config.example.json config.json
mkdir -p album inbox data/thumbs data/brand data/map_pack data/geo

./scripts/pi/deploy.sh    # 构建并启动
./scripts/pi/start.sh     # 仅启动（已有镜像）
./scripts/pi/stop.sh      # 停止
./scripts/pi/restart.sh   # 重启
./scripts/pi/debug.sh     # 状态 / 日志 / 健康检查
```

等价：`sudo docker-compose up -d --build`

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [doc/使用说明.md](./doc/使用说明.md) | 日常：入库、浏览、分享、地图、访问数据 |
| [doc/部署使用说明.md](./doc/部署使用说明.md) | Docker、一键脚本、启停、重置密码、备份 |
| [doc/设计需求.md](./doc/设计需求.md) | 产品目标、架构、定稿决策 |
| [doc/安全说明.md](./doc/安全说明.md) | 权限模型、风险与加固 |

---

## 目录结构

```text
小树时光相册/
├── app/                 # FastAPI 后端 + 静态前端
├── doc/                 # 产品与运维文档
├── scripts/pi/          # 一键部署 / 启动 / 重启 / 调试
├── album/               # 相册根（Git 忽略媒资）
├── inbox/               # 待入库
├── data/
│   ├── geo/             # 地点库 places.sqlite（可提交）
│   ├── map_pack/        # 离线地图说明（瓦片不入库）
│   └── …                # auth / visitors / thumbs / brand（运行时，勿提交）
├── config.example.json
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── run.py
```

### 请勿提交（已在 `.gitignore`）

- `config.json`（本机路径 / 标题 / 地图偏好）
- `album/`、`inbox/` 媒资
- `data/auth.sqlite`、`data/visitors.sqlite`（账号、访客、入库记录）
- `data/brand/` 自定义图标、`data/certs/` 证书
- `data/thumbs/`、地图瓦片缓存 `data/map_pack/xyz*`、`*.mbtiles`

公开仓库请用干净克隆；**不要**把家庭照片、访客 IP、超管库推上 GitHub。

---

## 使用流程（简）

1. 创建超级用户并登录（默认进入**时光**浏览）  
2. **管理 → 入库**：拖入 → 解析 → 勾选入库；不要的点「移除选中」  
3. **浏览**：时光 / 经典 / 地图  
4. **设置**：品牌、主题、地图模式、分享二维码  
5. **访问数据**：访客与入库占比（超管）  

细节见 [使用说明](./doc/使用说明.md)。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python · FastAPI · uvicorn |
| 图像/视频 | Pillow · piexif · pillow-heif · ffmpeg |
| 前端 | 原生 HTML/CSS/JS · Leaflet |
| 数据 | 文件系统相册 + SQLite |
| 地图 | 高德在线代理缓存 / 离线 OSM 包 |

---

## 许可证

作者 **xiaoshu** · 版本 **v1.0**  

默认按个人/家庭自用分发。若对外开源，请自行补充 `LICENSE` 文件。

---

## 致谢

- [Leaflet](https://leafletjs.com/)
- [OpenStreetMap](https://www.openstreetmap.org/) 贡献者（离线包数据源之一）
- Pillow / FastAPI / uvicorn 等开源社区
