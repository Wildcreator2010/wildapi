#!/bin/bash
# ============================================
# WildAPI - Docker 管理面板 (菜单式操作)
# 使用: chmod +x wildapi.sh && ./wildapi.sh
# 适用: 宝塔面板服务器 / 任意 Linux 服务器
# ============================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# ---- 读取配置 (tr 剥离 \r: 防止 Windows 编辑过的 CRLF .env 污染变量) ----
if [ -f .env ]; then
    PREFIX=$(grep -E '^PREFIX=' .env | cut -d= -f2 | tr -d '"\r' || true)
    DATA_DIR=$(grep -E '^DATA_DIR=' .env | cut -d= -f2 | tr -d '"\r' || true)
    BACKEND_PORT=$(grep -E '^BACKEND_PORT=' .env | cut -d= -f2 | tr -d '\r' || true)
    FRONTEND_PORT=$(grep -E '^FRONTEND_PORT=' .env | cut -d= -f2 | tr -d '\r' || true)
    MYSQL_DATABASE=$(grep -E '^MYSQL_DATABASE=' .env | cut -d= -f2 | tr -d '"\r' || true)
fi
PREFIX=${PREFIX:-wildapi}
DATA_DIR=${DATA_DIR:-/opt/WildAPI}
BACKEND_PORT=${BACKEND_PORT:-3000}
FRONTEND_PORT=${FRONTEND_PORT:-80}
MYSQL_DATABASE=${MYSQL_DATABASE:-wildapi}

# ---- 选择 compose 命令 ----
if docker compose version &> /dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose &> /dev/null; then
    COMPOSE="docker-compose"
else
    COMPOSE=""
fi

check_docker() {
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}[错误] 未检测到 Docker${NC}"
        echo "  宝塔面板: 软件商店 → 搜索 Docker → 安装"
        echo "  命令行:  CentOS: yum install -y docker-ce | Ubuntu: apt install -y docker.io"
        return 1
    fi
    if [ -z "$COMPOSE" ]; then
        echo -e "${RED}[错误] 未检测到 Docker Compose${NC}"
        echo "  宝塔面板: Docker 管理器插件会自动安装 compose"
        return 1
    fi
    if ! docker info &> /dev/null; then
        echo -e "${RED}[错误] Docker 服务未启动${NC}"
        echo "  宝塔面板: Docker 管理器 → 启动服务"
        echo "  命令行:  systemctl start docker"
        return 1
    fi
    return 0
}

pause() {
    echo ""
    read -p "按回车键返回菜单..." _
}

# ============ 功能函数 ============

do_deploy() {
    echo -e "${CYAN}>>> 开始部署 (首次约 3-5 分钟)...${NC}"
    if [ -x ./deploy.sh ]; then
        ./deploy.sh
    else
        bash deploy.sh
    fi
}

do_status() {
    if ! check_docker; then return; fi
    echo -e "${CYAN}>>> 服务状态${NC}"
    $COMPOSE ps
    echo ""
    echo -e "${CYAN}>>> 访问地址${NC}"
    IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    IP=${IP:-YOUR_IP}
    echo "  前端面板:  http://$IP:$FRONTEND_PORT"
    echo "  API 代理:  http://$IP:$BACKEND_PORT/v1/chat/completions"
    echo "  健康检查:  http://$IP:$BACKEND_PORT/api/health"
    echo ""
    echo -e "${CYAN}>>> 数据目录: $DATA_DIR${NC}"
    du -sh "$DATA_DIR"/mysql "$DATA_DIR"/redis "$DATA_DIR"/backups "$DATA_DIR"/logs 2>/dev/null || echo "  (数据目录尚未创建)"
}

do_start() {
    if ! check_docker; then return; fi
    echo -e "${CYAN}>>> 启动服务...${NC}"
    $COMPOSE up -d
    echo -e "${GREEN}启动指令已发出，等待服务就绪...${NC}"
    sleep 5
    $COMPOSE ps
}

do_stop() {
    if ! check_docker; then return; fi
    echo -e "${YELLOW}>>> 停止服务 (数据保留在 $DATA_DIR)...${NC}"
    $COMPOSE stop
    echo -e "${GREEN}已停止${NC}"
}

do_restart() {
    if ! check_docker; then return; fi
    echo -e "${CYAN}>>> 重启服务...${NC}"
    $COMPOSE restart
    sleep 5
    $COMPOSE ps
}

do_logs() {
    if ! check_docker; then return; fi
    echo ""
    echo "  查看哪个服务的日志? (Ctrl+C 退出日志)"
    echo "    1) 全部服务"
    echo "    2) 后端 (API)"
    echo "    3) 前端 (Nginx)"
    echo "    4) MySQL"
    echo "    5) Redis"
    read -p "  请选择 [1-5]: " svc
    case "$svc" in
        2) $COMPOSE logs -f --tail 100 backend ;;
        3) $COMPOSE logs -f --tail 100 frontend ;;
        4) $COMPOSE logs -f --tail 100 mysql ;;
        5) $COMPOSE logs -f --tail 100 redis ;;
        *) $COMPOSE logs -f --tail 100 ;;
    esac
}

do_backup() {
    if ! check_docker; then return; fi
    if ! docker ps --format '{{.Names}}' | grep -q "^$PREFIX-mysql$"; then
        echo -e "${RED}[错误] MySQL 容器未运行，无法备份${NC}"
        return
    fi
    sudo mkdir -p "$DATA_DIR/backups" 2>/dev/null || mkdir -p "$DATA_DIR/backups"
    FILE="$DATA_DIR/backups/$PREFIX-$(date +%Y%m%d-%H%M%S).sql"
    echo -e "${CYAN}>>> 正在导出数据库 $MYSQL_DATABASE 到 $FILE ...${NC}"
    # 库名取自 .env (旧实现硬编码 wildapi: 改过 MYSQL_DATABASE 时备份的是不存在的库，
    # 空文件还被 rm -f 删掉，等于无声失败)
    if ! [[ "$MYSQL_DATABASE" =~ ^[A-Za-z0-9_]+$ ]]; then
        echo -e "${RED}[错误] MYSQL_DATABASE 含非法字符，无法备份${NC}"
        return
    fi
    docker exec "$PREFIX-mysql" sh -c \
        "mysqldump -uroot -p\"\$MYSQL_ROOT_PASSWORD\" --single-transaction --routines $MYSQL_DATABASE" > "$FILE"
    if [ -s "$FILE" ]; then
        chmod 600 "$FILE"
        echo -e "${GREEN}备份成功: $FILE ($(du -h "$FILE" | cut -f1))${NC}"
    else
        rm -f "$FILE"
        echo -e "${RED}备份失败，请查看 MySQL 日志 (菜单 6)${NC}"
    fi
}

do_uninstall() {
    echo -e "${RED}此操作将停止并删除所有 WildAPI 容器${NC}"
    echo -e "${YELLOW}数据目录 $DATA_DIR 默认保留，卸载脚本会询问是否删除${NC}"
    if [ -x ./uninstall.sh ]; then
        ./uninstall.sh
    else
        bash uninstall.sh
    fi
}

# ============ 主菜单 ============

while true; do
    clear
    echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║      WildAPI - Docker 管理面板           ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${GREEN}1)${NC} 一键部署 / 更新      ${YELLOW}(构建镜像并启动全部服务)${NC}"
    echo -e "  ${GREEN}2)${NC} 查看服务状态        ${YELLOW}(容器状态 + 访问地址)${NC}"
    echo -e "  ${GREEN}3)${NC} 启动服务"
    echo -e "  ${GREEN}4)${NC} 停止服务            ${YELLOW}(数据保留)${NC}"
    echo -e "  ${GREEN}5)${NC} 重启服务"
    echo -e "  ${GREEN}6)${NC} 查看实时日志"
    echo -e "  ${GREEN}7)${NC} 备份数据库          ${YELLOW}(导出到 $DATA_DIR/backups)${NC}"
    echo -e "  ${GREEN}8)${NC} 完全卸载"
    echo ""
    echo -e "  ${RED}0)${NC} 退出"
    echo ""
    echo -e "  ${CYAN}数据目录: $DATA_DIR | 容器前缀: $PREFIX${NC}"
    echo -e "  ${CYAN}宝塔用户也可在 Docker 管理器中图形化管理 $PREFIX-* 容器${NC}"
    echo ""
    read -p "  请输入选项 [0-8]: " choice

    case "$choice" in
        1) do_deploy; pause ;;
        2) do_status; pause ;;
        3) do_start; pause ;;
        4) do_stop; pause ;;
        5) do_restart; pause ;;
        6) do_logs ;;
        7) do_backup; pause ;;
        8) do_uninstall; pause ;;
        0) echo -e "${GREEN}再见!${NC}"; exit 0 ;;
        *) echo -e "${RED}无效选项${NC}"; sleep 1 ;;
    esac
done
