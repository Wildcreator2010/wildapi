const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const User = require('../../models/User');
const UserProxyKey = require('../../models/UserProxyKey');
const { sendRechargeRequest } = require('../../services/mailService');
const { pool } = require('../../config/database');
const { ValidationError, RateLimitError } = require('../../utils/errors');
const { parsePagination } = require('../../utils/pagination');
const logger = require('../../utils/logger');

// ==================== 仪表盘 ====================

// 获取个人仪表盘数据
router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    // 今日用量
    const [todayStats] = await pool.query(
      `SELECT COUNT(*) as request_count, COALESCE(SUM(tokens_in + tokens_out), 0) as total_tokens,
              COALESCE(SUM(cost), 0) as total_cost
       FROM request_logs WHERE user_id = ? AND created_at >= CURDATE()`,
      [userId]
    );

    // 本月用量
    const [monthStats] = await pool.query(
      `SELECT COUNT(*) as request_count, COALESCE(SUM(tokens_in + tokens_out), 0) as total_tokens,
              COALESCE(SUM(cost), 0) as total_cost
       FROM request_logs WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      [userId]
    );

    // API 密钥数量 (代理分发密钥)
    const apiKeyCount = await UserProxyKey.countByUser(userId);

    // 当前并发占用 (Redis 不可用时显示 0，不能让仪表盘整页 500)
    const { redis } = require('../../config/database');
    let currentConcurrency = 0;
    try {
      currentConcurrency = parseInt(await redis.get(`concurrency:user:${userId}`)) || 0;
    } catch (err) {
      logger.warn('读取并发计数失败 (Redis 不可用)', { userId, error: err.message });
    }

    res.json({
      success: true,
      data: {
        balance: parseFloat(user.balance),
        username: user.username,
        role: user.role,
        today: { requests: todayStats[0].request_count, tokens: todayStats[0].total_tokens, cost: parseFloat(todayStats[0].total_cost) },
        month: { requests: monthStats[0].request_count, tokens: monthStats[0].total_tokens, cost: parseFloat(monthStats[0].total_cost) },
        apiKeyCount,
        concurrency: {
          current: currentConcurrency,
          limit: user.concurrent_limit || 3,
        },
      },
    });
  } catch (err) { next(err); }
});

// ==================== 使用记录 ====================

// 获取个人使用记录 (分页参数安全兜底，防 NaN/负值进入 SQL)
router.get('/usage', requireAuth, async (req, res, next) => {
  try {
    const { model } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);
    const conditions = ['rl.user_id = ?'];
    const params = [req.user.id];
    if (model) { conditions.push('rl.model LIKE ?'); params.push(`%${model}%`); }

    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM request_logs rl WHERE ${conditions.join(' AND ')}`, params
    );
    const [rows] = await pool.query(
      `SELECT rl.id, rl.model, rl.tokens_in, rl.tokens_out, rl.cost, rl.latency_ms, rl.status_code, rl.created_at
       FROM request_logs rl WHERE ${conditions.join(' AND ')}
       ORDER BY rl.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({
      success: true,
      data: { list: rows, total: countResult[0].total, page, pageSize },
    });
  } catch (err) { next(err); }
});

// ==================== 余额明细 ====================

// 获取个人余额流水 (充值/扣费记录, 管理员与普通用户通用)
router.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const { page, pageSize, offset } = parsePagination(req.query);

    const [countResult] = await pool.query(
      'SELECT COUNT(*) as total FROM user_balance_transactions WHERE user_id = ?',
      [req.user.id]
    );
    const [rows] = await pool.query(
      `SELECT id, amount, type, balance_before, balance_after, reference_id, note, created_at
       FROM user_balance_transactions WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [req.user.id, pageSize, offset]
    );

    res.json({
      success: true,
      data: { list: rows, total: countResult[0].total, page, pageSize },
    });
  } catch (err) { next(err); }
});

// 充值请求 (发邮件给管理员; 每用户 5 分钟冷却防邮件轰炸)
router.post('/recharge-request', requireAuth, async (req, res, next) => {
  try {
    const { amount, message = '' } = req.body;
    const parsed = parseFloat(amount);
    if (!parsed || isNaN(parsed) || parsed <= 0) {
      throw new ValidationError('请输入有效的充值金额');
    }
    if (parsed > 100000) {
      throw new ValidationError('充值金额过大，请分多次提交');
    }
    if (typeof message === 'string' && message.length > 500) {
      throw new ValidationError('留言内容过长');
    }

    // 邮件冷却窗口: 同一用户 5 分钟内只允许发送 1 封
    const { redis } = require('../../config/database');
    const cooldownKey = `mail:recharge:user:${req.user.id}`;
    try {
      const ttl = await redis.ttl(cooldownKey);
      if (ttl > 0) {
        const minutes = Math.ceil(ttl / 60);
        throw new RateLimitError(`请求过于频繁，请 ${minutes} 分钟后再试`);
      }
    } catch (err) {
      if (err.isOperational) throw err;
      // Redis 故障时跳过冷却而不是让接口 500: 充值请求本身低频，宁可少一层保护
      logger.warn('邮件冷却检查不可用，本次跳过', { userId: req.user.id, error: err.message });
    }

    const sent = await sendRechargeRequest(
      { id: req.user.id, username: req.user.username, email: req.user.email },
      parsed,
      message
    );

    // 发送成功后设置冷却
    await redis.set(cooldownKey, '1', 'EX', 300).catch((err) =>
      logger.warn('邮件冷却写入失败 (Redis 不可用)', { error: err.message }));

    logger.info('用户提交充值请求', { userId: req.user.id, amount: parsed });

    res.json({
      success: true,
      message: sent
        ? '充值请求已发送给管理员，请等待处理'
        : '充值请求已记录（邮件服务未配置，管理员将通过管理后台查看）',
    });
  } catch (err) { next(err); }
});

module.exports = router;
