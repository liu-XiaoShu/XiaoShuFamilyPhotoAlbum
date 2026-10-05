# 小树时光相册

<p align="center">
  <strong>局域网轻量家庭相册</strong><br/>
  文件系统即图库 · 元数据随图走 · 时光 / 经典 / 地图
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-v3.0.0-0e9fbf?style=flat-square" />
  <img alt="python" src="https://img.shields.io/badge/python-3.8%2B-blue?style=flat-square" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20Raspberry%20Pi-informational?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-personal%20use-lightgrey?style=flat-square" />
</p>

**作者：** xiaoshu · **版本：** v3.0.0（更新时间 2026-10-05）

把照片和视频按时间整理到本机目录，在浏览器里浏览、编辑、下载，并通过二维码在局域网内分享给家人。适合树莓派 / NAS 一类常开小主机。

版本对照见 [doc/版本说明.md](./doc/版本说明.md)。

---

## 特性（v3.0.0）

- **时光 / 经典 / 地图** 三种浏览；点「搜索」展开检索（标题 / 地点 / 描述 / 文件名）
- **入库**：拖放或多选；自动解析 EXIF；上传队列（暂停 / 继续 / 重试）；**内容去重**（忽略元数据，只认画面/视频载荷）
- 无拍摄时间时可从**文件名**回填日期；不要的文件可「移除选中 / 清空待入库」
- **苹果 HEIC / 实况**：原件入库；看图可「实况」预览伴生视频
- **规范命名**：`年/月/YYYY-MM-DD-HHMMSS-简述-md5.ext`
- **元数据进文件**：时间、简述、描述、地点写进图片/侧车
- **看图 / 编辑**：沉浸灯箱；旋转裁剪、视频剪辑封面；下载原文件；部分视频自动转可播格式
- **超级用户 + 分享二维码**：按年份/文件范围授权；可开入库
- **存储**（超管）：磁盘水位、相册/回收站/缩略图/地图包占用；重复项检查与处理
- **访问数据**（超管）：访客曲线、黑名单、入库占比
- **回收站**软删除（可恢复）；分享访客仅能操作自己可见范围
- **地图**：国内高德纠偏；港澳台与境外不二次偏移；地点库可增补世界城市
- **手机**：窄屏浏览布局；看图/列表降低预览负载
- **已知不足**：图片旁白未做好（录音与幻灯片出声不稳定），不作为本版可靠功能

---

## 快速开始

### 环境

- Python **3.8+**（Docker 镜像为 3.11）
- 可选：`ffmpeg`（视频封面/剪辑/可播转码）、`openssl`（自签 HTTPS）

### 本地运行

```bash
git clone <你的仓库地址>.git
cd xiaoshu-album

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
| 健康检查 | `GET /api/health` → `version` / `released_at` |

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

当前部署默认 **HTTPS**。compose 可配置 `HOST_UID` / `HOST_GID`，便于新写入文件归属宿主机用户。相册放到外接盘时，**待入库请与相册同盘**，避免入库时跨盘拷贝。

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [doc/版本说明.md](./doc/版本说明.md) | **v3.0.0 更新范围（含 v2.1.0 / v2.0.0 基线）** |
| [doc/使用说明.md](./doc/使用说明.md) | 日常：入库、浏览、搜索、下载、分享、存储与去重 |
| [doc/部署使用说明.md](./doc/部署使用说明.md) | Docker、一键脚本、启停、重置密码、备份 |
| [doc/设计需求.md](./doc/设计需求.md) | 产品目标、架构、版本决策 |
| [doc/安全说明.md](./doc/安全说明.md) | 权限模型、风险与加固 |

---

## 目录结构

```text
xiaoshu-album/
├── app/                 # FastAPI 后端 + 静态前端
├── doc/                 # 产品与运维文档
├── scripts/pi/          # 一键部署 / 启动 / 重启 / 调试
├── scripts/seed_places.py         # 国内地点库
├── scripts/seed_world_places.py   # 海外地点增补
├── album/               # 相册根（含隐藏目录 .trash 回收站）
├── inbox/               # 待入库
├── data/
│   ├── geo/             # 地点库 places.sqlite（运行时生成）
│   ├── map_pack/        # 离线地图说明（瓦片不入库）
│   └── …                # auth / visitors / thumbs / brand / certs（运行时）
├── config.example.json
├── Dockerfile
├── docker-compose.yml       # 当前仓库：树莓派 USB 盘示例
├── docker-compose.pi.yml    # 同上，便于对照
├── requirements.txt
└── run.py
```

### 请勿提交（已在 `.gitignore`）

- `config.json`、`album/`、`inbox/` 媒资
- `data/auth.sqlite`、`data/visitors.sqlite`、`data/geo/*.sqlite`
- `data/brand/`、`data/certs/`、`data/thumbs/`、地图瓦片缓存

公开仓库请用干净克隆；**不要**把家庭照片、访客 IP、超管库推上 Git。

---

## 使用流程（简）

1. 创建超级用户并登录（默认进入**时光**浏览）  
2. **管理 → 入库**：选择/拖入 → 自动解析 → 可编辑后「入库选中项」；不要的用「移除选中」  
3. **浏览**：时光 / 经典 / 地图；需要时点「搜索」；看图可「下载 / 实况 / 编辑」  
4. **管理 → 存储**（超管）：看磁盘占用；「检查重复项」并处理  
5. **设置**：品牌、主题、地图、分享二维码  
6. **访问数据**：访客与入库占比（超管）  

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

作者 **xiaoshu** · 版本 **v3.0.0** · 更新时间 **2026-10-05**  

默认按个人/家庭自用分发。若对外开源，请自行补充 `LICENSE` 文件。

---

## 致谢

- [Leaflet](https://leafletjs.com/)
- [OpenStreetMap](https://www.openstreetmap.org/) 贡献者（离线包数据源之一）
- Pillow / FastAPI / uvicorn 等开源社区
