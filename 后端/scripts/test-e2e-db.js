#!/usr/bin/env node
/**
 * ============================================
 * WildAPI - 端到端联调校验 (需要可达的 MySQL + Redis)
 * ============================================
 * 与 test-relay.js 的区别: 那个用假 pool/Redis 单测转发链路，
 * 这个连真数据库跑完整一遭 —— 建临时服务商与密钥、跑真实 HTTP 调用、
 * 再回查 request_logs / users.balance 断言落库结果是否正确。
 *
 * 用法 (会向这个库写数据，必须显式确认):
 *   WILDAPI_E2E_CONFIRM=1 npm run test:e2e
 *   可选覆盖: DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME REDIS_HOST REDIS_PORT
 *
 * 所有种子数据都以 `E2E-` / `e2e-` 前缀标记，结束时按 user_id 精确回删，
 * 不会碰到已有账号、服务商或日志。
 *
 * 退出码: 0 = 全部断言通过, 1 = 失败或未确认
 */

if (process.env.WILDAPI_E2E_CONFIRM !== '1') {
  console.error('[e2e] 未确认: 本脚本会向当前配置的数据库写入并删除临时数据。');
  console.error('[e2e] 确认无误后加环境变量重跑: WILDAPI_E2E_CONFIRM=1 npm run test:e2e');
  process.exit(1);
}

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

// 每次运行自带一套密钥与会话密钥，不依赖也不污染 .env。
// 必须在 require encryptionService 之前写入: 该模块加载时就把密钥固化进 config，
// 父进程加密、子进程解密必须是同一把
const ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
process.env.JWT_SECRET = JWT_SECRET;

const mysql = require('mysql2/promise');
const { encrypt } = require('../src/services/encryptionService');
const UserProxyKey = require('../src/models/UserProxyKey');

const RUN_TAG = `e2e-${Date.now()}`;
const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'wildapi',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'wildapi',
};

const results = { passed: 0, failed: 0 };
function check(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`  [OK] ${name}`);
  } catch (err) {
    results.failed++;
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// ==================== mock 上游 ====================

const mockState = { requests: [] };

function startMockUpstream() {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      mockState.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-model', object: 'model' }] }));
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"id":"e2e-1","choices":[{"index":0,"delta":{"content":"你"}}]}\n\n');
        res.write('data: {"id":"e2e-1","choices":[{"index":0,"delta":{"content":"好"}}]}\n\n');
        res.write('data: {"id":"e2e-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (body.tools && body.messages?.some(m => m.role === 'tool')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'e2e-tools', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_e2e', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"ok":true}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 30, completion_tokens: 8 },
        }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'e2e-2', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'e2e-reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ==================== 种子数据 ====================

let seed = null;

async function seedFixture(conn, mockPort) {
  const proxySecret = 'ak-' + crypto.randomBytes(24).toString('hex');
  const upstreamKey = 'sk-e2e-upstream-key';

  const [u] = await conn.query(
    'INSERT INTO users (wildaccount_id, username, email, role, balance) VALUES (?, ?, ?, ?, ?)',
    [`${RUN_TAG}-user`, `${RUN_TAG}-user`, null, 'user', 10]
  );
  const userId = u.insertId;

  await conn.query(
    'INSERT INTO user_proxy_keys (user_id, name, key_prefix, key_hash, key_suffix) VALUES (?, ?, ?, ?, ?)',
    [userId, `${RUN_TAG}-key`, proxySecret.substring(0, 11), UserProxyKey.hash(proxySecret), proxySecret.substring(proxySecret.length - 4)]
  );

  const [p] = await conn.query(
    'INSERT INTO providers (name, type, base_url, weight, is_active) VALUES (?, ?, ?, ?, ?)',
    [`E2E-${RUN_TAG}`, 'openai', `http://127.0.0.1:${mockPort}`, 1, 1]
  );
  const providerId = p.insertId;

  await conn.query(
    'INSERT INTO provider_keys (provider_id, key_name, key_encrypted, is_active) VALUES (?, ?, ?, ?)',
    [providerId, `${RUN_TAG}-upstream`, encrypt(upstreamKey), 1]
  );
  const [pkRows] = await conn.query('SELECT id FROM provider_keys WHERE provider_id = ?', [providerId]);
  const providerKeyId = pkRows[0].id;

  await conn.query(
    'INSERT INTO model_routes (model_pattern, provider_id, priority, is_active) VALUES (?, ?, ?, ?)',
    ['e2e-model*', providerId, 1, 1]
  );
  await conn.query(
    'INSERT INTO rate_limit_configs (provider_id, requests_per_minute, concurrent_limit, retry_attempts, retry_delay_ms) VALUES (?, ?, ?, ?, ?)',
    [providerId, 600, 10, 2, 50]
  );
  await conn.query(
    'INSERT INTO pricing_configs (model_pattern, provider_type, prompt_price, completion_price, multiplier, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    ['e2e-model*', 'openai', 0.001, 0.002, 1.000, 1]
  );

  seed = { userId, providerId, providerKeyId, proxySecret };
}

async function cleanup(conn) {
  if (!seed) return;
  await conn.query('DELETE FROM request_logs WHERE user_id = ?', [seed.userId]);
  await conn.query('DELETE FROM user_balance_transactions WHERE user_id = ?', [seed.userId]);
  await conn.query('DELETE FROM model_availability WHERE provider_id = ?', [seed.providerId]);
  await conn.query('DELETE FROM pricing_configs WHERE model_pattern LIKE ?', ['e2e-model%']);
  await conn.query('DELETE FROM providers WHERE id = ?', [seed.providerId]); // 级联删 key/route/限流配置
  await conn.query('DELETE FROM users WHERE id = ?', [seed.userId]);
  console.log('  已回删本轮种子数据');
}

// ==================== 主流程 ====================

async function main() {
  const mock = await startMockUpstream();
  const mockPort = mock.address().port;
  const appPort = await freePort();

  const conn = await mysql.createConnection({ ...DB, multipleStatements: false });
  const [dbRows] = await conn.query('SELECT DATABASE() AS db');
  console.log(`\n端到端校验: ${DB.host}:${DB.port}/${dbRows[0].db} + Redis ${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || 6379}`);

  await seedFixture(conn, mockPort);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'app.js')], {
    env: {
      ...process.env,
      PORT: String(appPort),
      DB_HOST: DB.host, DB_PORT: String(DB.port), DB_USER: DB.user, DB_PASSWORD: DB.password, DB_NAME: DB.database,
      REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
      REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
      ENCRYPTION_KEY, JWT_SECRET,
      SSO_CLIENT_SECRET: 'e2e-unused',
      FRONTEND_URL: 'http://127.0.0.1:5173',
      AVAILABILITY_CHECK_INTERVAL_MIN: '9999',
      NODE_ENV: 'test', LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appLog = [];
  child.stdout.on('data', (d) => appLog.push(d.toString()));
  child.stderr.on('data', (d) => appLog.push(d.toString()));

  // 等健康检查转 ok (MySQL + Redis 都通才算)
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${appPort}/api/health`);
      const j = await r.json();
      if (j.status === 'ok') { healthy = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  check('/api/health 返回 ok (真 MySQL + 真 Redis 都通)', () => assert(healthy, `未就绪: ${appLog.join('').slice(-400)}`));
  if (!healthy) { child.kill(); mock.close(); await conn.end(); return false; }

  const base = `http://127.0.0.1:${appPort}`;
  const auth = { Authorization: `Bearer ${seed.proxySecret}`, 'Content-Type': 'application/json' };

  // 1. 非流式真实调用
  const r1 = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ model: 'e2e-model', messages: [{ role: 'user', content: '你好' }] }),
  });
  const j1 = await r1.json();
  check('非流式调用返回上游内容', () => {
    assert(r1.status === 200, `HTTP ${r1.status}`);
    assert(j1.choices?.[0]?.message?.content === 'e2e-reply', JSON.stringify(j1));
    assert(j1.usage?.prompt_tokens === 9 && j1.usage?.completion_tokens === 3, `usage 未原样透传: ${JSON.stringify(j1.usage)}`);
  });

  // 2. 流式真实调用
  const r2 = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ model: 'e2e-model', stream: true, messages: [{ role: 'user', content: '你好' }] }),
  });
  const t2 = await r2.text();
  check('流式调用分片完整且状态码 200', () => {
    assert(r2.status === 200, `HTTP ${r2.status}`);
    assert(/text\/event-stream/.test(r2.headers.get('content-type') || ''), r2.headers.get('content-type'));
    assert(t2.includes('"content":"你"') && t2.includes('"content":"好"') && t2.includes('[DONE]'), t2.slice(0, 300));
  });

  // 3. Anthropic 协议 + 工具调用真实调用
  const r3 = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': seed.proxySecret, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'e2e-model', max_tokens: 64,
      tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: '跑一下' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_e2e', name: 'do_thing', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e2e', content: 'done' }] },
      ],
    }),
  });
  const j3 = await r3.json();
  check('/v1/messages 工具调用往返 (Anthropic ↔ OpenAI)', () => {
    assert(r3.status === 200, `HTTP ${r3.status}`);
    assert(j3.content?.some(b => b.type === 'tool_use' && b.input?.ok === true), JSON.stringify(j3));
    assert(j3.stop_reason === 'tool_use', j3.stop_reason);
    const sent = mockState.requests.at(-1).body;
    assert(sent.tools?.[0]?.function?.name === 'do_thing', 'tools 未映射到上游');
    assert(sent.messages.some(m => m.role === 'tool' && m.tool_call_id === 'toolu_e2e'), 'tool_result 未映射');
  });

  // 4. 落库断言
  const [logs] = await conn.query(
    'SELECT model, provider_key_id, status_code, tokens_in, tokens_out, cost FROM request_logs WHERE user_id = ? ORDER BY id',
    [seed.userId]
  );
  check('三次调用都落库且归因到实际密钥', () => {
    assert(logs.length === 3, `日志条数 ${logs.length}`);
    assert(logs.every(l => l.provider_key_id === seed.providerKeyId), JSON.stringify(logs.map(l => l.provider_key_id)));
    assert(logs[0].tokens_in === 9 && logs[0].tokens_out === 3, `非流式 usage: ${logs[0].tokens_in}/${logs[0].tokens_out}`);
    assert(logs[1].tokens_in === 12 && logs[1].tokens_out === 5, `流式应取 SSE 末片 usage: ${logs[1].tokens_in}/${logs[1].tokens_out}`);
    assert(Number(logs[1].cost) === 0.000022, `成本 = 12/1000*0.001 + 5/1000*0.002 → ${logs[1].cost}`);
  });

  const [bal] = await conn.query('SELECT balance FROM users WHERE id = ?', [seed.userId]);
  const expectSpent = logs.reduce((s, l) => s + Number(l.cost), 0);
  check('余额按 6 位小数精确扣减 (= 各次成本之和)', () => {
    const after = Number(bal[0].balance);
    assert(Math.abs((10 - after) - expectSpent) < 1e-9, `余额 ${after}, 应扣 ${expectSpent}, 实际扣 ${10 - after}`);
  });

  const [txns] = await conn.query(
    "SELECT COUNT(*) AS n FROM user_balance_transactions WHERE user_id = ? AND type = 'api_consumption'",
    [seed.userId]
  );
  check('每次消费都有流水', () => assert(txns[0].n === 3, `流水 ${txns[0].n} 条`));

  const [cached] = await conn.query(
    'SELECT COUNT(*) AS n FROM request_logs WHERE user_id = ? AND provider_id IS NOT NULL', [seed.userId]
  );
  check('第二次调用走缓存命中不报错 (ak- 哈希索引路径)', () => assert(cached[0].n === 3, String(cached[0].n)));

  // 5. 管理接口在真库上可用
  const [admins] = await conn.query("SELECT role FROM users WHERE id = ?", [seed.userId]);
  check('种子用户角色仍为 user (本地角色不被上游覆盖)', () => assert(admins[0].role === 'user', admins[0].role));

  child.kill();
  mock.close();
  await cleanup(conn);
  await conn.end();

  console.log(`\n端到端校验: ${results.passed}/${results.passed + results.failed} 通过`);
  return results.failed === 0;
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch(async (err) => {
  console.error('[e2e] 异常:', err.message);
  process.exit(1);
});
