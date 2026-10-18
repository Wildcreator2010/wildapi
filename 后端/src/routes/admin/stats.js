const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { pool, redis } = require('../../config/database');
const logger = require('../../utils/logger');

/** days/limit 参数兜底: 防 NaN/负值/超大值进入 SQL 导致 500 或全表扫描 */
function parseDays(value, fallback = 30) {
  const d = parseInt(value, 10);
  if (!Number.isFinite(d) || d < 1) return fallback;
  return Math.min(d, 365);
}

function parseLimit(value, fallback = 20) {
  const l = parseInt(value, 10);
  if (!Number.isFinite(l) || l < 1) return fallback;
  return Math.min(l, 100);
}

// 统计总览
router.get('/overview', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [userCount] = await pool.query('SELECT COUNT(*) as total FROM users');
    const [activeUserCount] = await pool.query('SELECT COUNT(*) as total FROM users WHERE is_active = 1');
    const [providerCount] = await pool.query('SELECT COUNT(*) as total FROM providers WHERE is_active = 1');
    const [totalRequests] = await pool.query('SELECT COUNT(*) as total FROM request_logs');
    const [todayRequests] = await pool.query(
      "SELECT COUNT(*) as total FROM request_logs WHERE created_at >= CURDATE()"
    );
    const [totalCost] = await pool.query('SELECT COALESCE(SUM(cost), 0) as total FROM request_logs');
    const [avgLatency] = await pool.query(
      "SELECT COALESCE(AVG(latency_ms), 0) as avg_ms FROM request_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)"
    );
    const [totalBalance] = await pool.query('SELECT COALESCE(SUM(balance), 0) as total FROM users');

    res.json({
      success: true,
      data: {
        userCount: userCount[0].total,
        activeUserCount: activeUserCount[0].total,
        providerCount: providerCount[0].total,
        totalRequests: totalRequests[0].total,
        todayRequests: todayRequests[0].total,
        totalCost: parseFloat(totalCost[0].total),
        avgLatencyMs: Math.round(avgLatency[0].avg_ms),
        totalBalance: parseFloat(totalBalance[0].total),
      },
    });
  } catch (err) { next(err); }
});

// 按用户统计用量 (Top N)
router.get('/by-user', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { days = 30, limit = 20 } = req.query;
    const [rows] = await pool.query(
      `SELECT u.id, u.username, COUNT(rl.id) as request_count, 
              COALESCE(SUM(rl.tokens_in + rl.tokens_out), 0) as total_tokens,
              COALESCE(SUM(rl.cost), 0) as total_cost
       FROM request_logs rl
       JOIN users u ON rl.user_id = u.id
       WHERE rl.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY u.id, u.username
       ORDER BY total_cost DESC
       LIMIT ?`,
      [parseDays(days), parseLimit(limit)]
    );
    res.json({ success: true, data: { list: rows } });
  } catch (err) { next(err); }
});

// 按模型统计用量
router.get('/by-model', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const [rows] = await pool.query(
      `SELECT model, COUNT(*) as request_count,
              COALESCE(SUM(tokens_in + tokens_out), 0) as total_tokens,
              COALESCE(SUM(cost), 0) as total_cost,
              COALESCE(AVG(latency_ms), 0) as avg_latency_ms
       FROM request_logs
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND model IS NOT NULL
       GROUP BY model
       ORDER BY total_cost DESC`,
      [parseDays(days)]
    );
    res.json({ success: true, data: { list: rows } });
  } catch (err) { next(err); }
});

// 按时间维度统计 (每日请求量)
router.get('/by-time', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { days = 14 } = req.query;
    const [rows] = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as request_count,
              COALESCE(SUM(tokens_in + tokens_out), 0) as total_tokens,
              COALESCE(SUM(cost), 0) as total_cost
       FROM request_logs
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [parseDays(days, 14)]
    );
    res.json({ success: true, data: { list: rows } });
  } catch (err) { next(err); }
});

// 按厂商聚合统计 (管理员查看各厂商 Key 的累计用量与成本)
router.get('/by-provider', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    // 厂商维度: 请求次数 / token / 成本 (按 request_logs 聚合)
    const [rows] = await pool.query(
      `SELECT p.name as provider_name, p.type as provider_type,
              COUNT(rl.id) as request_count,
              COALESCE(SUM(rl.tokens_in + rl.tokens_out), 0) as total_tokens,
              COALESCE(SUM(rl.cost), 0) as total_cost,
              COALESCE(AVG(rl.latency_ms), 0) as avg_latency_ms
       FROM request_logs rl
       JOIN providers p ON rl.provider_id = p.id
       WHERE rl.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY p.id, p.name, p.type
       ORDER BY total_cost DESC`,
      [parseDays(days)]
    );

    // 密钥维度: 每把密钥的累计调用次数与最近使用时间
    const [keys] = await pool.query(
      `SELECT pk.id, pk.provider_id, p.name as provider_name, p.type as provider_type,
              pk.key_name, pk.usage_count, pk.last_used_at, pk.is_active, pk.cooldown_until
       FROM provider_keys pk
       JOIN providers p ON pk.provider_id = p.id
       ORDER BY pk.usage_count DESC`
    );

    res.json({ success: true, data: { providers: rows, keys } });
  } catch (err) { next(err); }
});

// 命中率统计 (缓存命中率 + 路由命中率)
router.get('/by-hitrate', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { days = 7 } = req.query;

    // Redis 计数在 Redis 不可用时返回 null，不能让整页 500 (服务支持降级运行)
    const safeCount = async (key) => {
      try {
        const v = await redis.get(key);
        return v === null ? 0 : (parseInt(v) || 0);
      } catch (err) {
        logger.warn('读取 Redis 计数失败 (Redis 不可用)', { key, error: err.message });
        return null;
      }
    };

    // 1. 代理密钥缓存命中率 (Redis 实时计数)
    const [cacheHit, cacheMiss] = await Promise.all([
      safeCount('stats:cache:hit'),
      safeCount('stats:cache:miss'),
    ]);
    const cacheTotal = (cacheHit === null || cacheMiss === null) ? null : cacheHit + cacheMiss;
    const cacheHitRate = cacheTotal ? parseFloat((cacheHit / cacheTotal * 100).toFixed(2)) : null;

    // 2. 路由匹配命中率 (Redis 实时计数)
    const [routeHit, routeTotal] = await Promise.all([
      safeCount('stats:route:hit'),
      safeCount('stats:route:total'),
    ]);
    const routeHitRate = routeTotal ? parseFloat((routeHit / routeTotal * 100).toFixed(2)) : null;

    // 3. 路由命中率趋势 (request_logs: provider_id 非空视为命中)
    const [trend] = await pool.query(
      `SELECT DATE(created_at) as date,
              COUNT(*) as total_count,
              SUM(provider_id IS NOT NULL) as hit_count,
              ROUND(SUM(provider_id IS NOT NULL) / NULLIF(COUNT(*), 0) * 100, 2) as hit_rate
       FROM request_logs
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [parseDays(days, 7)]
    );

    res.json({
      success: true,
      data: {
        cacheHitRate: { rate: cacheHitRate, hitCount: cacheHit, totalCount: cacheTotal },
        routeHitRate: { rate: routeHitRate, hitCount: routeHit, totalCount: routeTotal },
        trend: trend.map(t => ({
          date: t.date,
          hitCount: t.hit_count,
          totalCount: t.total_count,
          hitRate: parseFloat(t.hit_rate),
        })),
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
