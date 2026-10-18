#!/usr/bin/env node
/**
 * ============================================
 * WildAPI - 代理转发链路回归测试 (无需 MySQL/Redis)
 * ============================================
 * 用本地 mock 上游服务商跑通真实 HTTP 请求: 认证 → 限流 → 路由 → 取密钥 →
 * 转发 (含 SSE 流式) → 计费结算，逐项断言。
 * 数据库/Redis 用可脚本化的假实现替换，只替换"外部依赖"，
 * 被测的是 src/routes/proxy.js 与 src/services/* 的真实代码。
 *
 * 使用方式: npm run test:relay   (或 node scripts/test-relay.js)
 * 退出码: 0 = 全部通过, 1 = 有断言失败
 */

const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const SRC = require('path').join(__dirname, '..', 'src');

// ==================== 外部依赖替身 ====================

const state = {
  settled: [],          // settleTransaction 调用记录
  cooldowns: [],        // ProviderKey.setCooldown 调用记录
  providerFailures: [], // 熔断计数调用记录
  redisDown: false,     // 置为 true 时所有 Redis 调用抛错 (验证降级放行)
};

function stub(id, exports) {
  const filename = require.resolve(id);
  require.cache[filename] = { id: filename, filename, paths: [], loaded: true, exports };
}

// 假 Redis: 放行限流窗口 (-1) 与并发槽 (1)
const fakeRedis = {
  async eval(script, numKeys, key, ...args) {
    if (state.redisDown) throw new Error('ECONNREFUSED redis');
    return String(script).includes('ZCARD') ? -1 : 1;
  },
  async get() { if (state.redisDown) throw new Error('ECONNREFUSED redis'); return null; },
  async set() { if (state.redisDown) throw new Error('ECONNREFUSED redis'); return 'OK'; },
  async incr(key) {
    if (state.redisDown) throw new Error('ECONNREFUSED redis');
    if (String(key).startsWith('circuit:fail')) state.providerFailures.push(key);
    return 1;
  },
  async del() { if (state.redisDown) throw new Error('ECONNREFUSED redis'); return 1; },
  async exists() { return 0; },
  async expire() { return 1; },
  async ttl() { return -2; },
  async ping() { if (state.redisDown) throw new Error('ECONNREFUSED redis'); return 'PONG'; },
  on() {},
  once() {},
};

stub(path2id('../config/database'), {
  pool: { query: async () => [[]], getConnection: async () => { throw new Error('测试不应访问 MySQL'); } },
  redis: fakeRedis,
  testConnections: async () => ({ mysql: true, redis: true }),
});

function path2id(p) { return require.resolve(require('path').join(SRC, p.replace(/^\.\.\//, ''))); }

// 认证中间件: 直接注入一个代理密钥用户
stub(path2id('../middleware/proxyResolver'), {
  proxyResolver: (req, res, next) => {
    const auth = req.headers.authorization || req.headers['x-api-key'] || '';
    if (!auth.includes('test-key')) return res.status(401).json({ error: { message: '无效的 API 密钥' } });
    req.user = { id: 1, username: 'relay-test', role: 'user', balance: 100, usingProxyKey: true, proxyKeyId: 9, rpm_limit: null };
    next();
  },
});

// 路由: 固定指向 mock 上游 (由 setMockBaseUrl 注入)
const providerRow = { id: 1, name: 'mock-provider', type: 'openai', base_url: '' };
stub(path2id('../services/routerService'), {
  resolveRoute: async () => ({ providerId: 1, providerName: providerRow.name, providerType: providerRow.type }),
});

// 模型层
stub(path2id('../models/Provider'), {
  findById: async () => providerRow,
  listActive: async () => [providerRow],
  list: async () => [providerRow],
});
stub(path2id('../models/ProviderKey'), {
  getAvailableKeys: async () => [{ id: 7, provider_id: 1, is_active: 1 }],
  getDecryptedKey: async () => 'sk-upstream-mock',
  incrementUsage: async () => {},
  setCooldown: async (id, sec) => { state.cooldowns.push({ id, sec }); },
  findById: async (id) => ({ id, provider_id: 1 }),
});
stub(path2id('../models/RateLimitConfig'), {
  findByProviderId: async () => ({ retry_attempts: 2, retry_delay_ms: 5, requests_per_minute: 600, concurrent_limit: 10 }),
});
stub(path2id('../models/ModelRoute'), {
  matchModelIncludingInactive: async () => null,
  matchModel: async () => ({ provider_id: 1, provider_name: providerRow.name, provider_type: 'openai' }),
  list: async () => [],
  listByProvider: async () => [],
  findById: async () => null,
});
stub(path2id('../models/ModelAvailability'), { listAvailableSafe: async () => [] });
stub(path2id('../models/User'), { findById: async () => ({ id: 1, username: 'relay-test', role: 'user', balance: 100, is_active: 1, concurrent_limit: 3, rpm_limit: null }) });
stub(path2id('../models/RequestLog'), { create: async () => ({ id: 0 }) });

// 计费: 记录结算入参，token→成本用可预测的线性公式
stub(path2id('../services/billingService'), {
  checkBalance: async () => true,
  getPricing: async () => ({ promptPrice: 1, completionPrice: 2, source: 'test' }),
  calculateCost: async (model, tokensIn, tokensOut) => Number(((tokensIn / 1000) * 1 + (tokensOut / 1000) * 2).toFixed(6)),
  settleTransaction: async ({ userId, cost, requestLog }) => {
    state.settled.push({ userId, cost, log: requestLog });
    return { logId: state.settled.length, balanceBefore: 100, balanceAfter: 100 - cost };
  },
});

// token 估算: 固定值，便于区分"用了上游 usage"还是"用了本地估算"
stub(path2id('../services/tokenEstimator'), {
  getTokenUsage: () => ({ promptTokens: 0, completionTokens: 0 }),
  estimateInputTokens: async () => 100,
  estimateTokens: async (text) => String(text || '').length,
});

// ==================== 被测代码 ====================

const express = require('express');
const proxyRoutes = require(path2id('../routes/proxy'));
const { errorHandler } = require(path2id('../middleware/errorHandler'));
const { joinUpstream } = require(path2id('../utils/upstreamUrl'));

// ==================== mock 上游服务商 ====================

const upstream = { port: 0, requests: [], flakyCount: 0, lastAborted: false };

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

function sse(res, lines) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  lines.forEach((l) => res.write(l));
  res.end();
}

const upstreamServer = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch { /* 非 JSON 请求体 */ }
  upstream.requests.push({ method: req.method, url: req.url, headers: req.headers, body });

  req.on('close', () => { if (!req.complete) upstream.lastAborted = true; });
  res.on('close', () => { if (!res.writableEnded) upstream.lastAborted = true; });

  const model = body.model || '';

  if (model === 'mock/ok') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'chatcmpl-ok', model, choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
    }));
  }

  if (model === 'mock/stream') {
    return sse(res, [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"你"}}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"好"}}]}\n\n',
      // 末片携带 finish_reason + usage (需 stream_options.include_usage，真实上游行为)
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
      'data: [DONE]\n\n',
    ]);
  }

  if (model === 'mock/err400') {
    // 关键回归: stream:true 时上游返回 400，绝不能被当作 200 SSE 透传
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '模型参数错误', type: 'invalid_request_error' } }));
  }

  if (model === 'mock/flaky') {
    upstream.flakyCount++;
    if (upstream.flakyCount === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: '上游炸了', type: 'server_error' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'chatcmpl-retry', model, choices: [{ index: 0, message: { role: 'assistant', content: '重试成功' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }));
  }

  if (model === 'mock/always401') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }));
  }

  if (model === 'mock/slow') {
    // 持续输出的慢流: 用于验证客户端断开后上游被中止
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      i++;
      if (i > 40) { clearInterval(timer); return res.end(); }
      res.write(`data: {"id":"c2","choices":[{"index":0,"delta":{"content":"x"}}]}\n\n`);
    }, 100);
    res.on('close', () => { clearInterval(timer); upstream.lastAborted = true; });
    return undefined;
  }

  if (model === 'mock/tools') {
    // OpenAI 上游返回函数调用 → 必须还原成 Anthropic 的 tool_use 内容块
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'chatcmpl-tools', model,
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_42', type: 'function', function: { name: 'get_time', arguments: '{"tz":"Asia/Shanghai"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 21, completion_tokens: 9 },
    }));
  }

  if (model === 'mock/stream-tools') {
    return sse(res, [
      'data: {"id":"c3","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"c3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_7","type":"function","function":{"name":"get_time","arguments":""}}]}}]}\n\n',
      'data: {"id":"c3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"tz\\":"}}]}}]}\n\n',
      'data: {"id":"c3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Asia\\"}"}}]}}]}\n\n',
      'data: {"id":"c3","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":13,"completion_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ]);
  }

  if (model === 'mock/stream-thinking') {
    // 推理文本 + 正文 + 工具调用混排: 内容块必须各自成块且 index 递增
    return sse(res, [
      'data: {"id":"c4","choices":[{"index":0,"delta":{"reasoning_content":"先想想"}}]}\n\n',
      'data: {"id":"c4","choices":[{"index":0,"delta":{"content":"答案是 4"}}]}\n\n',
      'data: {"id":"c4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"calc","arguments":"{}"}}]}}]}\n\n',
      'data: {"id":"c4","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  }

  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [] }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ id: 'chatcmpl-echo', model, choices: [{ index: 0, message: { content: 'echo' }, finish_reason: 'stop' }], usage: {} }));
});

// ==================== 测试运行器 ====================

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function request(path, options = {}) {
  const res = await fetch(`http://127.0.0.1:${relayPort}${path}`, {
    headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json', ...(options.headers || {}) },
    method: options.method || 'POST',
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

function lastSettlement() { return state.settled[state.settled.length - 1]; }
function resetState() { state.settled.length = 0; state.cooldowns.length = 0; state.providerFailures.length = 0; upstream.requests.length = 0; upstream.flakyCount = 0; upstream.lastAborted = false; }

let relayPort = 0;

async function main() {
  await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
  upstream.port = upstreamServer.address().port;
  providerRow.base_url = `http://127.0.0.1:${upstream.port}`;

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', proxyRoutes);
  app.use(errorHandler);
  const relayServer = app.listen(0, '127.0.0.1');
  await new Promise((r) => relayServer.once('listening', r));
  relayPort = relayServer.address().port;

  // ---------- 单元: 上游 URL 拼接 ----------
  test('joinUpstream: base_url 带查询串不与路径粘连 (Azure 风格)', () => {
    assert.equal(
      joinUpstream('https://x.openai.azure.com/openai?api-version=2024-02-15-preview', '/v1/chat/completions'),
      'https://x.openai.azure.com/openai/v1/chat/completions?api-version=2024-02-15-preview'
    );
  });
  test('joinUpstream: 自带 /v1 的 base 不产生双前缀', () => {
    assert.equal(joinUpstream('https://dashscope.aliyuncs.com/compatible-mode/v1', '/v1/chat/completions'),
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    assert.equal(joinUpstream('https://api.deepseek.com', '/v1/chat/completions'),
      'https://api.deepseek.com/v1/chat/completions');
  });
  test('joinUpstream: 客户端查询参数透传', () => {
    assert.equal(joinUpstream('https://a.com', '/v1/models', { after: 'm-1' }), 'https://a.com/v1/models?after=m-1');
  });

  // ---------- 非流式 ----------
  test('非流式: 原样透传上游响应体与 usage 计费', async () => {
    resetState();
    const r = await request('/v1/chat/completions', { body: { model: 'mock/ok', messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(r.status, 200);
    const json = JSON.parse(r.text);
    assert.equal(json.id, 'chatcmpl-ok');
    assert.equal(json.choices[0].message.content, '你好');
    const s = lastSettlement();
    assert.equal(s.log.tokensIn, 11, '应使用上游 usage.prompt_tokens 而非本地估算 100');
    assert.equal(s.log.tokensOut, 4);
    assert.equal(s.log.providerKeyId, 7, '日志必须记下实际服务的上游密钥');
    assert.equal(s.log.statusCode, 200);
    assert.ok(s.cost > 0);
  });

  test('非流式: 上游请求头为 Bearer 且未泄漏客户端密钥', async () => {
    resetState();
    await request('/v1/chat/completions', { body: { model: 'mock/ok', messages: [] } });
    const sent = upstream.requests[0];
    assert.equal(sent.headers.authorization, 'Bearer sk-upstream-mock');
    assert.ok(!sent.headers.authorization.includes('test-key'));
    assert.equal(sent.method, 'POST');
  });

  // ---------- 流式 ----------
  test('流式: 分片完整透传 + 取上游 usage 计费', async () => {
    resetState();
    const r = await request('/v1/chat/completions', { body: { model: 'mock/stream', stream: true, messages: [] } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
    assert.ok(r.text.includes('"content":"你"'), '分片必须原样到达客户端');
    assert.ok(r.text.includes('data: [DONE]'));
    const s = lastSettlement();
    assert.equal(s.log.tokensIn, 11, '流式也必须优先用上游 usage');
    assert.equal(s.log.tokensOut, 7, '流式输出 token 取 SSE 末片 usage，不再按字符数估算');
    assert.equal(s.log.statusCode, 200);
  });

  test('流式: 上游 400 不得伪装成 200 SSE (P0 回归)', async () => {
    resetState();
    const r = await request('/v1/chat/completions', { body: { model: 'mock/err400', stream: true, messages: [] } });
    assert.equal(r.status, 400, '上游错误状态码必须原样回传');
    assert.ok(!/text\/event-stream/.test(r.headers.get('content-type') || ''), '错误响应不应带 SSE 头');
    const json = JSON.parse(r.text);
    assert.equal(json.error.message, '模型参数错误');
    assert.equal(lastSettlement().log.statusCode, 400);
  });

  test('流式: 客户端断开后中止上游 (不再空烧配额)', async () => {
    resetState();
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock/slow', stream: true, messages: [] }),
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(upstream.lastAborted, true, '上游流应因客户端断开而被中止');
  });

  // ---------- 重试 / 故障分级 ----------
  test('重试: 首个 500 后换密钥重试并成功返回 200', async () => {
    resetState();
    const r = await request('/v1/chat/completions', { body: { model: 'mock/flaky', messages: [] } });
    assert.equal(r.status, 200, '5xx 应触发重试而不是直接把错误抛给客户端');
    assert.equal(JSON.parse(r.text).id, 'chatcmpl-retry');
    assert.equal(upstream.requests.length, 2);
    assert.ok(state.cooldowns.length >= 1, '失败密钥应进入冷却');
    assert.ok(state.providerFailures.length >= 1, '5xx 应累计服务商熔断计数');
  });

  test('故障分级: 401 记密钥冷却 (300 秒) 且不累计服务商熔断', async () => {
    resetState();
    const r = await request('/v1/chat/completions', { body: { model: 'mock/always401', messages: [] } });
    assert.equal(r.status, 401);
    assert.ok(state.cooldowns.every((c) => c.sec === 300), '401/403 属密钥级故障，冷却期应更长');
    assert.equal(state.providerFailures.length, 0, '鉴权失败不该算服务商不可用');
    assert.equal(lastSettlement().log.statusCode, 401);
  });

  // ---------- Anthropic 工具调用桥接 ----------
  test('工具调用: /v1/messages 的 tools/tool_choice/tool_result 映射到 OpenAI 方言', async () => {
    resetState();
    const r = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock/tools',
        max_tokens: 64,
        system: '你是助手',
        tools: [{ name: 'get_time', description: '取时间', input_schema: { type: 'object', properties: { tz: { type: 'string' } } } }],
        tool_choice: { type: 'auto' },
        messages: [
          { role: 'user', content: [{ type: 'text', text: '现在几点' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_time', input: { tz: 'Asia/Shanghai' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '18:00' }] },
        ],
      }),
    });
    assert.equal(r.status, 200);
    const sent = upstream.requests[0].body;
    assert.equal(sent.tools[0].function.name, 'get_time');
    assert.equal(sent.tools[0].function.parameters.type, 'object');
    assert.equal(sent.tool_choice, 'auto');
    const asst = sent.messages.find(m => m.role === 'assistant');
    assert.equal(asst.tool_calls[0].id, 'toolu_1', 'assistant 历史里的 tool_use 必须转成 tool_calls');
    assert.equal(asst.tool_calls[0].function.arguments, '{"tz":"Asia/Shanghai"}');
    const toolMsg = sent.messages.find(m => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'toolu_1', 'tool_result 必须转成 role:tool 消息');
    assert.equal(toolMsg.content, '18:00');

    const json = await r.json();
    const block = json.content.find(b => b.type === 'tool_use');
    assert.ok(block, '响应必须还原 tool_use 内容块');
    assert.equal(block.id, 'call_42');
    assert.deepEqual(block.input, { tz: 'Asia/Shanghai' });
    assert.equal(json.stop_reason, 'tool_use');
  });

  test('工具调用: 流式 tool_calls 分片还原成 input_json_delta 事件序列', async () => {
    resetState();
    const r = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock/stream-tools', max_tokens: 64, messages: [{ role: 'user', content: '几点' }], stream: true }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(text.includes('"type":"tool_use"'), '必须发出 tool_use 的 content_block_start');
    assert.ok(text.includes('input_json_delta'), '参数增量必须用 input_json_delta');
    assert.ok(text.includes('"partial_json":"{\\"tz\\":"'), '分片参数内容原样透传');
    assert.ok(text.includes('"content_block_stop"'));
    assert.ok(/"stop_reason":"tool_use"/.test(text), '收尾 message_delta 应给出 tool_use');
    assert.ok(text.includes('"type":"message_stop"'), '必须以 message_stop 结束');
    const s = lastSettlement();
    assert.equal(s.log.tokensOut, 6, '流式取上游 usage 的 completion_tokens');
  });

  test('流式混排: thinking / text / tool 各自成块且 index 递增', async () => {
    const r = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock/stream-thinking', max_tokens: 64, messages: [{ role: 'user', content: 'x' }], stream: true }),
    });
    const text = await r.text();
    assert.ok(text.includes('"thinking_delta"'), 'reasoning_content 映射为 thinking 块');
    assert.ok(text.includes('"text_delta"'));
    assert.ok(text.includes('"type":"tool_use"'));
    const thinkingIdx = text.indexOf('"thinking_delta"');
    const textIdx = text.indexOf('"text_delta"');
    const toolIdx = text.indexOf('"input_json_delta"');
    assert.ok(thinkingIdx < textIdx && textIdx < toolIdx, '三类增量按出现顺序输出');
    const blockStarts = [...text.matchAll(/"content_block_start",.*?"index":(\d+)/g)].map(m => Number(m[1]));
    assert.deepEqual(blockStarts, [0, 1, 2], '内容块 index 递增不重复');
  });

  test('计费文本: 工具调用参数增量计入输出 (否则上游不回 usage 时漏计费)', () => {
    const { extractDeltaText } = require(path2id('../services/proxyService'));
    assert.equal(
      extractDeltaText('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}'),
      '{"a":1}'
    );
  });

  // ---------- 方法 / 协议 ----------
  test('方法透传: GET 不转成 POST 且不带请求体', async () => {
    resetState();
    await request('/v1/models/gpt-4o', { method: 'GET' });
    assert.equal(upstream.requests[0].method, 'GET');
  });

  test('协议映射: /v1/messages 转 OpenAI 方言上游，响应还原 Anthropic 形状', async () => {
    resetState();
    const r = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock/ok', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.type, 'message');
    assert.equal(json.content[0].text, '你好');
    assert.equal(upstream.requests[0].url, '/v1/chat/completions');
    assert.equal(upstream.requests[0].headers.authorization, 'Bearer sk-upstream-mock');
    assert.equal(json.usage.input_tokens, 11);
  });

  // ---------- 降级 ----------
  test('Redis 不可用: 限流/并发/熔断全部放行，请求仍成功 (不降级成 500)', async () => {
    resetState();
    state.redisDown = true;
    try {
      const r = await request('/v1/chat/completions', { body: { model: 'mock/ok', messages: [] } });
      assert.equal(r.status, 200, 'Redis 故障时代理必须放行而不是 500');
      assert.equal(JSON.parse(r.text).id, 'chatcmpl-ok');
    } finally {
      state.redisDown = false;
    }
  });

  // ---------- 计费口径 ----------
  test('未发出上游请求 (无可用密钥): 不计费', async () => {
    resetState();
    const ProviderKey = require(path2id('../models/ProviderKey'));
    const original = ProviderKey.getAvailableKeys;
    ProviderKey.getAvailableKeys = async () => [];
    try {
      const r = await request('/v1/chat/completions', { body: { model: 'mock/ok', messages: [] } });
      assert.equal(r.status, 502);
      const s = lastSettlement();
      assert.equal(s.log.tokensIn, 0, '请求从未到达上游，不应按输入 token 收费');
      assert.equal(s.cost, 0);
    } finally {
      ProviderKey.getAvailableKeys = original;
    }
  });

  // ---- run ----
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  [OK] ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  [FAIL] ${t.name}`);
      console.log(`         ${err.message}`);
    }
  }

  console.log(`\n代理链路测试: ${tests.length - failed}/${tests.length} 通过`);
  return failed === 0;
}

main()
  .then((ok) => { process.exit(ok ? 0 : 1); })
  .catch((err) => { console.error('测试框架异常:', err); process.exit(1); })
  .finally(() => {
    setTimeout(() => { upstreamServer.close(); process.exit(0); }, 50);
  });
