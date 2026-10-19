#!/bin/bash
# ============================================
# WildAPI - 一键部署脚本 (Linux)
# 推荐入口: ./wildapi.sh → 菜单 [1] 一键部署 (无需直接运行本脚本)
# 直接运行: chmod +x deploy.sh && sudo ./deploy.sh
# ============================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[WildAPI]${NC} $1"; }
warn() { echo -e "${YELLOW}[警告]${NC} $1"; }
err()  { echo -e "${RED}[错误]${NC} $1"; }

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  WildAPI - AI API 中转站 一键部署${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# ---- 检查 Docker ----
if ! command -v docker &> /dev/null; then
    err "未检测到 Docker，请先安装 Docker"
    echo "  CentOS: yum install -y docker-ce"
    echo "  Ubuntu: apt install -y docker.io"
    exit 1
fi

# 选择 compose 命令
if docker compose version &> /dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose &> /dev/null; then
    COMPOSE="docker-compose"
else
    err "未检测到 docker-compose"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$(dirname "$PROJECT_DIR")/前端"

# ---- 检查目录位置 ----
if [[ "$SCRIPT_DIR" != *"/WildAPI/后端/docker" && "$SCRIPT_DIR" != *"/后端/docker" ]]; then
    warn "项目不在 /opt/WildAPI 下 (当前: $SCRIPT_DIR)"
    warn "推荐: 将项目解压到 /opt/WildAPI 后再运行"
    read -p "是否继续在当前位置部署? (y/n): " cont
    if [ "$cont" != "y" ] && [ "$cont" != "Y" ]; then exit 0; fi
fi

# 确认前端目录存在
if [ ! -d "$FRONTEND_DIR" ]; then
    err "未找到前端目录: $FRONTEND_DIR"
    err "请确认 后端/ 和 前端/ 目录位于同一父目录下"
    exit 1
fi

# ---- 检查 .env (需先于目录创建，用于读取 PREFIX/DATA_DIR) ----
if [ ! -f .env ]; then
    warn "未找到 .env，从 .env.example 复制模板..."
    cp .env.example .env
    echo ""
    echo -e "${RED}========================================${NC}"
    echo -e "${RED}  请先编辑 docker/.env 文件!${NC}"
    echo -e "${RED}  请检查 docker/.env 配置与服务器环境是否一致${NC}"
    echo -e "${RED}========================================${NC}"
    echo ""
    read -p "编辑完成后按回车继续部署..."
fi

# 从 .env 读取部署标识 (单实例标准: PREFIX=wildapi, DATA_DIR=/opt/WildAPI)
# tr 额外剥离 \r: 防止 Windows 编辑过的 CRLF .env 污染路径/容器名导致静默失败
PREFIX=$(grep -E '^PREFIX=' .env | cut -d= -f2 | tr -d '"\r' || true)
PREFIX=${PREFIX:-wildapi}
DATA_DIR=$(grep -E '^DATA_DIR=' .env | cut -d= -f2 | tr -d '"\r' || true)
DATA_DIR=${DATA_DIR:-/opt/WildAPI}
log "部署标识: PREFIX=$PREFIX, DATA_DIR=$DATA_DIR"

# ---- 创建宿主机目录结构 ----
log "创建数据目录 $DATA_DIR ..."
sudo mkdir -p "$DATA_DIR"/{mysql,redis,backups,logs}
# MySQL/Redis 官方镜像容器内用户 uid=999
sudo chown -R 999:999 "$DATA_DIR/mysql" "$DATA_DIR/redis" 2>/dev/null || true
# 后端容器用户 wildapi uid=1001
sudo chown -R 1001:1001 "$DATA_DIR/backups" "$DATA_DIR/logs" 2>/dev/null || true
sudo chmod -R 755 "$DATA_DIR/backups" "$DATA_DIR/logs"

# 迁移脚本由 compose 直接挂载仓库内的 后端/migrations (见 docker-compose.yml)，
# 不再往 $DATA_DIR/migrations 复制一份副本: 两份副本会各自漂移，且 cp 失败会被静默吞掉

# 同步 nginx.conf 到前端构建上下文
cp nginx.conf ../../前端/nginx.conf 2>/dev/null || true

# ---- 停止旧容器 ----
log "停止旧容器..."
$COMPOSE down --remove-orphans 2>/dev/null || true

# ---- 构建镜像 ----
log "构建镜像 (约 3-5 分钟)..."

BUILD_OK=false
BUILD_LOG=/tmp/wildapi_build.log

# 尝试 1: compose 构建 (BuildKit)
# 构建输出重定向到日志文件而不是丢弃: 失败时只剩"请检查 Docker 环境"，
# Dockerfile/依赖错误与 daemon 故障根本分不开
if $COMPOSE build --no-cache > "$BUILD_LOG" 2>&1; then
    BUILD_OK=true
else
    warn "compose 构建失败，切换到传统 docker build 模式... (日志: $BUILD_LOG)"
fi

# 尝试 2: 传统 docker build (兼容旧 daemon / 宝塔环境)
if [ "$BUILD_OK" = "false" ]; then
    if DOCKER_BUILDKIT=0 docker build -t "$PREFIX-backend:latest" \
        -f "$SCRIPT_DIR/Dockerfile.backend" "$PROJECT_DIR" >> "$BUILD_LOG" 2>&1; then
        if DOCKER_BUILDKIT=0 docker build -t "$PREFIX-frontend:latest" \
            -f "$SCRIPT_DIR/Dockerfile.frontend" "$FRONTEND_DIR" >> "$BUILD_LOG" 2>&1; then
            BUILD_OK=true
        fi
    fi
fi

if [ "$BUILD_OK" = "false" ]; then
    err "镜像构建失败，最后 30 行构建日志:"
    tail -30 "$BUILD_LOG" >&2 || true
    err "  - docker version"
    err "  - docker info (是否已启动)"
    exit 1
fi

# ---- 启动服务 ----
log "启动服务..."
$COMPOSE up -d --no-build

# ---- 等待 MySQL 就绪 ----
# 固定 sleep 15 在首轮部署常不够 (初始化要建系统表)，届时迁移全部报错却仍打印"部署完成"
log "等待 MySQL 健康检查通过..."
MYSQL_READY=false
for i in $(seq 1 60); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "$PREFIX-mysql" 2>/dev/null)" = "healthy" ]; then
    MYSQL_READY=true
    break
  fi
  sleep 2
done
if [ "$MYSQL_READY" != "true" ]; then
  err "MySQL 在 120 秒内未就绪，迁移中止"
  err "  docker logs $PREFIX-mysql"
  exit 1
fi
log "MySQL 已就绪"

# ---- 执行数据库迁移 (幂等，支持升级迁移) ----
# 用 stdin 从宿主机重定向文件: 不依赖容器内 init 目录复制时序，报错可见
log "执行数据库迁移..."
MIGRATE_FAILED=0
shopt -s nullglob
migration_files=("$PROJECT_DIR"/migrations/*.sql)
shopt -u nullglob
if [ ${#migration_files[@]} -eq 0 ]; then
  err "未找到迁移文件: $PROJECT_DIR/migrations/*.sql"
  exit 1
fi
for f in "${migration_files[@]}"; do
  name=$(basename "$f")
  if docker exec -i "$PREFIX-mysql" sh -c "mysql -uroot -p\$MYSQL_ROOT_PASSWORD" < "$f" 2>/tmp/wildapi_migrate_err.log; then
    log "  已应用: $name"
  else
    msg=$(grep -v 'Using a password' /tmp/wildapi_migrate_err.log | head -3)
    # 幂等重跑时报"已存在"类错误可忽略，其余必须让部署失败
    if echo "$msg" | grep -qiE "already exists|Duplicate (column|key entry)"; then
      warn "  已存在，跳过: $name"
    else
      err "  迁移失败: $name"
      err "  $msg"
      MIGRATE_FAILED=1
    fi
  fi
done
if [ "$MIGRATE_FAILED" != "0" ]; then
  err "数据库迁移未全部成功，服务不可用 (请修复后重跑部署)"
  exit 1
fi

# 检查状态
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  服务状态${NC}"
echo -e "${BLUE}========================================${NC}"
$COMPOSE ps

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署完成!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
FRONTEND_PORT=$(grep -E '^FRONTEND_PORT=' .env | cut -d= -f2 | tr -d '\r'); FRONTEND_PORT=${FRONTEND_PORT:-80}
BACKEND_PORT=$(grep -E '^BACKEND_PORT=' .env | cut -d= -f2 | tr -d '\r'); BACKEND_PORT=${BACKEND_PORT:-3000}
echo "  前端地址: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'YOUR_IP'):${FRONTEND_PORT}"
echo "  API 代理: http://localhost:${BACKEND_PORT}/v1/chat/completions"
echo ""
echo "  数据目录:"
echo "    MySQL:  $DATA_DIR/mysql"
echo "    Redis:  $DATA_DIR/redis"
echo "    备份:   $DATA_DIR/backups"
echo "    日志:   $DATA_DIR/logs"
echo ""
echo "  管理命令:"
echo "    查看日志:   cd $SCRIPT_DIR && $COMPOSE logs -f"
echo "    重启服务:   cd $SCRIPT_DIR && $COMPOSE restart"
echo "    停止服务:   cd $SCRIPT_DIR && $COMPOSE down"
echo "    完全卸载:   cd $SCRIPT_DIR && sudo ./uninstall.sh"
echo ""
