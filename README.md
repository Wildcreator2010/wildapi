# WildAPI

AI API 中转站。一个入口对接多家上游，按模型计价扣费，带管理后台。

给自己或小团队搭一套「登录 → 充值 → 拿 Key → 调模型 → 看用量」的东西。

## 能做什么

- **三种协议进同一个上游**：`/v1/chat/completions`、`/v1/messages`（Anthropic，含 `tools` / `tool_choice` / `tool_use` 双向转换）、`/v1/responses`（Responses ↔ Chat Completions）。
- **流式不骗人**：上游回 4xx/5xx 时不会被当成 `200 + text/event-stream` 吐给客户端；计费优先取上游 SSE 末片的真实 `usage`，取不到才本地估算。
- **密钥池轮转**：每把上游密钥独立并发计数与冷却。401/403 只冷却那把密钥，5xx/429 才累计服务商熔断并切换备用路由。
- **模型自动发现**：定期拉上游 `/v1/models` 并逐模型最小成本探测，探通的自动注册成路由，失效的发邮件告警（同类告警 6 小时冷却）。
- **动态计价**：按模型 + 厂商类型配单价，支持倍率；余额、流水、日志三处口径统一到 6 位小数。
- **限流与降级**：IP 全局 / 用户 RPM / 用户与密钥并发三层限制，都走 Redis Lua 原子滑动窗口；Redis 挂了是放行而不是把请求打成 500。
- **WildAccount 单点登录**：授权码换会话，回调带一次性 `state` 校验；上游返回的角色不被信任，管理员只能由本地后台授予。
- **管理后台**：服务商与密钥池、模型路由、定价、用户与余额、请求日志、用量统计、厂商分类、备份恢复。
- **审计**：`request_logs` 记下实际服务这次请求的上游密钥与模型，可按密钥维度看用量。

## 快速开始

### Docker 一键部署

```bash
cd 后端/docker
cp .env.example .env        # 密码与密钥必须全换掉，占位符不改会拒绝启动
chmod +x deploy.sh && ./deploy.sh
```

或者跑 `./wildapi.sh` 打开菜单面板（部署 / 状态 / 日志 / 备份 / 卸载）。
数据全落在 `.env` 里的 `DATA_DIR`（默认 `/opt/WildAPI`），MySQL 与 Redis 只绑 `127.0.0.1`，对外只开前端端口。

### 本地开发

```bash
cd 后端 && npm i && npm run migrate && npm run dev
cd 前端 && npm i && npm run dev
```

首个管理员：SSO 登录后你在库里的角色是 `user`，需要手动改一次

```sql
UPDATE users SET role = 'superadmin' WHERE username = '你的用户名';
```

### 跑校验

```bash
npm run test:relay   # 代理链路回归，自带 mock 上游，不需要 MySQL/Redis
npm run test:e2e     # 真库端到端，会写临时数据并自动回删，需 WILDAPI_E2E_CONFIRM=1
```

## 环境要求

Node 20+、MySQL 8、Redis 7。数据库账号需要对 `wildapi` 库的建表权限 —— 迁移脚本里的库名是硬编码的 `wildapi`，改了 `DB_NAME` 启动日志会明确报出来。

## 目录

```
后端/src         Express 应用（routes / services / models / middleware）
后端/migrations  10 个幂等 SQL，首次建表与升级都靠它
后端/docker      compose、镜像构建、deploy.sh / deploy.bat / wildapi.sh / uninstall
后端/scripts     迁移执行器、MySQL 初始化、两个回归测试工具
前端/src         React 18 + Vite + Tailwind 的管理面板
```

文档都在 `后端/`：`API_USAGE.md`（接口与 SDK 接入）、`DEPLOYMENT.md`、`DEPLOYMENT_GUIDE.md`（宝塔步骤）、`DOCKER_DEPLOYMENT_CHECK.md`（部署后逐项验收清单）、`UPGRADE_GUIDE.md`。

## 现在的边界

- 上游线路统一走 **OpenAI 兼容方言**。`anthropic` 只是计价分类，不代表会改用原生 Anthropic 线路；直连 `api.anthropic.com` 会被可用性检测判为不可达。
- `/v1/responses` 只转换文本对话，工具调用不在转换范围内。
- 没有 refresh token。会话是本地签发的 JWT（默认 24h），上游 WildAccount 的 access_token 只有 1h。
- 不支持「用户自带上游密钥直连」（BYOK），计费一律按平台价从余额扣。
- 没有支付回调：充值是用户提交申请 → 邮件通知管理员 → 管理员在后台加余额。
