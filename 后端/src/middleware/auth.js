const { verifyToken } = require('../utils/jwt');
const { AuthError, ForbiddenError } = require('../utils/errors');
const User = require('../models/User');

/**
 * 验证 JWT 并将用户信息注入 req.user
 * 从 Authorization: Bearer <token> 头中提取 token
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthError('请先登录');
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);

    // 验证用户是否仍然存在且活跃
    const user = await User.findById(payload.userId);
    if (!user) throw new AuthError('用户不存在');
    if (!user.is_active) throw new AuthError('账户已被禁用');

    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      balance: parseFloat(user.balance),
      wildaccountId: user.wildaccount_id,
      concurrentLimit: user.concurrent_limit || 3,
    };

    next();
  } catch (err) {
    if (err.isOperational) return next(err);
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return next(new AuthError('登录已过期，请重新登录'));
    }
    next(err);
  }
}

/**
 * 要求管理员角色 (admin 或 superadmin)
 * 必须在 requireAuth 之后使用
 */
function requireAdmin(req, res, next) {
  if (!req.user || !['admin', 'superadmin'].includes(req.user.role)) {
    return next(new ForbiddenError('仅管理员可访问此资源'));
  }
  next();
}

/**
 * 可选认证 (不强制，但如果提供了有效 token 就注入 user)
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);
    const user = await User.findById(payload.userId);

    if (user && user.is_active) {
      req.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        balance: parseFloat(user.balance),
      };
    }
  } catch {
    // 忽略无效 token
  }
  next();
}

module.exports = { requireAuth, requireAdmin, optionalAuth };
