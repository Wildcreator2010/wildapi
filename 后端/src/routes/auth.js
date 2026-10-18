const express = require('express');
const router = express.Router();
const { ssoLogin } = require('../services/authService');
const { requireAuth } = require('../middleware/auth');
const { redis } = require('../config/database');
const User = require('../models/User');
const { AuthError, ValidationError, RateLimitError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * 进程内兜底滑动窗口 (Redis 不可用时仍保留对 sso_code 暴力枚举的基本防护，
 * 单实例生效；多实例下防护强度降级但优于完全放行)
 */
const fallbackHits = new Map(); // ip -> timestamps[]

function fallbackAllow(ip, limit) {
  const now = Date.now();
  const arr = (fallbackHits.get(ip) || []).filter(t => t > now - 60000);
  if (arr.length >= limit) {
    fallbackHits.set(ip, arr);
    return false;
  }
  arr.push(now);
  fallbackHits.set(ip, arr);
  // 简单淘汰防无界增长
  if (fallbackHits.size > 10000) {
    const oldest = fallbackHits.keys().next().value;
    fallbackHits.delete(oldest);
  }
  return true;
}

// Lua 原子滑动窗口: 清理/计数/判断/写入单次往返，并发无法突破限额 (与 rateLimiter 同一模式)
const AUTH_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZREMRANGEBYSCORE', key, 0, now - 60000)
local count = redis.call('ZCARD', key)
if count >= limit then
  return count
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, 70)
return -1
`;

/**
 * SSO 端点专用速率限制 (防暴力枚举 sso_code)
 * 每个 IP 每分钟最多 20 次 /api/sso/exchange 请求；
 * Redis 故障时降级为进程内兜底计数 (不再完全放行)
 */
async function authRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  try {
    const key = `ratelimit:auth:${ip}`;
    const result = await redis.eval(AUTH_WINDOW_LUA, 1, key, Date.now(), 20, `${Date.now()}-${Math.random()}`);
    if (result >= 0) {
      logger.warn('认证端点速率限制触发', { ip, count: result });
      return next(new RateLimitError('认证请求过于频繁，请稍后重试'));
    }
    return next();
  } catch (err) {
    if (err.isOperational) return next(err);
    logger.error('认证限流 Redis 检查失败，降级进程内兜底', { error: err.message });
    if (!fallbackAllow(ip, 20)) {
      return next(new RateLimitError('认证请求过于频繁，请稍后重试'));
    }
    next();
  }
}

/**
 * POST /api/sso/exchange
 * 用 WildAccount 回调返回的 sso_code 换取本地 JWT
 * 严格遵循 INTEGRATION.md 第 3 步
 */
router.post('/sso/exchange', authRateLimit, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) throw new ValidationError('缺少授权码 (sso_code)');

    const result = await ssoLogin(code);
    logger.info('SSO 登录成功', { userId: result.user.id, role: result.user.role });

    res.json({
      success: true,
      data: {
        token: result.token,
        user: result.user,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * 获取当前登录用户信息
 */
router.get('/auth/me', requireAuth, async (req, res) => {
  res.json({
    success: true,
    data: { user: req.user },
  });
});

/**
 * POST /api/auth/logout
 * 登出 (客户端清除 token 即可，服务端不保存状态)
 */
router.post('/auth/logout', (req, res) => {
  res.json({ success: true, message: '已登出' });
});

module.exports = router;
