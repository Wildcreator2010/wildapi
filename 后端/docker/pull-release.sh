#!/bin/bash
# ============================================
# WildAPI - 服务器侧一键更新
# ============================================
# 由 GitHub Actions 的 deploy-server 工作流调用（它会先把本脚本 scp 上来再执行，
# 避免"服务器上还留着没有这个脚本的老版本"的鸡生蛋问题）。
# 也可以直接在服务器上手动跑：
#   REPO=Wildcreator2010/wildapi bash pull-release.sh [v1.0.1] [/opt/WildAPI]
#
# 流程: 下载 Release 部署包 → 校验 → 备份现有代码 → 解压替换 → 续用原 .env → 重新部署
# 下载与校验都排在"动现有文件"之前，中途失败不会留下半个部署。
# ============================================
set -eu

REPO="${REPO:-Wildcreator2010/wildapi}"
TAG="${1:-}"
ROOT_DIR="${2:-/opt/WildAPI}"
FILE="WildAPI.tar.gz"

if [ ! -d "$ROOT_DIR" ]; then
  echo "[错误] 项目根目录不存在: $ROOT_DIR"
  exit 1
fi

if [ -z "$TAG" ]; then
  echo "[WildAPI] 未指定版本，取最新 Release"
  TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4)
fi

if ! echo "$TAG" | grep -qE '^v[0-9A-Za-z._-]+$'; then
  echo "[错误] 非法标签: '$TAG'"
  exit 1
fi

URL="https://github.com/$REPO/releases/download/$TAG/$FILE"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "[WildAPI] 下载 $URL"
curl -fL --retry 3 -o "$TMP/$FILE" "$URL"

tar -tzf "$TMP/$FILE" >/dev/null || { echo "[错误] 部署包已损坏"; exit 1; }
if tar -tzf "$TMP/$FILE" | grep -qE '(^|/)\.env$'; then
  echo "[错误] 部署包里含 .env（凭据不随包扩散），拒绝部署"
  exit 1
fi
if ! tar -tzf "$TMP/$FILE" | grep -q '^后端/src/app\.js$'; then
  echo "[错误] 部署包结构不对：顶层应是 后端/ 与 前端/"
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
echo "[WildAPI] 部署 $TAG 到 $ROOT_DIR（现有代码备份后缀 .pre-$STAMP）"
[ -d "$ROOT_DIR/后端" ] && mv "$ROOT_DIR/后端" "$ROOT_DIR/后端.pre-$STAMP"
[ -d "$ROOT_DIR/前端" ] && mv "$ROOT_DIR/前端" "$ROOT_DIR/前端.pre-$STAMP"

tar -xzf "$TMP/$FILE" -C "$ROOT_DIR"

# 包里故意不含 .env：从备份里续用，保证数据库账号与 ENCRYPTION_KEY 不变
# （ENCRYPTION_KEY 一旦变化，库里已加密的上游密钥就再也解不开）
for rel in ".env" "docker/.env"; do
  OLD="$ROOT_DIR/后端.pre-$STAMP/$rel"
  if [ -f "$OLD" ]; then
    cp -p "$OLD" "$ROOT_DIR/后端/$rel"
    echo "  续用 后端/$rel"
  else
    echo "  [提示] 备份里没有 后端/$rel，需自行准备: cp .env.example .env 后填写"
  fi
done

chmod +x "$ROOT_DIR/后端/docker"/*.sh 2>/dev/null || true

echo "[WildAPI] 重新构建镜像并部署..."
cd "$ROOT_DIR/后端/docker"
./deploy.sh

echo ""
echo "[WildAPI] 完成。旧代码保留在："
echo "  $ROOT_DIR/后端.pre-$STAMP"
echo "  $ROOT_DIR/前端.pre-$STAMP"
echo "确认新版本没问题后可自行删除；要回滚就把这两个目录 mv 回来再跑一次 ./deploy.sh"
