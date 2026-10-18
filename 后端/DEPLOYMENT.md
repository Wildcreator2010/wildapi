# WildAPI - AI API 中转站 部署说明

## 本地开发

### 前提条件
- Node.js 20+
- MySQL 8.0+ (或运行 `npm run setup-mysql` 自动安装)
- Redis 7+ (可选，用于速率限制和并发控制)

### 1. 安装依赖

```bash
# 后端
cd 后端
npm install

# 前端
cd ../前端
npm install
```

### 2. 配置环境变量

```bash
cd 后端
cp .env.example .env
# 编辑 .env 文件，至少配置:
#   ENCRYPTION_KEY (64位十六进制)
#   JWT_SECRET
#   SSO_CLIENT_SECRET (从 WildAccount 获取)
```

### 3. 初始化数据库

```bash
# 方式 A: 自动安装 MySQL + 初始化
npm run setup-mysql

# 方式 B: 已安装 MySQL，仅执行迁移
npm run migrate
```

### 4. 启动开发服务

```bash
# 终端 1: 启动后端 (端口 3000)
cd 后端
npm run dev

# 终端 2: 启动前端 (端口 5173)
cd ../前端
npm run dev
```

访问 http://localhost:5173

---

## Docker 一键部署

```bash
cd 后端/docker

# Linux/macOS
chmod +x deploy.sh && ./deploy.sh

# Windows
deploy.bat
```

部署后访问: `http://localhost:${FRONTEND_PORT}` (docker/.env 默认 3002；后端 API 走 `${BACKEND_PORT}`，默认 3001)

### 管理命令

```bash
cd 后端/docker

docker compose logs -f    # 查看日志
docker compose down       # 停止服务
docker compose restart    # 重启服务
./uninstall.sh            # 完全卸载 (Linux)
uninstall.bat             # 完全卸载 (Windows)
```

---

## SSO 认证集成

1. 在 WildAccount 管理后台注册应用 (client_id: `wildapi`)
2. 设置回调地址前缀 (生产: `https://api.wildcreator.top/`)
3. 将生成的 `client_secret` 填入 `.env` 的 `SSO_CLIENT_SECRET`
4. 首次管理员用户需在数据库中将对应 `role` 设为 `superadmin`

### ⚠ WildAccount 安全风控规避要点 (重要)

WildAccount 认证中心部署了多层安全风控 (security.js)，服务端调用 `/api/token` 时**必须**遵守以下规则，否则会被封禁 IP：

| 规则 | 说明 |
|------|------|
| 携带 `Accept-Language` 头 | 行为分析器对无此头的请求计 1 个可疑特征 |
| 携带非空 `User-Agent` | UA 含 curl/wget/nmap 等工具名会**直接封禁 IP**；空 UA 也会记可疑日志 |
| 请求间隔 ≥ 200ms | 同 IP 连续请求间隔 <200ms 计 1 个可疑特征 |
| 突发 ≤ 20 次/秒 | 1 秒内超过 20 次请求计 1 个可疑特征 |
| 可疑特征 ≥ 3 个 | 判定为 BOT，**渐进式封禁 IP** (1分钟 → 2分钟 → …最长 7 天，内存存储，重启认证中心即清空) |
| `/api/token` 限流 | 每 IP 每 5 分钟 30 次，超出返回 429 |
| **禁止用 curl/wget 直接测试认证中心** | curl 的 UA 命中黑名单，一次就封 |

**部署拓扑：** 后端与认证中心同机时，`SSO_AUTH_URL` 配置为 `http://host.docker.internal:4000` **内网直连**（compose 已配 `extra_hosts: host-gateway`），绕过 CDN (Cloudflare) 的 Bot 拦截——CDN 会拦截一切非浏览器服务端请求。浏览器侧仍走 `https://login.wildcreator.top` 授权页。

**验证方式：** 只用浏览器走完整登录流程，不要用 curl 测试认证中心；后端返回 403 时等待 1-2 分钟再试，不要连续快速重试。

---

## 验证与测试

```bash
npm run test:relay   # 代理链路回归，mock 上游，不需要 MySQL/Redis
npm run test:e2e     # 未加确认变量时只打印用法并退出
```

真库校验会向当前配置的数据库写入并回删带 `E2E-` 前缀的临时数据，因此必须显式确认：

```bash
WILDAPI_E2E_CONFIRM=1 DB_HOST=127.0.0.1 DB_PORT=13306 DB_USER=wildapi DB_PASSWORD=... \
REDIS_HOST=127.0.0.1 REDIS_PORT=16379 REDIS_PASSWORD=... npm run test:e2e
```

它建临时服务商与密钥、起一个 mock 上游、跑真实 HTTP 调用，再回查 `request_logs`
与 `users.balance` 断言落库结果，结束自动清理。部署完成后的逐项验收清单见
`DOCKER_DEPLOYMENT_CHECK.md` 第十三节。

## API 接口

### 代理接口 (OpenAI 兼容)

```bash
# 源码直跑时端口取 .env 的 PORT (默认 3000)；Docker 部署取 docker/.env 的 BACKEND_PORT (默认 3001)
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <代理密钥 ak-...>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

### 管理接口 (需 admin JWT)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin/providers | 服务商列表 |
| POST | /api/admin/providers | 添加服务商 |
| GET | /api/admin/users | 用户列表 |
| POST | /api/admin/users/:id/recharge | 充值 |
| GET | /api/admin/logs | 请求日志 |
| GET | /api/admin/stats/overview | 总览统计 |
| GET/POST/DELETE | /api/admin/backup | 备份管理 |
| GET/PUT | /api/admin/settings | 系统设置 |

### 用户接口 (需 JWT)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/user/dashboard | 仪表盘 |
| GET/POST/DELETE | /api/user/keys | API 密钥 |
| GET | /api/user/usage | 使用记录 |
| POST | /api/user/recharge-request | 充值请求 |

---

## 测试步骤

1. **SSO 登录**: 访问前端，点击 WildAccount 登录
2. **代理测试**: `curl -X POST http://localhost:3000/v1/chat/completions -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{"model":"gpt-3.5-turbo","messages":[{"role":"user","content":"Hello"}]}'`
3. **管理功能**: 登录管理员账号，添加服务商、密钥、用户
4. **备份恢复**: 在管理面板创建备份、下载、上传恢复
