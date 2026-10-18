const axios = require('axios');
const { config } = require('../config');
const User = require('../models/User');
const { signToken } = require('../utils/jwt');
const logger = require('../utils/logger');
const { AuthError } = require('../utils/errors');

/**
 * 用 sso_code 向 WildAccount 认证中心换取用户信息
 * 严格遵循 INTEGRATION.md 第 3 步
 */
async function exchangeCode(code) {
  try {
    const response = await axios.post(
      `${config.sso.authUrl}/api/token`,
      {
        code,
        client_id: config.sso.clientId,
        client_secret: config.sso.clientSecret,
      },
      {
        timeout: 10000,
        // 认证中心行为分析器要求浏览器特征头，否则判定为自动化脚本并封禁 IP
        headers: {
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'User-Agent': 'WildAPI-Backend/1.0',
          'Accept': 'application/json',
        },
      }
    );

    const { access_token, user } = response.data;

    if (!user || !user.id) {
      throw new AuthError('认证中心返回的用户信息无效');
    }

    return { accessToken: access_token, user };
  } catch (err) {
    if (err.isOperational) throw err;

    if (err.response) {
      const status = err.response.status;
      // 上游错误详情只记日志，不透传给客户端 (避免泄漏认证中心内部信息)
      logger.warn('SSO exchange 上游错误', { status, detail: err.response.data?.error });
      if (status === 401) throw new AuthError('应用凭据校验失败，请检查 client_id 和 client_secret');
      if (status === 400) throw new AuthError('授权码无效或已过期，请重新登录');
      if (status === 403) throw new AuthError('请求被认证中心安全风控拦截 (403)，请勿频繁重试，稍后 1-2 分钟再试');
      if (status === 429) throw new AuthError('认证中心限流 (429)，请稍后再试');
      throw new AuthError('认证失败，请稍后重试');
    }

    logger.error('SSO exchange 网络错误', { error: err.message });
    throw new AuthError('连接认证中心失败，请稍后重试');
  }
}

/**
 * 完整的 SSO 登录流程
 * 1. 用 code 换 token
 * 2. UPSERT 本地用户
 * 3. 签发本地 JWT
 */
async function ssoLogin(code) {
  const { user } = await exchangeCode(code);

  // UPSERT 本地用户记录 (不信任上游 role: 新用户统一默认 'user'，
  // 管理员角色仅由本地管理后台授予，堵住上游提权/撤权回滚通道)
  const localUser = await User.upsert({
    wildaccountId: user.id,
    username: user.username,
    email: user.email || null,
    role: 'user',
  });

  // 签发本地 JWT
  const token = signToken({
    userId: localUser.id,
    username: localUser.username,
    role: localUser.role,
  });

  return {
    token,
    user: {
      id: localUser.id,
      username: localUser.username,
      email: localUser.email,
      role: localUser.role,
      balance: parseFloat(localUser.balance),
      isActive: !!localUser.is_active,
    },
  };
}

module.exports = { exchangeCode, ssoLogin };
