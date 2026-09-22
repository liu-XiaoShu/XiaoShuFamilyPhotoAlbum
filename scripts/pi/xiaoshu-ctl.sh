#!/usr/bin/env bash
# 小树时光相册 · 树莓派 / Docker 一键运维
# 用法（在项目根目录，或任意目录指定 ROOT）：
#   ./scripts/pi/xiaoshu-ctl.sh deploy|start|stop|restart|status|logs|debug|rebuild
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

cmd="${1:-}"
case "$cmd" in
  deploy|rebuild)
    ensure_dirs
    echo "==> 构建并启动（$ROOT）"
    "${COMPOSE[@]}" up -d --build
    echo "==> 完成。登录：https://<本机IP>:8765/login"
    ;;
  start)
    ensure_dirs
    echo "==> 启动"
    "${COMPOSE[@]}" up -d
    ;;
  stop)
    echo "==> 停止"
    "${COMPOSE[@]}" stop
    ;;
  restart)
    echo "==> 重启"
    "${COMPOSE[@]}" restart
    ;;
  status)
    "${COMPOSE[@]}" ps
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
    curl -sk -o /dev/null -w "HTTPS /api/health → %{http_code} (%{time_total}s)\n" \
      "https://127.0.0.1:8765/api/health" || echo "健康检查失败（服务未起或证书问题）"
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

环境变量: XIAOSHU_ROOT=项目根目录（默认自动探测）

示例:
  cd ~/apps/xiaoshu-album
  ./scripts/pi/xiaoshu-ctl.sh deploy
  ./scripts/pi/xiaoshu-ctl.sh restart
  ./scripts/pi/xiaoshu-ctl.sh debug
EOF
    exit 1
    ;;
esac
