const axios = require('axios');
const { pool, redis } = require('../config/database');
const Provider = require('../models/Provider');
const ProviderKey = require('../models/ProviderKey');
const ModelRoute = require('../models/ModelRoute');
const { sendProviderKeyAlert } = require('./mailService');
const { joinUpstream } = require('../utils/upstreamUrl');
const { buildUpstreamHeaders } = require('./proxyService');
const logger = require('../utils/logger');

/**
 * 上游模型发现与可用性检测服务
 * - 用上游 Key 调 /v1/models 拉取模型清单
 * - 对每个模型发最小探测请求验证可用性
 * - 探测通过的模型自动注册为有效路由 (无需手动添加)
 * - 周期调度 (默认 10 分钟) + 手动触发
 * - 失效 (auth_failed / unreachable) 时邮件告警 (冷却期去重)
 */

const DEFAULT_INTERVAL_MIN = parseInt(process.env.AVAILABILITY_CHECK_INTERVAL_MIN, 10) || 10;
const PROBE_TIMEOUT = 15000;
const MODEL_LIST_TIMEOUT = 20000;
const ALERT_COOLDOWN_SEC = 6 * 3600; // 同类告警 6 小时冷却
const PROBE_DELAY_MS = 200; // 模型间探测间隔，避免触发上游限流
// 非对话模型: 无法用 chat/completions 最小探测 (图像/音频/视频/语音合成识别等)，
// 每轮探测必失败还消耗上游配额，标记 unknown 跳过 (不影响路由自动注册: 仅 available 注册)
const NON_CHAT_MODEL = /(^|[-_.])(image|img|audio|video|tts|asr|speech|voice|music|dance|whisper|flux|wanx|paint|draw|cogview|cogvideo|cogvideox|kolors|suno)([-_.0-9]|$)/i;

/**
 * 上游探活请求头: 必须与真实转发 (proxyService) 用同一套线路协议，
 * 否则探活判定"可用"并自动注册路由的服务商，真实请求却打不通。
 * provider.type 只用于计价，不改变上游方言 (全部按 OpenAI 兼容处理)。
 */
function buildHeaders(_providerType, apiKey) {
  return buildUpstreamHeaders(apiKey, {});
}

/**
 * 拉取上游模型清单
 * @returns {{ ok, models: string[], error? }}
 */
async function discoverModels(provider, apiKey) {
  const baseUrl = provider.base_url;
  const headers = buildHeaders(provider.type, apiKey);
  const candidates = ['/v1/models', '/models'];

  for (const path of candidates) {
    try {
      const res = await axios.get(joinUpstream(baseUrl, path), {
        headers,
        timeout: MODEL_LIST_TIMEOUT,
        validateStatus: () => true,
      });

      if (res.status === 200) {
        const data = res.data;
        const models = Array.isArray(data?.data)
          ? data.data.map(m => m.id).filter(Boolean)
          : (Array.isArray(data) ? data.map(m => m.id || m).filter(Boolean) : []);
        if (models.length > 0) {
          return { ok: true, models: [...new Set(models)] };
        }
      }
      if ([401, 403].includes(res.status)) {
        return { ok: false, authError: true, error: `密钥无效 (${res.status})` };
      }
      // 404 时尝试下一个候选路径; 其他 5xx 继续尝试
    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        return { ok: false, unreachable: true, error: '端点超时，可能不可达' };
      }
      // 网络错误，继续尝试下一个候选路径
    }
  }

  return { ok: false, unreachable: true, error: '无法拉取模型清单 (端点不通或格式不支持)' };
}

/**
 * 最小成本探测单个模型
 * @returns {{ status, latencyMs, error? }}
 */
async function testModel(provider, apiKey, model) {
  const baseUrl = provider.base_url;
  const headers = buildHeaders(provider.type, apiKey);
  const lower = model.toLowerCase();

  // 非对话模型无法最小成本探测，标记 unknown 跳过 (embedding 不受影响，走独立分支)
  if (NON_CHAT_MODEL.test(lower)) {
    return { status: 'unknown', latencyMs: null, error: '非对话模型 (图像/音频/视频等)，跳过探测' };
  }

  const isEmbedding = lower.includes('embedding') || lower.includes('embed');

  let url;
  let body;

  if (isEmbedding) {
    url = joinUpstream(baseUrl, '/v1/embeddings');
    body = { model, input: 'ping' };
  } else {
    // 与真实转发一致的 OpenAI 兼容方言 (含 anthropic 类型服务商: 客户端 /v1/messages 会被协议映射后再转发)
    url = joinUpstream(baseUrl, '/v1/chat/completions');
    body = { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 };
  }

  const start = Date.now();
  try {
    const res = await axios.post(url, body, {
      headers,
      timeout: PROBE_TIMEOUT,
      validateStatus: () => true,
    });
    const latencyMs = Date.now() - start;

    if (res.status === 200) return { status: 'available', latencyMs };
    if ([401, 403].includes(res.status)) {
      return { status: 'auth_failed', latencyMs, error: `鉴权失败 (${res.status})` };
    }
    if (res.status === 404) {
      // 模型不存在 ≠ 密钥失效，归为不可达避免误报"密钥失效"告警
      return { status: 'unreachable', latencyMs, error: '模型不可用 (404)' };
    }
    return { status: 'unreachable', latencyMs, error: `上游错误 (${res.status})` };
  } catch (err) {
    const latencyMs = Date.now() - start;
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return { status: 'unreachable', latencyMs, error: '超时' };
    }
    return { status: 'unreachable', latencyMs, error: `网络错误: ${err.message}` };
  }
}

/**
 * 告警去重检查 (Redis, 6 小时冷却)
 */
async function shouldSendAlert(providerKeyId, status) {
  const key = `alert:providerkey:${providerKeyId}:${status}`;
  try {
    const exists = await redis.get(key);
    if (exists) return false;
    await redis.set(key, '1', 'EX', ALERT_COOLDOWN_SEC);
    return true;
  } catch (err) {
    // Redis 不可用时不发消息: 没有冷却窗口就可能出现告警轰炸
    logger.warn('告警冷却检查不可用，本次跳过邮件', { providerKeyId, status, error: err.message });
    return false;
  }
}

/**
 * 探测通过的模型自动注册为有效路由
 * - 已有任何匹配路由 (含通配符、含已下架) 时不重复添加，不覆盖人工上下架决策
 * - priority=5: 低于人工配置路由的默认优先级 (0)，人工规则始终优先
 */
async function ensureRouteForModel(provider, model) {
  const existing = await ModelRoute.matchModelIncludingInactive(model);
  if (existing) return false;
  await pool.query(
    'INSERT INTO model_routes (model_pattern, provider_id, priority, is_active) VALUES (?, ?, 5, 1)',
    [model, provider.id]
  );
  logger.info('已自动注册上游模型路由', { providerId: provider.id, providerName: provider.name, model });
  return true;
}

/**
 * 对单把密钥执行: 发现模型 + 逐模型探测 + upsert 记录 + 失效告警
 */
async function checkKey(provider, providerKeyRow) {
  let apiKey;
  try {
    apiKey = await ProviderKey.getDecryptedKey(providerKeyRow.id);
  } catch (err) {
    logger.error('密钥解密失败', { keyId: providerKeyRow.id, error: err.message });
    return { discovered: 0, checked: 0, failed: 0 };
  }

  // 1. 模型发现
  const discovery = await discoverModels(provider, apiKey);

  if (!discovery.ok) {
    // 拉取模型清单失败: 判定整把密钥状态
    const status = discovery.authError ? 'auth_failed' : 'unreachable';
    const existing = await getKeyModels(providerKeyRow.id);
    if (existing.length > 0) {
      // 已有已知模型: 对全部标为对应状态
      for (const m of existing) {
        await upsertAvailability(provider, providerKeyRow, m.model, {
          status, latencyMs: null, error: discovery.error,
        });
      }
    } else {
      // 无已知模型: 记录一条密钥级状态 (model 用 '__key__' 占位)
      await upsertAvailability(provider, providerKeyRow, '__key__', {
        status, latencyMs: null, error: discovery.error,
      });
    }
    await maybeAlert(provider, providerKeyRow, status, discovery.error);
    return { discovered: 0, checked: existing.length || 1, failed: existing.length || 1 };
  }

  // 2. 逐模型探测
  let checked = 0;
  let failed = 0;
  for (const model of discovery.models) {
    const result = await testModel(provider, apiKey, model);
    await upsertAvailability(provider, providerKeyRow, model, result);
    checked++;
    if (result.status !== 'available') {
      failed++;
      await maybeAlert(provider, providerKeyRow, result.status, result.error);
    } else {
      // 探测可用 → 自动注册为有效路由 (幂等，已有匹配路由则跳过)
      try {
        await ensureRouteForModel(provider, model);
      } catch (err) {
        logger.error('自动注册模型路由失败', { providerId: provider.id, model, error: err.message });
      }
    }
    // 模型间间隔，避免上游限流
    await new Promise(r => setTimeout(r, PROBE_DELAY_MS));
  }

  logger.info('密钥可用性检测完成', {
    keyId: providerKeyRow.id, models: discovery.models.length, checked, failed,
  });

  return { discovered: discovery.models.length, checked, failed };
}

async function getKeyModels(providerKeyId) {
  const [rows] = await pool.query(
    'SELECT DISTINCT model FROM model_availability WHERE provider_key_id = ? AND model != \'__key__\'',
    [providerKeyId]
  );
  return rows;
}

async function upsertAvailability(provider, providerKeyRow, model, { status, latencyMs, error }) {
  await pool.query(
    `INSERT INTO model_availability (provider_id, provider_key_id, model, status, latency_ms, error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), latency_ms = VALUES(latency_ms),
       error = VALUES(error), checked_at = NOW()`,
    [provider.id, providerKeyRow.id, model, status, latencyMs, error || null]
  );
}

async function maybeAlert(provider, providerKeyRow, status, reason) {
  if (status === 'available' || status === 'unknown') return;
  const ok = await shouldSendAlert(providerKeyRow.id, status);
  if (!ok) return;

  const masked = providerKeyRow.key_name || `Key #${providerKeyRow.id}`;
  try {
    await sendProviderKeyAlert({
      providerName: provider.name,
      keyName: providerKeyRow.key_name || null,
      keyMasked: masked,
      status,
      reason: reason || '未知原因',
      checkedAt: new Date().toISOString(),
    });
    logger.info('上游密钥告警邮件已发送', { keyId: providerKeyRow.id, status });
  } catch (err) {
    logger.error('告警邮件发送失败', { keyId: providerKeyRow.id, error: err.message });
  }
}

/**
 * 轮询全部活跃服务商密钥 (互斥: 单轮耗时可能超过调度间隔，
 * 重叠运行会重复探测上游加剧限流、并触发告警去重的竞态导致重复告警)
 */
let isRunning = false;

async function runAllChecks() {
  if (isRunning) {
    logger.warn('上一轮可用性检测未完成，跳过本轮');
    return;
  }
  isRunning = true;
  logger.info('开始周期可用性检测');
  try {
    const providers = await Provider.listActive();
    for (const p of providers) {
      const keys = await ProviderKey.listByProvider(p.id);
      const activeKeys = keys.filter(k => k.is_active);
      for (const k of activeKeys) {
        await checkKey(p, k);
      }
    }
  } catch (err) {
    logger.error('可用性检测循环异常', { error: err.message });
  } finally {
    isRunning = false;
  }
}

let timer = null;

function startScheduler() {
  if (timer) return;
  // 启动 30 秒后跑第一轮，之后按间隔循环
  setTimeout(() => {
    runAllChecks().catch(() => {});
  }, 30 * 1000).unref();

  timer = setInterval(() => {
    runAllChecks().catch(() => {});
  }, DEFAULT_INTERVAL_MIN * 60 * 1000);
  timer.unref();
  logger.info(`上游可用性检测调度已启动 (每 ${DEFAULT_INTERVAL_MIN} 分钟)`);
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  checkKey,
  runAllChecks,
  startScheduler,
  stopScheduler,
  discoverModels,
  testModel,
  ensureRouteForModel,
  DEFAULT_INTERVAL_MIN,
};
