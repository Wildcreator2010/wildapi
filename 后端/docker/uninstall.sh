#!/bin/bash
# ============================================
# WildAPI - 完全卸载脚本 (Linux)
# 使用: chmod +x uninstall.sh && sudo ./uninstall.sh
# ============================================

set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ---- 读取部署标识 (与 deploy.sh 同源，否则改过 PREFIX/DATA_DIR 的部署会"卸载完成"却什么都没删) ----
# tr 剥离 \r: 防止 Windows 编辑过的 CRLF .env 污染路径
PREFIX=wildapi
DATA_DIR=/opt/WildAPI
if [ -f .env ]; then
    PREFIX=$(grep -E '^PREFIX=' .env | cut -d= -f2 | tr -d '"\r' || true)
    DATA_DIR=$(grep -E '^DATA_DIR=' .env | cut -d= -f2 | tr -d '"\r' || true)
fi
PREFIX=${PREFIX:-wildapi}
DATA_DIR=${DATA_DIR:-/opt/WildAPI}

# rm -rf 前的路径自检: 必须是绝对路径且不是根/系统目录
if [ "${DATA_DIR:0:1}" != "/" ] || [ "${#DATA_DIR}" -lt 4 ] || [ "$DATA_DIR" = "/opt" ] || [ "$DATA_DIR" = "/" ]; then
    echo -e "${RED}[错误] DATA_DIR 看起来不安全，拒绝删除: '$DATA_DIR'${NC}"
    echo -e "${YELLOW}请检查 docker/.env 的 DATA_DIR 后重试${NC}"
    exit 1
fi

echo ""
echo -e "${RED}========================================${NC}"
echo -e "${RED}  WildAPI - 完全卸载${NC}"
echo -e "${RED}========================================${NC}"
echo ""
echo -e "${RED}此操作将删除:${NC}"
echo "  - 容器与镜像前缀: $PREFIX"
echo "  - MySQL 数据:    $DATA_DIR/mysql"
echo "  - Redis 数据:    $DATA_DIR/redis"
echo "  - 备份文件:      $DATA_DIR/backups"
echo "  - 日志文件:      $DATA_DIR/logs"
echo "  - Docker 网络:   ${PREFIX}-network"
echo ""

read -p "确认卸载? 输入 YES 继续: " confirm
if [ "$confirm" != "YES" ]; then
    echo -e "${YELLOW}卸载已取消${NC}"
    exit 0
fi

if docker compose version &> /dev/null 2>&1; then
    COMPOSE="docker compose"
else
    COMPOSE="docker-compose"
fi

echo ""
echo -e "${YELLOW}[1/6] 停止并删除容器...${NC}"
$COMPOSE down --remove-orphans --volumes 2>/dev/null || true

echo -e "${YELLOW}[2/6] 删除镜像...${NC}"
docker rmi "$PREFIX-backend:latest" 2>/dev/null || true
docker rmi "$PREFIX-frontend:latest" 2>/dev/null || true

echo -e "${YELLOW}[3/6] 删除网络...${NC}"
docker network rm "${PREFIX}-network" 2>/dev/null || true

echo -e "${YELLOW}[4/6] 删除宿主机数据...${NC}"
sudo rm -rf "$DATA_DIR/mysql" 2>/dev/null || true
sudo rm -rf "$DATA_DIR/redis" 2>/dev/null || true
sudo rm -rf "$DATA_DIR/backups" 2>/dev/null || true
sudo rm -rf "$DATA_DIR/logs" 2>/dev/null || true

echo -e "${YELLOW}[5/6] 清理项目文件...${NC}"
read -p "是否删除整个 $DATA_DIR 目录? (y/n): " delAll
if [ "$delAll" = "y" ] || [ "$delAll" = "Y" ]; then
    sudo rm -rf "$DATA_DIR"
    echo "  已删除 $DATA_DIR"
else
    echo "  保留 $DATA_DIR 项目文件，仅清理了数据目录"
fi

echo -e "${YELLOW}[6/6] 清理 Docker 缓存...${NC}"
docker builder prune -f 2>/dev/null || true

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  卸载完成${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
