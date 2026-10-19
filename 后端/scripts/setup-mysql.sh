#!/bin/bash
# ============================================
# WildAPI - MySQL 自动安装配置 (Linux/macOS)
# ============================================

echo ""
echo "========================================"
echo "  WildAPI - MySQL 自动安装配置 (Linux)"
echo "========================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "[错误] 未检测到 Node.js，请先安装 Node.js"
    exit 1
fi

# 运行安装脚本
node scripts/setup-mysql.js "$@"
