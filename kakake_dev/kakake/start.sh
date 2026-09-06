#!/usr/bin/env bash
# 咔咔珂启动脚本 · 同一份脚本适用于 Linux / macOS / Termux（安卓手机）
#
# 用法: ./start.sh [force] [verbose] [nolock]
#   force   → 强制重建 Web UI（默认：无产物或 src/web 比 packages/web/dist 新时才建）
#   verbose → 保留安装/构建过程输出（默认安静，且构建完成后清屏再启动）
#   nolock  → Termux 专用：不申请 termux-wake-lock
#
# Termux 里若提示 "bad interpreter" 或 "no such file"，直接用: bash start.sh
set -euo pipefail
cd "$(dirname "$0")"

# ---------- 运行环境识别 ----------
detect_termux() {
  [ -n "${TERMUX_VERSION:-}" ] && return 0
  case "${PREFIX:-}" in
    *com.termux*) return 0 ;;
  esac
  [ -d /data/data/com.termux/files/usr ] && return 0
  return 1
}

IS_TERMUX=0
if detect_termux; then
  IS_TERMUX=1
fi

WANT_WAKE_LOCK=1
HELD_WAKE_LOCK=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    force) export KAKAKE_FORCE_WEB_BUILD=1 ;;
    verbose) export KAKAKE_VERBOSE_BOOT=1 ;;
    nolock) WANT_WAKE_LOCK=0 ;;
  esac
  shift
done

# ---------- Termux 前置准备 ----------
if [ "$IS_TERMUX" = "1" ]; then
  # 1) 项目不能放在共享存储：那里没有可执行位、不支持符号链接，npm 与前端构建必挂
  case "$PWD" in
    /sdcard/*|/storage/emulated/*|/storage/self/*|/mnt/media_rw/*)
      echo "[ERROR] 项目在安卓共享存储里: $PWD"
      echo "        共享存储不支持可执行位与符号链接，npm 安装和前端构建一定失败。"
      echo "        请搬到 Termux 家目录再启动："
      echo "          cp -r \"$PWD\" ~/kakake && cd ~/kakake && bash start.sh"
      exit 1
      ;;
  esac

  # 2) 安卓没有 /tmp；TMPDIR 缺失会让 npm 解包、esbuild 落盘报 ENOENT
  if [ -z "${TMPDIR:-}" ] || [ ! -d "${TMPDIR:-}" ]; then
    TMPDIR="${PREFIX:-/data/data/com.termux/files/usr}/tmp"
    mkdir -p "$TMPDIR"
    export TMPDIR
  fi
fi

# ---------- Node.js 检查 ----------
if ! command -v node >/dev/null 2>&1; then
  if [ "$IS_TERMUX" = "1" ]; then
    echo "[ERROR] 未找到 Node.js。Termux 里执行: pkg update && pkg install nodejs-lts"
  else
    echo "[ERROR] Node.js 20+ is required. Install from https://nodejs.org/"
  fi
  exit 1
fi

# ---------- Termux 息屏保活 ----------
# 安卓会在息屏后回收后台进程，wake lock 让 Termux 保持运行；脚本退出时自动释放。
release_wake_lock() {
  if [ "$HELD_WAKE_LOCK" = "1" ] && command -v termux-wake-unlock >/dev/null 2>&1; then
    termux-wake-unlock >/dev/null 2>&1 || true
  fi
}

if [ "$IS_TERMUX" = "1" ] && [ "$WANT_WAKE_LOCK" = "1" ] \
  && command -v termux-wake-lock >/dev/null 2>&1; then
  if termux-wake-lock >/dev/null 2>&1; then
    HELD_WAKE_LOCK=1
    trap release_wake_lock EXIT INT TERM
    echo "[INFO] 已申请 termux-wake-lock（息屏后继续运行），退出本脚本时自动释放"
  fi
fi

# 拿了 wake lock 就不能 exec：exec 会替换掉本进程，EXIT 陷阱不再执行、锁永远不释放
if [ "$HELD_WAKE_LOCK" = "1" ]; then
  set +e
  node scripts/bootstrap.mjs
  status=$?
  set -e
  exit "$status"
fi

exec node scripts/bootstrap.mjs