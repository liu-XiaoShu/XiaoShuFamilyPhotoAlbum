#!/usr/bin/env bash
# 小树时光相册 · 树莓派 / Docker 一键运维
# 用法（在项目根目录，或任意目录指定 ROOT）：
#   ./scripts/pi/xiaoshu-ctl.sh deploy|start|stop|restart|status|logs|debug|rebuild|uninstall
#   ./scripts/pi/xiaoshu-ctl.sh set-http | set-https
set -euo pipefail

ROOT="${XIAOSHU_ROOT:-}"
if [[ -z "${ROOT}" ]]; then
  ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
cd "$ROOT"

COMPOSE=(docker-compose)
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
fi
# 无权限时自动加 sudo
if ! docker info >/dev/null 2>&1; then
  COMPOSE=(sudo "${COMPOSE[@]}")
fi

PORTAL_TOOL_ID="album"
HUB_PORTAL="${HUB_PORTAL:-/home/xiaoshu/apps/xiaoshu-hub/data/portal.json}"

ensure_dirs() {
  mkdir -p album inbox data/thumbs data/brand data/map_pack data/geo data/certs
  if [[ ! -f config.json ]]; then
    if [[ -f config.example.json ]]; then
      cp config.example.json config.json
      echo "已从 config.example.json 创建 config.json"
    else
      echo "缺少 config.example.json，请先准备 config.json" >&2
      exit 1
    fi
  fi
  if [[ -d config.json ]]; then
    echo "错误：config.json 是目录（Docker 挂载常见事故）。请删掉该目录后重放配置文件。" >&2
    exit 1
  fi
}

current_scheme() {
  if grep -qE -- '--https' docker-compose.yml 2>/dev/null && ! grep -qE -- '--http"' docker-compose.yml 2>/dev/null; then
    # crude: look at command line
    if grep -qE 'run\.py", "--https"' docker-compose.yml 2>/dev/null || grep -qE "run.py\", \"--https\"" docker-compose.yml 2>/dev/null; then
      echo https
      return
    fi
  fi
  if grep -qE '--http' docker-compose.yml 2>/dev/null; then
    echo http
    return
  fi
  echo http
}

album_base_url() {
  local scheme ip
  scheme="$(current_scheme)"
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "${scheme}://${ip:-127.0.0.1}:8765"
}

update_portal_album_url() {
  local url="$1" f="$HUB_PORTAL"
  [[ -f "$f" ]] || return 0
  python3 - "$f" "$url" <<'PY' 2>/dev/null || true
import json, sys
path, url = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
for t in data.get("tools") or []:
    if t.get("id") == "album":
        t["url"] = url
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print("导航入口已更新:", url)
PY
}

set_scheme() {
  local scheme="$1"
  [[ "$scheme" == "http" || "$scheme" == "https" ]] || {
    echo "用法: $0 set-http | set-https" >&2
    exit 1
  }
  local flag="--${scheme}"
  if [[ ! -f docker-compose.yml ]]; then
    echo "缺少 docker-compose.yml" >&2
    exit 1
  fi
  # 写入 / 替换 command
  if grep -qE 'command:.*run\.py' docker-compose.yml; then
    sed -i -E "s|command: \[\"python\", \"run\.py\", \"--https?\"\]|command: [\"python\", \"run.py\", \"${flag}\"]|" docker-compose.yml
  else
    # 在 environment 前插入
    sed -i "/environment:/i\\    command: [\"python\", \"run.py\", \"${flag}\"]" docker-compose.yml
  fi
  echo "==> 已切换为 ${scheme^^}（docker-compose command → ${flag}）"
  if [[ "$scheme" == "https" ]]; then
    echo "    提示: 自签证书；手机需信任证书，并允许 Cookie"
  else
    echo "    提示: 家庭局域网 HTTP 更省事，手机开 Cookie 即可"
  fi
  ensure_dirs
  "${COMPOSE[@]}" up -d --force-recreate
  local url
  url="$(album_base_url)"
  update_portal_album_url "$url"
  echo "==> 访问: ${url}/login"
}

remove_portal_entry() {
  local id="$1" f="$HUB_PORTAL"
  [[ -n "$id" && -f "$f" ]] || return 0
  python3 - "$f" "$id" <<'PY' 2>/dev/null || true
import json, sys
path, tid = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
tools = data.get("tools") or []
new = [t for t in tools if t.get("id") != tid]
if len(new) == len(tools):
    sys.exit(0)
data["tools"] = new
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print("已从家庭导航移除入口:", tid)
PY
}

do_uninstall() {
  local PURGE=0 YES=0 a
  shift || true
  for a in "$@"; do
    case "$a" in --purge) PURGE=1 ;; --yes|-y) YES=1 ;; esac
  done
  echo "==> 卸载时光相册（$ROOT）"
  if [[ "$PURGE" -eq 1 ]]; then
    echo "    模式: --purge（容器 + 项目内 data/inbox + config；相册原图 album/ 默认也删）"
    echo "    警告: 会删除照片数据，请确认已备份"
  else
    echo "    模式: 仅删容器，保留 album/data/config"
  fi
  if [[ "$YES" -ne 1 ]]; then
    local msg="确认卸载相册容器？输入 yes 继续: "
    [[ "$PURGE" -eq 1 ]] && msg="确认彻底卸载相册（含照片）？输入 yes 继续: "
    read -r -p "$msg" ans
    [[ "$ans" == "yes" ]] || { echo "已取消"; exit 0; }
  fi
  "${COMPOSE[@]}" down --remove-orphans || true
  remove_portal_entry "$PORTAL_TOOL_ID"
  if [[ "$PURGE" -eq 1 ]]; then
    for d in data inbox album; do
      if [[ -e "$ROOT/$d" ]]; then
        echo "删除: $ROOT/$d"
        rm -rf "$ROOT/$d"
      fi
    done
    rm -f "$ROOT/config.json"
    echo "已清除相册数据与 config.json"
  fi
  echo "==> 卸载完成"
}

print_access() {
  local url
  url="$(album_base_url)"
  echo "==> 相册: ${url}"
  echo "    登录: ${url}/login"
  echo "    当前协议: $(current_scheme)（切换: ./scripts/pi/set-http.sh 或 set-https.sh）"
}

cmd="${1:-}"
case "$cmd" in
  deploy|rebuild)
    ensure_dirs
    echo "==> 构建并启动（$ROOT）"
    "${COMPOSE[@]}" up -d --build
    print_access
    ;;
  start)
    ensure_dirs
    echo "==> 启动"
    "${COMPOSE[@]}" up -d
    print_access
    ;;
  stop)
    echo "==> 停止"
    "${COMPOSE[@]}" stop
    ;;
  restart)
    echo "==> 重启"
    "${COMPOSE[@]}" restart
    print_access
    ;;
  status)
    "${COMPOSE[@]}" ps
    echo "协议: $(current_scheme)"
    echo "---"
    "${COMPOSE[@]}" top || true
    ;;
  logs)
    shift || true
    "${COMPOSE[@]}" logs --tail="${1:-100}" -f
    ;;
  debug)
    echo "==> 容器状态"
    "${COMPOSE[@]}" ps || true
    echo "==> 最近日志"
    "${COMPOSE[@]}" logs --tail=80 || true
    echo "==> 健康检查"
    local_scheme="$(current_scheme)"
    if [[ "$local_scheme" == "https" ]]; then
      curl -sk -o /dev/null -w "HTTPS /api/health → %{http_code} (%{time_total}s)\n" \
        "https://127.0.0.1:8765/api/health" || echo "健康检查失败"
    else
      curl -sS -o /dev/null -w "HTTP /api/health → %{http_code} (%{time_total}s)\n" \
        "http://127.0.0.1:8765/api/health" || echo "健康检查失败"
    fi
    echo "==> 磁盘 / 内存"
    df -h "$ROOT" 2>/dev/null || df -h /
    free -h 2>/dev/null || true
    echo "==> config.json 类型"
    if [[ -d config.json ]]; then
      echo "异常：config.json 是目录"
    elif [[ -f config.json ]]; then
      echo "正常：文件"
      grep -E 'album_title|map_provider|album_root' config.json || true
    else
      echo "缺失 config.json"
    fi
    ;;
  shell)
    "${COMPOSE[@]}" exec album bash || "${COMPOSE[@]}" exec album sh
    ;;
  set-http|http)
    set_scheme http
    ;;
  set-https|https)
    set_scheme https
    ;;
  uninstall)
    do_uninstall "$@"
    ;;
  *)
    cat <<EOF
小树时光相册 · 运维脚本

用法: $0 <命令>

  deploy / rebuild  一键构建并启动（代码变更后用）
  start             一键启动（已有镜像）
  stop              停止
  restart           一键重启
  status            查看状态
  logs [N]          跟随日志（默认最近 100 行）
  debug             一键调试：状态 + 日志 + 健康检查 + 资源
  shell             进入容器 shell
  set-http          切换为 HTTP 并重建容器（家庭局域网推荐）
  set-https         切换为 HTTPS 并重建容器（自签证书）
  uninstall [--purge] [--yes]
                    干净卸载；--purge 会删除照片请谨慎

示例:
  cd ~/apps/xiaoshu-album
  ./scripts/pi/deploy.sh
  ./scripts/pi/set-http.sh
  ./scripts/pi/set-https.sh
EOF
    exit 1
    ;;
esac
