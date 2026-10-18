const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { config, validateConfig } = require('./config');
const { testConnections, pool, redis } = require('./config/database');
const { errorHandler } = require('./middleware/errorHandler');
const logger = require('./utils/logger');

// 路由
const authRoutes = require('./routes/auth');
const proxyRoutes = require('./routes/proxy');
const adminProviderRoutes = require('./routes/admin/providers');
const adminUserRoutes = require('./routes/admin/users');
const adminLogRoutes = require('./routes/admin/logs');
const adminStatsRoutes = require('./routes/admin/stats');
const adminSettingsRoutes = require('./routes/admin/settings');
const adminBackupRoutes = require('./routes/admin/backup');
const adminPricingRoutes = require('./routes/admin/pricing');
const adminProviderTypeRoutes = require('./routes/admin/provider-types');
const adminAdminsRoutes = require('./routes/admin/admins');
const adminAvailabilityRoutes = require('./routes/admin/availability');
const userRoutes = require('./routes/user/dashboard');
const userKeyRoutes = require('./routes/user/keys');
const userModelRoutes = require('./routes/user/models');
const circuitBreaker = require('./services/circuitBreaker');
const availabilityService = require('./services/availabilityService');

const app = express();

// 版本号只在 package.json 里维护：健康接口与启动横幅都从这里取，
// 免得发版时改了两处漏一处（历史上是写死在代码里的 1.0.0）
const pkg = require('../package.json');

// ==================== 基础中间件 ====================

// 反代之后必须信任 X-Forwarded-For，否则 req.ip 恒为代理地址:
// 全局限流会退化成所有客户端共用一个桶，正常流量即可触发 429，IP 维度的爆破防护形同虚设。
app.set('trust proxy', config.trustProxy);

// 安全头 - 生产模式启用严格 CSP
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  } : false,
}));

// CORS
app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  // x-api-key / anthropic-version 是 /v1/messages 的必需头 (Anthropic SDK 口径)，
  // 不在白名单时浏览器预检直接拒绝，请求根本到不了代理入口
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version'],
  exposedHeaders: ['Content-Disposition'],
}));

// 请求体解析 - AI API 请求可能较大
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/v1/') || req.path.startsWith('/api/')) {
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// ==================== 健康检查 ====================

app.get('/api/health', async (req, res) => {
  // 两项都要探: 旧实现只查 Redis，MySQL 挂了/库未迁移时容器仍报 healthy，
  // 于是一路 500 的部署在 `docker compose ps` 里看着完全正常。
  const ping = async (fn) => {
    try {
      await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
      return true;
    } catch {
      return false;
    }
  };

  const mysqlOk = await ping(async () => {
    const conn = await pool.getConnection();
    try { await conn.ping(); } finally { conn.release(); }
  });
  const redisOk = await ping(() => redis.ping());

  const isProd = process.env.NODE_ENV === 'production';
  const status = mysqlOk && redisOk ? 'ok' : 'degraded';
  res.status(status === 'ok' ? 200 : 503).json({
    status,
    ...(isProd ? {} : {
      service: 'wildapi',
      version: pkg.version,
      mysql: mysqlOk ? 'connected' : 'unavailable',
      redis: redisOk ? 'connected' : 'unavailable',
    }),
  });
});

// ==================== API 路由 ====================

// 认证路由 (SSO)
app.use('/api', authRoutes);

// 管理路由 (需管理员权限)
app.use('/api/admin/providers', adminProviderRoutes);
app.use('/api/admin/users', adminUserRoutes);
app.use('/api/admin/logs', adminLogRoutes);
app.use('/api/admin/stats', adminStatsRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/backup', adminBackupRoutes);
app.use('/api/admin/pricing', adminPricingRoutes);
app.use('/api/admin/provider-types', adminProviderTypeRoutes);
app.use('/api/admin', adminAdminsRoutes);
app.use('/api/admin/providers', adminAvailabilityRoutes);

// 用户路由
app.use('/api/user', userRoutes);
app.use('/api/user', userKeyRoutes);
app.use('/api/user', userModelRoutes);

// AI API 代理路由 (核心功能)
app.use('/', proxyRoutes);

// ==================== 404 ====================

app.use((req, res) => {
  res.status(404).json({
    error: { message: `路径不存在: ${req.method} ${req.path}`, type: 'NOT_FOUND', code: 404 },
  });
});

// ==================== 错误处理 ====================

app.use(errorHandler);

// ==================== 启动服务 ====================

// 进程级兜底: Express 4 不会自动接住 async 异常，中间件之外漏出的 rejection
// 在 Node 15+ 默认直接终止进程。这里记账 + 交给容器重启，避免"无声消失"最难排。
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
process.on('uncaughtException', (err) => {
  logger.error('未捕获异常，进程即将退出', { error: err.message, stack: err.stack });
  process.exit(1);
});

async function start() {
  console.log('\n========================================');
  console.log('  WildAPI - AI API Proxy Station v' + pkg.version);
  console.log('========================================\n');

  // 配置校验
  validateConfig();

  // 测试数据库连接
  const result = await testConnections();
  if (result.mysql && result.redis) {
    console.log('[OK] 数据库连接正常\n');
  } else {
    if (!result.mysql) {
      console.error('[ERROR] MySQL 连接失败');
      console.error('[提示] 请运行 npm run setup-mysql 自动安装配置 MySQL');
      console.error('[提示] 或手动检查 .env 中的数据库配置\n');
    }
    if (!result.redis) {
      console.error('[ERROR] Redis 连接失败');
      console.error('[提示] 请检查 Redis 服务是否启动\n');
    }
    // 不退出，允许服务以降级模式运行
  }

  // 启动供应方健康探测 (熔断/热切换)
  circuitBreaker.startHealthProbe();

  // 启动上游密钥模型发现与可用性检测调度
  availabilityService.startScheduler();

  app.listen(config.port, () => {
    console.log(`[WildAPI] 服务启动成功: http://localhost:${config.port}`);
    console.log(`[WildAPI] AI API 代理: http://localhost:${config.port}/v1/chat/completions`);
    console.log(`[WildAPI] 管理面板: ${config.frontendUrl}`);
    console.log(`[WildAPI] SSO 认证: ${config.sso.authUrl}`);
    console.log('');
    console.log('可用命令:');
    console.log('  npm run dev          - 开发模式启动');
    console.log('  npm run setup-mysql  - 自动安装配置 MySQL');
    console.log('  npm run migrate      - 执行数据库迁移');
    console.log('  npm run test:relay   - 代理链路回归测试 (无需 MySQL/Redis)');
    console.log('  npm run docker:deploy - Docker 一键部署');
    console.log('  npm run docker:down  - Docker 停止服务');
    console.log('');
  });
}

start().catch((err) => {
  console.error('服务启动失败:', err);
  process.exit(1);
});
