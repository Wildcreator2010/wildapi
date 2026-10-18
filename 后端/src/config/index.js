require('dotenv').config();

/**
 * TRUST_PROXY 解析: 默认信任一跳代理 (反代部署形态)。
 * false/0 关闭 (直连暴露时用)，数字表示跳数，其他字符串按 Express trust proxy 值透传 (如 'loopback'、CIDR)。
 */
function parseTrustProxy(raw) {
  if (raw === undefined || raw === '') return 1;      // 默认: 信任一跳代理
  if (raw === 'false' || raw === '0') return false;   // 直连暴露时不信任任何 XFF
  if (raw === 'true') return true;                    // 信任所有代理 (可被 XFF 伪造，慎用)
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1) return n;        // 跳数
  return raw;                                         // 'loopback' / CIDR 列表，交给 Express 解析
}

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wildapi',
    poolSize: parseInt(process.env.DB_POOL_SIZE, 10) || 10,
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY,
  },
  sso: {
    clientId: process.env.SSO_CLIENT_ID || 'wildapi',
    clientSecret: process.env.SSO_CLIENT_SECRET || '',
    authUrl: process.env.SSO_AUTH_URL || 'https://login.wildcreator.top',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  adminEmail: process.env.ADMIN_EMAIL || '',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  globalRateLimit: parseInt(process.env.GLOBAL_RATE_LIMIT, 10) || 600,
  // 部署形态在 nginx/宝塔反代之后 (docker-compose、前端 nginx 均转发 X-Forwarded-For)。
  // 不信任时 req.ip 恒为代理容器地址，全局限流会退化成所有客户端共用一个桶。
  // TRUST_PROXY=false 关闭 (直连暴露后端时防 XFF 伪造)，也可填跳数或 'loopback'/CIDR。
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};

// 启动时关键配置校验
function validateConfig() {
  const errors = [];
  const isProd = process.env.NODE_ENV === 'production';
  // 内置开发密钥仅在 NODE_ENV 显式为 development/test 时容忍。
  // 漏配 NODE_ENV 的部署 (PM2/Docker) 一律拒绝启动，防止用源码中公开的密钥运行导致 JWT 伪造。
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

  const isPlaceholder = (val) => !val || val.startsWith('<REQUIRED') || val === 'dev-secret-change-in-production' || val.includes('change-me-') || val.includes('your_client_secret') || val.includes('your_password') || val.includes('your_smtp');

  // JWT_SECRET 强制校验 (不限环境)
  if (isPlaceholder(config.jwt.secret)) {
    if (!isDev) {
      console.error(`[CONFIG] 致命错误: JWT_SECRET 未配置或使用占位符 (NODE_ENV=${process.env.NODE_ENV || '未设置'})。必须设置安全的 JWT_SECRET 环境变量`);
      process.exit(1);
    }
    console.warn('[CONFIG] 警告: JWT_SECRET 未配置，使用内置开发密钥 (仅限 development/test 环境)');
  }

  // ENCRYPTION_KEY 强制校验 (不限环境)
  if (isPlaceholder(config.encryption.key)) {
    if (!isDev) {
      console.error(`[CONFIG] 致命错误: ENCRYPTION_KEY 未配置或使用占位符 (NODE_ENV=${process.env.NODE_ENV || '未设置'})。必须设置安全的 ENCRYPTION_KEY 环境变量`);
      process.exit(1);
    }
    console.warn('[CONFIG] 警告: ENCRYPTION_KEY 未配置 (仅限 development/test 环境)');
  }

  // ENCRYPTION_KEY 格式校验: 必须是 64 位十六进制 (AES-256-GCM 需要 32 字节密钥)。
  // 旧实现只在首次解密上游密钥时才报错，表现为"所有密钥均达到并发上限"这种误导性故障。
  if (config.encryption.key && !/^[0-9a-fA-F]{64}$/.test(config.encryption.key)) {
    errors.push('ENCRYPTION_KEY 格式非法');
    console.error('[CONFIG] 致命错误: ENCRYPTION_KEY 必须是 64 位十六进制字符串 (32 字节)，当前长度 '
      + String(config.encryption.key).length);
    process.exit(1);
  }

  // SSO Client Secret 检查
  if (isPlaceholder(config.sso.clientSecret)) {
    console.warn('[CONFIG] 警告: SSO_CLIENT_SECRET 未配置，SSO 登录将不可用');
  }

  // 生产环境 DB 密码检查
  if (isProd && (isPlaceholder(config.db.password) || config.db.password === '')) {
    console.warn('[CONFIG] 警告: DB_PASSWORD 未配置，生产环境建议设置数据库密码');
  }

  return errors;
}

module.exports = { config, validateConfig };
