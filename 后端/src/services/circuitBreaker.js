const { redis } = require('../config/database');
const Provider = require('../models/Provider');
const { forwardRequest } = require('./proxyService');
const logger = require('../utils/logger');

/**
 * 供应方熔断与热切换服务
 * - 定时健康探测每个服务商
 * - 连续失败触发熔断 (Redis 标记 + TTL)
 * - 熔断期内拒绝该服务商，路由层切换备用服务商
 * - 切换事件写入日志
 */

const CIRCUIT_KEY = (providerId) => `circuit:provider:${providerId}`;
const FAIL_COUNT_KEY = (providerId) => `circuit:fail:${providerId}`;
const CIRCUIT_TTL = 60; // 熔断 60 秒
const FAIL_THRESHOLD = 5; // 连续 5 次失败触发熔断 (统计窗口与熔断期解耦，取较短窗口避免陈旧计数叠加)
const FAIL_COUNT_TTL = 120;
const PROBE_INTERVAL = 60 * 1000; // 健康探测每 60 秒

/**
 * 记录一次服务商失败，达到阈值熔断
 * Redis 操作失败一律内部吞掉: 熔断计数是观测手段，
 * 不能让"记账失败"冒充"上游失败"触发重试与熔断 (旧实现会把已成功的请求打成 502)
 */
async function markProviderFailure(providerId, reason) {
  try {
    const fails = await redis.incr(FAIL_COUNT_KEY(providerId));
    await redis.expire(FAIL_COUNT_KEY(providerId), FAIL_COUNT_TTL);
    if (fails >= FAIL_THRESHOLD) {
      await redis.set(CIRCUIT_KEY(providerId), `fail:${reason || 'unknown'}`, 'EX', CIRCUIT_TTL);
      await redis.del(FAIL_COUNT_KEY(providerId));
      logger.warn('服务商熔断开启', { providerId, reason, ttl: CIRCUIT_TTL });
      return true;
    }
  } catch (err) {
    logger.warn('熔断计数写入失败 (Redis 不可用)', { providerId, error: err.message });
  }
  return false;
}

/**
 * 记录成功: 清除失败计数 + 主动关闭熔断标记。
 * 成功请求 (真实流量 2xx 或探测可达) 即证明服务商可用，
 * 不必等满熔断 TTL 才恢复 (旧实现恢复感知滞后最多 60 秒)。
 */
async function markProviderSuccess(providerId) {
  try {
    await redis.del(FAIL_COUNT_KEY(providerId));
    if (await redis.exists(CIRCUIT_KEY(providerId))) {
      await redis.del(CIRCUIT_KEY(providerId));
      logger.info('服务商恢复，熔断提前关闭', { providerId });
    }
  } catch (err) {
    logger.warn('熔断状态更新失败 (Redis 不可用)', { providerId, error: err.message });
  }
}

/**
 * 服务商是否处于熔断状态 (Redis 不可用时视为未熔断，放行)
 */
async function isCircuitOpen(providerId) {
  try {
    const state = await redis.get(CIRCUIT_KEY(providerId));
    return !!state;
  } catch (err) {
    logger.warn('熔断状态读取失败 (Redis 不可用)', { providerId, error: err.message });
    return false;
  }
}

/**
 * 定时健康探测 (对 /v1/models 发 GET 空请求探测连通性)
 */
async function probeProvider(provider) {
  try {
    const result = await forwardRequest(
      provider.base_url, '/v1/models', 'probe-invalid-key', {},
      { 'user-agent': 'WildAPI-HealthCheck/1.0' },
      { method: 'GET' }
    );
    // 401/403/404 也算可达 (服务在但密钥/路径不认)；>=500 或网络错误才计失败
    if ([401, 403, 404, 200].includes(result.statusCode)) {
      await markProviderSuccess(provider.id);
      return;
    }
    if (result.statusCode >= 500 || result.isNetworkError || result.isTimeout) {
      await markProviderFailure(provider.id, `probe_${result.statusCode}`);
    }
  } catch {
    await markProviderFailure(provider.id, 'probe_error');
  }
}

let probeTimer = null;

function startHealthProbe() {
  if (probeTimer) return;
  probeTimer = setInterval(async () => {
    try {
      const providers = await Provider.listActive();
      for (const p of providers) {
        await probeProvider(p);
      }
    } catch (err) {
      logger.warn('健康探测循环异常', { error: err.message });
    }
  }, PROBE_INTERVAL);
  probeTimer.unref();
  logger.info('服务商健康探测已启动 (每 60 秒)');
}

function stopHealthProbe() {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
}

module.exports = {
  markProviderFailure,
  markProviderSuccess,
  isCircuitOpen,
  startHealthProbe,
  stopHealthProbe,
};
