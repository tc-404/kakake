#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js 20+ is required. Install from https://nodejs.org/"
  exit 1
fi

# ./start.sh force  → 强制重建 Web UI
# 默认：无产物，或 src/web 比 packages/web/dist 新时自动 build:web
if [[ "${1:-}" == "force" ]]; then
  export KAKAKE_FORCE_WEB_BUILD=1
  echo "[Kakake] force rebuild Web UI (KAKAKE_FORCE_WEB_BUILD=1)"
fi

echo "[Kakake] starting via scripts/bootstrap.mjs ..."
echo "[Kakake] Web build: auto if missing/outdated, or use: ./start.sh force"
echo

exec node scripts/bootstrap.mjs
