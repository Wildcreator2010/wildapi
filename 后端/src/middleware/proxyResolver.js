const User = require('../models/User');
const { AuthError } = require('../utils/errors');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { redis } = require('../config/database');

/**
 * API Key → 用户映射缓存 (避免每次请求全表解密 O(N))
 * key = sha256(providedKey) 前 32 位 (不存明文密钥)
 */
const keyCache = new Map(); // sha256prefix -> { user, expires }
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const CACHE_MAX = 1000;

function cacheGet(hash) {
  const entry = keyCache.get(hash);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    keyCache.delete(hash);
    return null;
  }
  return entry.user;
}

function cacheSet(hash, user) {
  if (keyCache.size >= CACHE_MAX) {
    // 简单淘汰: 删除第一个过期项或最旧项
    const first = keyCache.keys().next().value;
    if (first !== undefined) keyCache.delete(first);
  }
  keyCache.set(hash, { user, expires: Date.now() + CACHE_TTL });
}

/**
 * 缓存命中后的授权复查: 缓存只降低查库成本，不能替代授权检查。
 * 密钥吊销/用户禁用/余额变化必须回查数据库；异常时拒绝 (fail-closed)，
 * 避免已吊销密钥在缓存窗口内继续生效。
 */
async function revalidateCachedUser(cached) {
  const { pool } = require('../config/database');
  try {
    let rows = [];
    if (cached.usingProxyKey && cached.proxyKeyId) {
      [rows] = await pool.query(
        `SELECT u.id as uid, u.username, u.role, u.balance, u.rpm_limit
         FROM user_proxy_keys upk JOIN users u ON upk.user_id = u.id
         WHERE upk.id = ? AND upk.is_active = 1 AND u.is_active = 1`,
        [cached.proxyKeyId]
      );
    } else {
      return null;
    }
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      ...cached,
      id: row.uid,
      username: row.username,
      role: row.role,
      balance: parseFloat(row.balance),
      rpm_limit: row.rpm_limit,
    };
  } catch (err) {
    logger.warn('缓存复查失败，按拒绝处理', { error: err.message });
    return null;
  }
}

/**
 * 解析调用凭证并注入 req.user
 * 接受: 会话 JWT (Authorization: Bearer <token>) 或 系统代理分发密钥 (ak- 前缀，可走 x-api-key)
 */
async function proxyResolver(req, res, next) {
  try {
    // 认证头: Bearer <key> 或 x-api-key: <key> (Anthropic 标准)
    let providedKey = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.substring(7).trim();
    } else if (req.headers['x-api-key']) {
      providedKey = String(req.headers['x-api-key']).trim();
    }

    if (!providedKey) {
      throw new AuthError('请提供有效的 API 密钥 (Authorization: Bearer <key> 或 x-api-key)');
    }

    // 首先检查是否为 JWT (本地会话 token)
    try {
      const { verifyToken } = require('../utils/jwt');
      const payload = verifyToken(providedKey);
      const user = await User.findById(payload.userId);
      if (user && user.is_active) {
        req.user = { id: user.id, username: user.username, role: user.role, balance: parseFloat(user.balance), rpm_limit: user.rpm_limit };
        return next();
      }
    } catch {
      // 不是 JWT，继续尝试匹配代理密钥
    }

    // 缓存 key 提前声明 (供 ak- 分支与缓存查找共用，避免 TDZ)
    const hash = crypto.createHash('sha256').update(providedKey).digest('hex').substring(0, 32);

    // 系统代理分发密钥 (ak- 前缀，sha256 匹配，正常计费)
    if (providedKey.startsWith('ak-')) {
      try {
        const UserProxyKey = require('../models/UserProxyKey');
        const keyHash = UserProxyKey.hash(providedKey);
        const proxyKey = await UserProxyKey.findByHash(keyHash);
        if (proxyKey) {
          const userInfo = {
            id: proxyKey.user_id,
            username: proxyKey.username,
            role: proxyKey.role,
            balance: parseFloat(proxyKey.balance),
            rpm_limit: proxyKey.rpm_limit,
            usingProxyKey: true,
            proxyKeyId: proxyKey.id,
          };
          cacheSet(hash, userInfo);
          UserProxyKey.touchLastUsed(proxyKey.id).catch(() => {});
          req.user = userInfo;
          return next();
        }
      } catch (err) {
        // 记录详细异常，降级到后续分支而非笼统的"验证失败"
        logger.error('ak- 代理密钥校验异常', { error: err.message, stack: err.stack });
      }
    }

    // 缓存查找 (sha256 前缀，不存明文密钥)
    const cachedUser = cacheGet(hash);
    if (cachedUser) {
      // 命中后必须复查授权状态 (吊销/禁用/余额)，失效则清除缓存并拒绝，防止吊销绕过
      const freshUser = await revalidateCachedUser(cachedUser);
      if (freshUser) {
        redis.incr('stats:cache:hit').catch(() => {});
        req.user = freshUser;
        return next();
      }
      keyCache.delete(hash);
      throw new AuthError('无效的 API 密钥');
    }
    // 缓存未命中统计
    redis.incr('stats:cache:miss').catch(() => {});

    // 到这里只剩两类凭证: 会话 JWT (上面已处理) 与 ak- 代理分发密钥。
    // 曾经的第三条 user_api_keys (用户自带密钥) 已删除: 没有任何接口能写入它，
    // 但认证认它并强制 cost=0，转发用的仍是平台密钥 —— 等于用白拿的平台额度跑量。
    // 表与迁移保留 (历史数据不销毁)，需要 BYOK 时按"直连用户自己的上游"重新设计。
    throw new AuthError('无效的 API 密钥');
  } catch (err) {
    if (err.isOperational) return next(err);
    logger.error('proxyResolver 错误', { error: err.message });
    next(new AuthError('API 密钥验证失败'));
  }
}

module.exports = { proxyResolver };
