# WildAPI 调用文档

> AI API 中转站 —— OpenAI 协议 100% 兼容，一个 Key 调用全部已上架模型。
>
> **服务地址 (Base URL)**: `https://api.wildcreator.top/v1`
> 第三方客户端（ChatBox / NextChat / LobeChat / DeepSeek Harness / Codex 等）中 API 地址只需填到 `/v1` 或不带路径的域名根，工具会自动拼接端点。

---

## 1. 获取密钥

1. 登录面板 → 左侧「API 密钥」
2. 点击「创建密钥」，得到形如 `ak-xxxxxxxx...` 的明文密钥（**仅展示一次**，请立即保存）
3. 每个账号最多 20 个有效密钥，可随时启用/禁用/删除（删除立即失效）

调用产生的费用从**密钥归属账号**的余额实时扣除，管理员账号同样计费。

## 2. 认证方式

支持三种头部写法（任选其一）：

```
Authorization: Bearer ak-你的密钥        # 通用 (OpenAI 风格)
x-api-key: ak-你的密钥                   # Anthropic SDK 默认风格
```

认证失败返回 `401`；密钥被禁用/删除同样 401。

## 3. 接口列表

| 端点 | 方法 | 说明 |
|-----|------|------|
| `/v1/models` | GET | 列出全部可调用模型（实时同步上游检测结果） |
| `/v1/chat/completions` | POST | 对话补全（支持流式 SSE） |
| `/v1/responses` | POST | OpenAI Responses API（DeepSeek Harness / Codex 兼容） |
| `/v1/messages` | POST | Anthropic Messages API 兼容（协议自动转换） |
| `/v1/completions`、`/v1/embeddings` | POST | 其余 `/v1/*` 路径透明转发到上游 |

### 3.1 模型列表

```bash
curl https://api.wildcreator.top/v1/models \
  -H "Authorization: Bearer $WILD_API_KEY"
```

返回标准 OpenAI 格式：

```json
{ "object": "list", "data": [ { "id": "deepseek-v4-flash", "object": "model", "owned_by": "Deepseek" } ] }
```

> 模型列表来自上游实时探测：只有真正调用通过的模型才会出现，可放心直接引用其 `id`。

### 3.2 对话补全（非流式）

```bash
curl https://api.wildcreator.top/v1/chat/completions \
  -H "Authorization: Bearer $WILD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

响应与 OpenAI 完全一致（`choices` / `usage` / `id` ...）。

### 3.3 对话补全（流式 SSE）

请求体加 `"stream": true`，返回标准 `data: {...}` 分片流，以 `data: [DONE]` 结束：

```bash
curl -N https://api.wildcreator.top/v1/chat/completions \
  -H "Authorization: Bearer $WILD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"讲个笑话"}]}'
```

> 流式按服务端实际输出 token 计费（防篡改计量），断流也按已输出部分计费。

### 3.4 Responses API（Harness / Codex 类工具）

```bash
curl https://api.wildcreator.top/v1/responses \
  -H "Authorization: Bearer $WILD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "input": "你好",
    "stream": true
  }'
```

- `input` 支持纯字符串或消息数组；`instructions` 会映射为 system 消息
- 流式返回完整 Responses 事件序列（`response.created` → `response.output_text.delta`* → `response.completed`）
- 计费与 Chat Completions 相同

### 3.5 Anthropic Messages 兼容

```bash
curl https://api.wildcreator.top/v1/messages \
  -H "x-api-key: $WILD_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

Claude SDK 只需把 `base_url` 指到本站即可直接使用。

支持的工具相关字段（双向转换）：`tools`（`input_schema` → `function.parameters`）、
`tool_choice`（`auto`/`any`/`tool` → `auto`/`required`/指定函数）、历史消息里的
`tool_use` / `tool_result` 块，以及流式响应里的 `content_block_start(tool_use)` →
`input_json_delta` → `message_delta(stop_reason=tool_use)` 事件序列。
`top_k`、`thinking` 属 Anthropic 专有采样参数，OpenAI 侧无对应字段，转换时忽略。

> 上游线路协议统一为 **OpenAI 兼容方言**（`/v1/chat/completions` + `Bearer`）。
> 服务商分类 `anthropic` 只决定计价口径，不会改成原生 Anthropic 线路；
> 直连 `api.anthropic.com` 这类纯 Anthropic 端点会被可用性检测判为不可达。

## 4. SDK 快速接入

### Python (openai)

```python
from openai import OpenAI

client = OpenAI(
    api_key="ak-你的密钥",
    base_url="https://api.wildcreator.top/v1",
)

resp = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

### Node.js (openai)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'ak-你的密钥',
  baseURL: 'https://api.wildcreator.top/v1',
});

const resp = await client.chat.completions.create({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: '你好' }],
});
console.log(resp.choices[0].message.content);
```

### Python (anthropic)

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="ak-你的密钥",
    base_url="https://api.wildcreator.top",
)
msg = client.messages.create(
    model="deepseek-v4-flash", max_tokens=100,
    messages=[{"role": "user", "content": "你好"}],
)
```

## 5. 计费说明

- 按 **token 计费**：`费用 = 输入token/1000 × 输入单价 + 输出token/1000 × 输出单价`，单价由管理端「定价配置」实时定义（支持通配模型模式与倍率）
- **请求前预检**：余额 ≤ 0 直接拒绝（402），不产生上游调用
- **请求后结算**：扣费、余额流水、请求日志在同一事务写入，「余额明细」「使用记录」实时可查
- 上游报错（4xx/5xx 无输出）不计费

## 6. 速率与并发限制

| 维度 | 默认值 | 说明 |
|-----|-------|------|
| 全局（按 IP） | 600 次/分钟 | 超出 429 |
| 用户 | 120 次/分钟（可被管理员按账号定制） | 超出 429 |
| 用户并发 | 3 个进行中请求（可调 1-100） | 超出 429 |
| 厂商（上游） | 60 次/分钟、10 并发（管理端可调） | 保护上游配额 |

`429` 响应带中文提示，等待约 1 分钟自动恢复。

## 7. 错误码

| HTTP | type | 含义与处理 |
|------|------|-----------|
| 400 | `invalid_request_error` | 请求体不合法 / 模型名不支持（先查 `/v1/models`） |
| 401 | `AUTH_ERROR` | 密钥缺失/无效/被删，检查 `Authorization` 头 |
| 402 | `INSUFFICIENT_BALANCE` | 余额不足，充值后重试 |
| 404 | `MODEL_NOT_FOUND` / `NOT_FOUND` | 模型已下架或路径拼写错误 |
| 429 | `RATE_LIMITED` | 触发速率/并发限制，稍后重试 |
| 502 | `UPSTREAM_ERROR` | 上游全部不可用（自动重试与密钥轮询后仍失败） |
| 504 | `upstream_timeout` | 上游超时（120 秒） |

错误统一为 OpenAI 兼容格式：

```json
{ "error": { "message": "...", "type": "...", "code": 402 } }
```

## 8. 常见问题

**Q: 模型名怎么写？** 以 `GET /v1/models` 返回的 `id` 为准，直接整串使用（如 `deepseek-v4-flash`），不要使用通配前缀。

**Q: Harness/Codex 获取模型 429？** 检查 API 地址是否误填成 `.../v1/chat/completions`，导致工具探测 `/v1/chat/completions/models` 这类无效路径；正确填 `https://api.wildcreator.top/v1`。

**Q: 密钥泄露怎么办？** 面板删除该密钥并新建，旧密钥立即失效，无需改密码。

**Q: 余额和用量在哪看？** 面板「我的仪表盘 / 余额明细 / 使用记录」，每次调用一行流水。
