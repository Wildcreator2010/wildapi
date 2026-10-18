const { redis } = require('../config/database');
const RateLimitConfig = require('../models/RateLimitConfig');
const { config } = require('../config');
const { RateLimitError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Redis 滑动窗口速率限制器
 */

// 系统默认用户 RPM (用户未单独设置时使用)
const DEFAULT_USER_RPM = 120;

/**
 * 全局限流 (按 IP)
 */
async function globalRateLimit(ip) {
  const key = `ratelimit:global:${ip}`;
  return checkWindowLimit(key, config.globalRateLimit, 60, '全局');
}

/**
 * 服务商级限流
 */
async function providerRateLimit(providerId) {
  const limitConfig = await RateLimitConfig.findByProviderId(providerId);
  const rpm = limitConfig?.requests_per_minute || 60;
  const key = `ratelimit:provider:${providerId}`;
  return checkWindowLimit(key, rpm, 60, `服务商(${providerId})`);
}

/**
 * 用户级限流 (RPM: 每分钟请求数)
 * @param {number} userId - 用户 ID
 * @param {Object|null} user - 用户对象 (可选，携带自定义 rpm_limit；未设置时使用系统默认)
 * 与并发上限 (concurrent_limit) 独立: 本限制控制每分钟发起请求数，不控制同时进行中请求数
 */
async function userRateLimit(userId, user = null) {
  const customRpm = user && Number.isInteger(user.rpm_limit) && user.rpm_limit > 0
    ? user.rpm_limit
    : null;
  const limit = customRpm || DEFAULT_USER_RPM;
  const key = `ratelimit:user:${userId}`;
  return checkWindowLimit(key, limit, 60, `用户(${userId})`);
}

/**
 * 滑动窗口限流核心实现 (Redis Sorted Set + Lua 原子脚本)
 * 清理/计数/判断/写入在单次往返内完成，并发突发无法突破限额；
 * 返回窗口内当前计数 (已限流) 或 -1 (放行并已记录)
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttlSec = tonumber(ARGV[4])
local member = ARGV[5]
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
if count >= limit then
  return count
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, ttlSec)
return -1
`;

async function checkWindowLimit(key, maxRequests, windowSeconds, label) {
  const now = Date.now();
  let result;
  try {
    result = await redis.eval(
      SLIDING_WINDOW_LUA, 1, key,
      now, windowSeconds * 1000, maxRequests, windowSeconds + 10,
      `${now}-${Math.random()}`
    );
  } catch (err) {
    // Redis 不可用时放行 (fail-open): 服务本身支持降级运行，
    // 限流器不应把所有 /v1 请求打成 500。真实的用户级 RPM/并发仍有兜底 (auth.js 同口径)。
    logger.warn('限流器 Redis 不可用，本次放行', { label, error: err.message });
    return true;
  }

  if (result >= 0) {
    logger.warn('速率限制触发', { label, key, count: result, maxRequests });
    throw new RateLimitError(`请求过于频繁 (${label}: ${result}/${maxRequests})，请稍后重试`);
  }

  return true;
}

module.exports = { globalRateLimit, providerRateLimit, userRateLimit, DEFAULT_USER_RPM };
