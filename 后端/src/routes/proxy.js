const express = require('express');
const router = express.Router();
const { StringDecoder } = require('string_decoder');
const { proxyResolver } = require('../middleware/proxyResolver');
const { globalRateLimit, providerRateLimit, userRateLimit } = require('../middleware/rateLimiter');
const { resolveRoute } = require('../services/routerService');
const keyRotator = require('../services/keyRotator');
const { forwardRequest } = require('../services/proxyService');
const { checkBalance, calculateCost, settleTransaction, getPricing } = require('../services/billingService');
const { estimateInputTokens, estimateTokens } = require('../services/tokenEstimator');
const circuitBreaker = require('../services/circuitBreaker');
const protocolMapper = require('../services/protocolMapper');
const RateLimitConfig = require('../models/RateLimitConfig');
const Provider = require('../models/Provider');
const ModelRoute = require('../models/ModelRoute');
const User = require('../models/User');
const ModelAvailability = require('../models/ModelAvailability');
const { redis } = require('../config/database');
const logger = require('../utils/logger');
const { UpstreamError, RateLimitError } = require('../utils/errors');

const DEFAULT_USER_CONCURRENCY = 3;

// 用户级并发槽: 占用/释放用 Lua 原子脚本 (同 keyRotator)，
// 释放仅在 key 存在时执行，避免过期后释放打出负数永久残留导致并发超限。
const USER_SLOT_ACQUIRE_LUA = `
local v = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return v
`;
const USER_SLOT_RELEASE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  local v = redis.call('DECR', KEYS[1])
  if v <= 0 then redis.call('DEL', KEYS[1]) end
  return v
end
return 0
`;
const USER_SLOT_TTL = 300;

/**
 * 用户级 + 代理 Key 级并发控制 (Redis 原子 INCR/DECR)
 * @returns {{ release: Function }} 释放函数
 */
async function acquireConcurrency(userId, limit, keyId = null) {
  const noop = { release: async () => {} };
  const userKey = `concurrency:user:${userId}`;
  let userCount;
  try {
    userCount = await redis.eval(USER_SLOT_ACQUIRE_LUA, 1, userKey, USER_SLOT_TTL);
  } catch (err) {
    // Redis 不可用时放行 (与限流器同口径): 并发计数属基础设施，故障不应把全部请求打成 500
    logger.warn('并发计数不可用，本次放行', { userId, error: err.message });
    return noop;
  }

  if (userCount > limit) {
    await redis.eval(USER_SLOT_RELEASE_LUA, 1, userKey).catch(() => {});
    throw new RateLimitError(`并发请求数已达上限 (${limit})，请稍后重试`);
  }

  let proxyKey = null;
  if (keyId) {
    proxyKey = `concurrency:proxykey:${keyId}`;
    let kc;
    try {
      kc = await redis.eval(USER_SLOT_ACQUIRE_LUA, 1, proxyKey, USER_SLOT_TTL);
    } catch (err) {
      logger.warn('密钥并发计数不可用，跳过该层限制', { keyId, error: err.message });
    }
    if (kc !== undefined && kc > limit) {
      await redis.eval(USER_SLOT_RELEASE_LUA, 1, proxyKey).catch(() => {});
      await redis.eval(USER_SLOT_RELEASE_LUA, 1, userKey).catch(() => {});
      throw new RateLimitError(`该密钥并发请求数已达上限 (${limit})，请稍后重试`);
    }
    if (kc === undefined) proxyKey = null; // 未占到槽，无需释放
  }

  let released = false;
  return {
    // 幂等释放: 成功/异常/客户端断开多路径可能重复调用，只执行一次安全 DECR (key 过期时不产生负数)
    release: async () => {
      if (released) return;
      released = true;
      await redis.eval(USER_SLOT_RELEASE_LUA, 1, userKey).catch(() => {});
      if (proxyKey) await redis.eval(USER_SLOT_RELEASE_LUA, 1, proxyKey).catch(() => {});
    },
  };
}

/**
 * 检查模型是否被下架 (匹配所有路由，含 is_active=0)
 */
async function isModelOffShelf(model) {
  const route = await ModelRoute.matchModelIncludingInactive(model);
  return route && !route.is_active;
}

/**
 * 获取用户并发上限 (个人设置 > 默认)
 */
async function getUserConcurrencyLimit(userId) {
  try {
    const user = await User.findById(userId);
    return user?.concurrent_limit || DEFAULT_USER_CONCURRENCY;
  } catch {
    return DEFAULT_USER_CONCURRENCY;
  }
}

/**
 * GET /v1/models - 模型列表 (优先上游检测可用模型，回退本地已上架)
 * 数据源 1: model_availability (availabilityService 从上游 /v1/models 同步 + 探测)
 * 数据源 2: model_routes 本地已上架 (上游暂无检测结果时兜底，保证接口不失败)
 */
router.get('/v1/models', proxyResolver, async (req, res, next) => {
  try {
    const nowSec = Math.floor(Date.now() / 1000);

    // 1. 优先: 上游检测可用模型 (已去重/排序/容错)
    const upstream = await ModelAvailability.listAvailableSafe();
    if (upstream.length > 0) {
      const models = upstream.map((m, i) => ({
        id: m.model,
        object: 'model',
        created: nowSec - i,
        owned_by: m.providerName,
      }));
      return res.json({ object: 'list', data: models });
    }

    // 2. 回退: 本地已上架路由 (兼容上游尚未完成首轮检测的场景)
    const routes = await ModelRoute.list();
    const models = routes.filter(r => r.is_active).map((r, i) => ({
      id: r.model_pattern.replace('*', ''),
      object: 'model',
      created: nowSec - i,
      owned_by: r.provider_name || 'wildapi',
    }));

    // 去重
    const seen = new Set();
    const unique = models.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    res.json({ object: 'list', data: unique });
  } catch (err) { next(err); }
});

/**
 * 核心代理处理函数
 * @param {Object} protocol - { type: 'openai'|'anthropic' }
 */
async function handleProxy(req, res, next, protocol = { type: 'openai' }) {
  const startTime = Date.now();
  let keyId = null;
  let providerId = null;
  let concurrency = null;
  let providerType = 'openai';
  // 客户端断开时中止上游流 (在并发释放处挂接)
  const abort = new AbortController();
  // 流式写出时客户端可能已断开: res 无 'error' 监听会作为未捕获异常打挂进程
  res.once('error', (err) => logger.warn('响应写出异常', { error: err.message, path: req.path }));

  try {
    const originalPath = req.path;
    let body = req.body || {};

    // ---- Anthropic / Responses 协议映射到 OpenAI 上游 ----
    if (protocol.type === 'anthropic') {
      body = protocolMapper.anthropicToOpenAI(body);
      body.model = req.body?.model; // 模型名保持原样 (用于路由)
    } else if (protocol.type === 'responses') {
      // OpenAI Responses API (DeepSeek Harness/Codex 等工具) → Chat Completions
      body = protocolMapper.responsesToOpenAI(body);
      body.model = req.body?.model;
    }

    const model = body.model || req.body?.model || 'unknown';
    const isStream = !!body.stream;
    const userId = req.user?.id || null;

    // 1. 全局限流
    const clientIp = req.ip || req.connection.remoteAddress;
    await globalRateLimit(clientIp);

    // 2. 模型下架检查 (上架/下架开关)
    if (await isModelOffShelf(model)) {
      return res.status(404).json({
        error: { message: `模型 ${model} 不存在或已下架`, type: 'MODEL_NOT_FOUND', code: 404 },
      });
    }

    // 3. 用户级限流 (RPM: 用户自定义 rpm_limit 优先，未设置用系统默认)
    if (req.user) await userRateLimit(req.user.id, req.user);

    // 4. 并发控制 (用户级 + 代理 Key 级)
    if (userId) {
      const limit = await getUserConcurrencyLimit(userId);
      concurrency = await acquireConcurrency(userId, limit, req.user.proxyKeyId || null);
      // 保证并发槽在所有退出路径释放 (成功/失败/客户端断开)，
      // 避免计数泄漏导致用户被误限流 (计数仅 120 秒自然过期)。
      // finish=响应正常完成 (keep-alive 下 close 不会逐请求触发)，close=异常断开，幂等释放双保险。
      const safeRelease = () => { concurrency.release().catch(() => {}); };
      res.once('finish', safeRelease);
      res.once('close', () => {
        // 未正常写完就关闭 = 客户端断开: 中止上游流，否则上游继续输出并继续计费
        if (!res.writableEnded) abort.abort();
        safeRelease();
      });
    }

    // 5. 模型路由 (含熔断检查 + 备用服务商切换)
    let route = await resolveRoute(model);
    // 路由命中率统计
    redis.incr('stats:route:total').catch(() => {});
    if (!route) {
      return res.status(502).json({
        error: { message: '没有可用的上游服务商', type: 'no_provider', code: 502 },
      });
    }
    redis.incr('stats:route:hit').catch(() => {});

    // 熔断检查: 首选服务商熔断时切换到备用 (备用必须能服务当前模型，否则不切换)
    if (await circuitBreaker.isCircuitOpen(route.providerId)) {
      logger.warn('首选服务商熔断中，尝试备用路由', { model, providerId: route.providerId });
      const allRoutes = (await ModelRoute.list()).filter(r => r.is_active);
      const candidates = allRoutes.filter(r =>
        r.provider_id !== route.providerId && ModelRoute.matchesPattern(r.model_pattern, model)
      );
      for (const candidate of candidates) {
        if (!(await circuitBreaker.isCircuitOpen(candidate.provider_id))) {
          route = { providerId: candidate.provider_id, providerName: candidate.provider_name, providerType: candidate.provider_type };
          logger.info('已切换到备用服务商', { model, backupProviderId: candidate.provider_id });
          break;
        }
      }
    }

    providerId = route.providerId;
    providerType = route.providerType || 'openai';

    // 6. 服务商级限流
    await providerRateLimit(providerId);

    // 7. 余额检查 (代理密钥/JWT 用户正常计费; 管理员与普通用户同等对待，不豁免)
    // 按本次请求的潜在最大成本预估 (输入实测 + max_tokens 上限)，堵住低余额大额请求的防逃费缺口;
    // 预估失败时回退保守下限，不阻断请求。
    if (req.user) {
      let estimatedMaxCost = 0.001;
      try {
        const estTokensIn = await estimateInputTokens(body);
        const maxOut = Number.isFinite(body?.max_tokens) && body.max_tokens > 0 ? body.max_tokens : 4096;
        estimatedMaxCost = Math.max(estimatedMaxCost, await calculateCost(model, estTokensIn, maxOut, providerType));
      } catch { /* 估算失败用默认下限 */ }
      await checkBalance(req.user.id, estimatedMaxCost);
    }

    // 8. 重试配置 + 提供商信息
    const rateConfig = await RateLimitConfig.findByProviderId(providerId);
    // 0 是合法配置，不能用 || 兜底 (旧写法把 0 当成"没配"直接变回默认值)。
    // retry_attempts=0 仍必须发出 1 次请求: 0 次尝试却返回 502 并计费是最坏的解读。
    const rawAttempts = Number(rateConfig?.retry_attempts);
    const maxRetries = Number.isFinite(rawAttempts) ? Math.max(1, Math.floor(rawAttempts)) : 3;
    const rawDelay = Number(rateConfig?.retry_delay_ms);
    const retryDelayMs = Number.isFinite(rawDelay) && rawDelay >= 0 ? Math.floor(rawDelay) : 1000;
    const provider = await Provider.findById(providerId);
    const baseUrl = provider.base_url;

    // 9. 带重试的转发 (支持流式 + 协议映射)
    let lastResponse;
    let lastError;
    let usedKeyId = null;          // 实际服务本次请求的密钥 (keyId 在释放槽位后置空，日志需要保留)
    let upstreamAttempted = false; // 是否真的向上游发出过请求 (未发出不应计费)
    const upstreamPath = (protocol.type === 'anthropic' || protocol.type === 'responses') ? '/v1/chat/completions' : originalPath;

    // Anthropic / Responses 流式转换器状态 (逐行缓冲)
    // 用 StringDecoder 累计解码，避免多字节字符 (中文/emoji) 跨分片被截断成乱码
    let streamTransformer = null;
    const lineDecoder = new StringDecoder('utf8');
    let lineBuffer = '';

    const writeSseHeaders = (status) => {
      if (!res.headersSent) {
        res.status(status);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (protocol.type === 'anthropic') res.setHeader('anthropic-version', req.headers['anthropic-version'] || '2023-06-01');
      }
    };

    // 背压: 客户端消费慢时由 forwardRequest 暂停上游流，drain 后恢复
    const writeThrough = (data) => {
      if (res.writableEnded || res.destroyed) {
        abort.abort();
        return undefined;
      }
      return res.write(data) ? undefined : new Promise((resolve) => res.once('drain', resolve));
    };

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const key = await keyRotator.acquireKey(providerId);
        keyId = key.keyId;
        usedKeyId = key.keyId;
        upstreamAttempted = true;

        // 流式: 透传分片 (Anthropic 需协议转换)
        lastResponse = await forwardRequest(baseUrl, originalPath, key.apiKey, body, {
          'content-type': req.headers['content-type'],
          accept: req.headers['accept'],
          'user-agent': req.headers['user-agent'],
        }, {
          isStream,
          upstreamPath,
          method: req.method,
          query: protocol.type === 'openai' ? req.query : null,
          signal: abort.signal,
          // 上游状态码在写出任何分片前即可知: 非 2xx 时收集错误体，交给下面的重试/回退，
          // 不把 4xx/5xx 伪装成 200 SSE 发给客户端 (旧实现在首个分片才补头，状态码已锁死 200)
          onStreamOpen: isStream ? (status) => {
            if (status >= 400) return false;
            writeSseHeaders(status);
            return true;
          } : null,
          onChunk: isStream ? (chunk) => {
            if (protocol.type === 'anthropic' || protocol.type === 'responses') {
              if (!streamTransformer) {
                streamTransformer = protocol.type === 'anthropic'
                  ? protocolMapper.createAnthropicStreamTransformer(model, body)
                  : protocolMapper.createResponsesStreamTransformer(model);
              }
              lineBuffer += lineDecoder.write(chunk);
              let idx;
              while ((idx = lineBuffer.indexOf('\n')) >= 0) {
                const line = lineBuffer.substring(0, idx).trim();
                lineBuffer = lineBuffer.substring(idx + 1);
                if (!line) continue;
                const out = streamTransformer(line);
                if (out) writeThrough(out);
              }
              return undefined;
            }
            // OpenAI 格式原样透传
            return writeThrough(chunk);
          } : null,
        });

        // 客户端已断开: 上游流已被中止，不再重试，按已收到的结果记账
        if (lastResponse.isClientAborted) {
          logger.info('客户端断开，上游流已中止', { model, providerId });
          break;
        }

        // 上游失败分级:
        //  401/403 → 密钥级故障 (换下一把密钥重试，不计服务商熔断，服务商本身是通的)
        //  5xx/429 → 服务商级故障 (冷却 + 熔断计数 + 重试)
        //  其他 4xx → 视为上游对本报文的最终答复，直接回传客户端 (模型不存在/参数错误重试无意义)
        // forwardRequest 对 HTTP 错误不抛异常，若不在此处理，坏服务商永不会被真实流量熔断、重试也形同虚设。
        const status = lastResponse.statusCode;
        const keyFailure = status === 401 || status === 403;
        const retryableFailure = status >= 500 || status === 429 || keyFailure;
        if (retryableFailure) {
          await keyRotator.markFailure(keyId, keyFailure ? 300 : 60);
          await keyRotator.releaseKey(keyId);
          keyId = null;
          if (!keyFailure) await circuitBreaker.markProviderFailure(providerId, `upstream_${status}`);
          lastError = new Error(`上游返回 ${status}`);
          // 已开始向客户端流式输出后无法重试，只能标记失败并返回当前响应
          if (!res.headersSent && attempt < maxRetries - 1) {
            logger.warn('上游错误状态码，重试中', { attempt: attempt + 1, model, statusCode: status });
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs * Math.pow(2, attempt)));
            continue;
          }
          break;
        }

        await keyRotator.markSuccess(keyId);
        await keyRotator.releaseKey(keyId);
        keyId = null;
        await circuitBreaker.markProviderSuccess(providerId);
        break;
      } catch (err) {
        if (keyId) {
          await keyRotator.markFailure(keyId, 60);
          await keyRotator.releaseKey(keyId);
          keyId = null;
        }
        await circuitBreaker.markProviderFailure(providerId, err.message);
        lastError = err;
        if (attempt < maxRetries - 1) {
          logger.warn('代理转发失败，重试中', { attempt: attempt + 1, model, error: err.message });
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * Math.pow(2, attempt)));
        }
      }
    }

    // 10. 防逃费计费: 无论成功/失败/流式中断，按实际消耗记账
    let tokensIn = 0;
    let tokensOut = 0;

    if (lastResponse?.stream) {
      // 流式: 优先取上游 SSE 回传的真实 usage (需 stream_options.include_usage)，缺失才回退文本估算
      const streamUsage = lastResponse.stream.usage || {};
      tokensIn = Number.isFinite(streamUsage.promptTokens)
        ? streamUsage.promptTokens : await estimateInputTokens(body);
      tokensOut = Number.isFinite(streamUsage.completionTokens)
        ? streamUsage.completionTokens : await estimateTokens(lastResponse.stream.text);
    } else if (lastResponse?.body?.usage) {
      const usage = lastResponse.body.usage;
      tokensIn = usage.prompt_tokens || usage.input_tokens || 0;
      tokensOut = usage.completion_tokens || usage.output_tokens || 0;
    } else if (lastResponse?.body?.content) {
      // Anthropic 上游原生响应
      tokensIn = lastResponse.body.usage?.input_tokens || await estimateInputTokens(body);
      tokensOut = lastResponse.body.usage?.output_tokens || 0;
    } else if (upstreamAttempted) {
      // 无 usage (含 5xx 错误响应) 或全部重试失败: 输入 token 计费 (请求已消耗上游资源)
      tokensIn = await estimateInputTokens(body);
      tokensOut = 0;
    }
    // 未向上游发出任何请求 (服务商无可用密钥 / 全部冷却 / 并发已满): 不计费，仅留日志

    const cost = await calculateCost(model, tokensIn, tokensOut, providerType);

    // 11. 事务结算: 扣费 + 流水 + 日志原子完成 (管理员与普通用户同等计费)
    const shouldBill = !!req.user;
    const statusCode = lastResponse?.statusCode || 502;
    let logId = null;

    try {
      const settleResult = await settleTransaction({
        userId: req.user?.id || null,
        cost: shouldBill ? cost : 0,
        requestLog: {
          providerId,
          providerKeyId: usedKeyId,
          model,
          requestBody: { model, messages: body?.messages?.length ? `[${body.messages.length} messages]` : body },
          responseBody: lastResponse
            ? (statusCode >= 400
                ? (lastResponse.body || { status: 'stream', stream_truncated: !!lastResponse.stream?.interrupted })
                : (lastResponse.stream
                    ? {
                        status: 'stream',
                        text_length: lastResponse.stream.text.length,
                        // 中断的流式响应必须与正常完成区分，否则审计日志无法定位半途断流
                        stream_truncated: !!lastResponse.stream.interrupted,
                      }
                    : { status: 'success', usage: lastResponse.body?.usage }))
            : null,
          latencyMs: lastResponse?.latencyMs || (Date.now() - startTime),
          statusCode,
          tokensIn,
          tokensOut,
          errorMessage: !lastResponse
            ? (lastError?.message || '所有重试均失败')
            : (statusCode >= 400 ? (lastResponse.body?.error?.message || 'Upstream error') : null),
        },
      });
      logId = settleResult.logId;
    } catch (settleErr) {
      logger.error('事务结算失败 (已回滚)', { userId: req.user?.id, cost, error: settleErr.message });
      // 结算失败也尽力异步补记日志，避免完全无记录
      const RequestLog = require('../models/RequestLog');
      RequestLog.create({
        userId: req.user?.id || null, providerId, model,
        requestBody: body, latencyMs: Date.now() - startTime,
        statusCode: 500, tokensIn, tokensOut, cost: 0,
        errorMessage: `settle_failed: ${settleErr.message}`,
      }).catch(() => {});
    }

    // 12. 返回响应
    if (!lastResponse) {
      throw new UpstreamError(lastError?.message || '所有重试均失败');
    }

    if (lastResponse.stream) {
      // 客户端已断开: 流已被中止，不能再写/结束响应 (否则 write-after-end 异常)
      if (res.destroyed || res.writableEnded) return;
      // 流式: 分片已透传，冲刷解码器尾部字节 + 剩余缓冲 (Responses 需确保发出终结事件)
      const tail = lineDecoder.end();
      if (tail) lineBuffer += tail;
      if ((protocol.type === 'anthropic' || protocol.type === 'responses') && streamTransformer && lineBuffer.trim()) {
        writeSseHeaders(statusCode);
        const out = streamTransformer(lineBuffer.trim());
        if (out) res.write(out);
      }
      // Responses 协议: 上游未发 [DONE] 时补发终结事件 (Harness 要求终结事件)
      if (protocol.type === 'responses' && streamTransformer) {
        writeSseHeaders(statusCode);
        const out = streamTransformer('data: [DONE]');
        if (out) res.write(out);
      }
      if (!res.headersSent) writeSseHeaders(statusCode);
      return res.end();
    }

    // 非流式响应 (协议映射)
    if (protocol.type === 'anthropic') {
      if (statusCode >= 400) {
        return res.status(statusCode).json({
          type: 'error',
          error: { type: lastResponse.body?.error?.type || 'api_error', message: lastResponse.body?.error?.message || 'Upstream error' },
        });
      }
      const anthropicRes = protocolMapper.openAIToAnthropic(body, lastResponse.body, model);
      return res.status(200).json(anthropicRes);
    }

    // Responses 协议非流式: Chat Completions 响应 → Responses 格式
    if (protocol.type === 'responses') {
      if (statusCode >= 400) {
        return res.status(statusCode).json(lastResponse.body || { error: { message: 'Upstream error', type: 'upstream_error' } });
      }
      return res.status(200).json(protocolMapper.openAIToResponses(lastResponse.body, model));
    }

    // OpenAI 格式原样返回 (保留 id/model/usage/choices)
    return res.status(statusCode).json(lastResponse.body);
  } catch (err) {
    // 释放并发
    if (concurrency) concurrency.release().catch(() => {});

    if (err.isOperational) return next(err);

    logger.error('代理处理异常', { error: err.message, model: req.body?.model });
    next(err);
  }
}

/**
 * POST /v1/responses - OpenAI Responses API (DeepSeek Harness / Codex 等新工具)
 * 转换为 Chat Completions 转发，响应还原为 Responses 格式，正常计费
 * 注: Express 4 不会自动捕获 async 异常，必须 .catch(next) 交给错误中间件
 */
router.post('/v1/responses', proxyResolver, (req, res, next) => {
  handleProxy(req, res, next, { type: 'responses' }).catch(next);
});

/**
 * POST /v1/messages - Anthropic Messages API (x-api-key 认证)
 */
router.post('/v1/messages', proxyResolver, async (req, res, next) => {
  // 校验 anthropic-version 头 (Anthropic SDK 要求)
  const anthropicVersion = req.headers['anthropic-version'];
  if (!anthropicVersion) {
    return res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: '缺少 anthropic-version 请求头' },
    });
  }
  res.setHeader('anthropic-version', anthropicVersion);
  handleProxy(req, res, next, { type: 'anthropic' }).catch(next);
});

/**
 * ALL /v1/* - OpenAI 兼容协议入口 (chat/completions/embeddings 等原样透传)
 */
router.all('/v1/*', proxyResolver, (req, res, next) => {
  handleProxy(req, res, next, { type: 'openai' }).catch(next);
});

module.exports = router;
module.exports.handleProxy = handleProxy;
