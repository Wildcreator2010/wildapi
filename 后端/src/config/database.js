const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const { config } = require('./index');
const logger = require('../utils/logger');

// MySQL 连接池
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.poolSize,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// Redis 客户端
const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  retryStrategy: (times) => {
    const delay = Math.min(times * 200, 3000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('error', (err) => {
  logger.error('Redis 连接错误', { error: err.message });
});

redis.on('connect', () => {
  logger.info('Redis 连接成功');
});

// 测试数据库连接（返回连接状态，不抛出错误以允许服务降级运行）
async function testConnections() {
  let mysqlOk = false;
  let conn = null;
  try {
    conn = await pool.getConnection();
    await conn.ping();
    mysqlOk = true;
    // 迁移脚本里的库名是硬编码的 wildapi (CREATE DATABASE / USE / information_schema 判断都是)，
    // DB_NAME 取了别的名字时迁移会把表建到 wildapi 里，应用连自己的空库 → 所有接口 500，
    // 而容器健康检查照样绿。这里显式核对一次，把问题说破在启动日志里。
    const [tables] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      ['users']
    );
    if (tables[0].n === 0) {
      logger.error('当前库中没有 users 表', {
        database: config.db.database,
        hint: '先执行 npm run migrate；若迁移跑过仍缺表，说明 DB_NAME 与迁移硬编码的 wildapi 不一致',
      });
    } else {
      logger.info('MySQL 连接成功');
    }
  } catch (err) {
    logger.error('MySQL 连接失败', { error: err.message });
  } finally {
    if (conn) conn.release();
  }

  let redisOk = false;
  try {
    await redis.ping();
    logger.info('Redis 连接成功');
    redisOk = true;
  } catch (err) {
    logger.error('Redis 连接失败', { error: err.message });
  }

  return { mysql: mysqlOk, redis: redisOk };
}

module.exports = { pool, redis, testConnections };
