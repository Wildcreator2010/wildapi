const { pool } = require('../config/database');
const User = require('../models/User');
const PricingConfig = require('../models/PricingConfig');
const logger = require('../utils/logger');
const { InsufficientBalanceError, NotFoundError, ValidationError } = require('../utils/errors');

/**
 * 模型价格配置 (美元 / 1K tokens)
 * 作为数据库未配置时的兜底定价
 */
const DEFAULT_PRICING = {
  // OpenAI
  'gpt-4o': { promptPrice: 0.005, completionPrice: 0.015 },
  'gpt-4o-mini': { promptPrice: 0.00015, completionPrice: 0.0006 },
  'gpt-4-turbo': { promptPrice: 0.01, completionPrice: 0.03 },
  'gpt-4': { promptPrice: 0.03, completionPrice: 0.06 },
  'gpt-3.5-turbo': { promptPrice: 0.0005, completionPrice: 0.0015 },
  // Claude
  'claude-3-opus': { promptPrice: 0.015, completionPrice: 0.075 },
  'claude-3-sonnet': { promptPrice: 0.003, completionPrice: 0.015 },
  'claude-3-haiku': { promptPrice: 0.00025, completionPrice: 0.00125 },
  'claude-3.5-sonnet': { promptPrice: 0.003, completionPrice: 0.015 },
  // 默认 (通配)
  'default': { promptPrice: 0.001, completionPrice: 0.002 },
};

/**
 * 获取模型定价 (动态: 优先数据库配置，实时生效)
 * @param {string} model - 模型名
 * @param {string} providerType - 厂商类型
 * @returns {Promise<{promptPrice, completionPrice, source}>}
 */
async function getPricing(model, providerType = 'openai') {
  // 1. 优先查数据库动态定价 (精确/通配匹配)
  try {
    const config = await PricingConfig.findMatch(model, providerType);
    if (config) {
      // 倍率模式: 价格填 0 时用上游成本 x 倍率; 否则用户价 x 倍率
      const multiplier = parseFloat(config.multiplier) || 1;
      let promptPrice = parseFloat(config.prompt_price);
      let completionPrice = parseFloat(config.completion_price);
      if (promptPrice === 0 && completionPrice === 0) {
        const costBase = getDefaultPricing(model);
        promptPrice = costBase.promptPrice * multiplier;
        completionPrice = costBase.completionPrice * multiplier;
      } else {
        promptPrice = promptPrice * multiplier;
        completionPrice = completionPrice * multiplier;
      }
      return {
        promptPrice,
        completionPrice,
        source: 'database',
      };
    }
  } catch (err) {
    logger.warn('动态定价查询失败，回退默认定价', { error: err.message });
  }

  // 2. 兜底: 内置默认定价
  const fallback = getDefaultPricing(model);
  return { ...fallback, source: 'default' };
}

/**
 * 内置默认定价查找 (精确 + 前缀匹配)
 */
function getDefaultPricing(model) {
  // 精确匹配
  if (DEFAULT_PRICING[model]) return DEFAULT_PRICING[model];

  // 前缀匹配 (如 gpt-4-turbo-preview 匹配 gpt-4-turbo)
  for (const key of Object.keys(DEFAULT_PRICING)) {
    if (key !== 'default' && model.toLowerCase().startsWith(key.toLowerCase())) {
      return DEFAULT_PRICING[key];
    }
  }

  return DEFAULT_PRICING['default'];
}

/**
 * 计算请求费用 (美元)，基于实时定价
 */
async function calculateCost(model, tokensIn, tokensOut, providerType = 'openai') {
  const pricing = await getPricing(model, providerType);
  const costIn = (tokensIn / 1000) * pricing.promptPrice;
  const costOut = (tokensOut / 1000) * pricing.completionPrice;
  return parseFloat((costIn + costOut).toFixed(6));
}

/**
 * 检查用户余额是否充足
 * @param {number} estimatedCost - 本次请求的潜在最大成本预估，余额低于该值提前拒绝，
 *                                 防止低余额用户发起大额请求白嫖上游成本 (结算时按实际用量扣费，多估不会多扣)
 */
async function checkBalance(userId, estimatedCost = 0.001) {
  const user = await User.findById(userId);
  if (!user) throw new NotFoundError('用户不存在');
  if (!user.is_active) throw new InsufficientBalanceError('账户已被禁用');

  const balance = parseFloat(user.balance);
  if (balance <= 0) {
    throw new InsufficientBalanceError('余额不足，请充值后重试');
  }

  // 如果余额小于最小预估费用也提前拒绝
  if (balance < estimatedCost) {
    throw new InsufficientBalanceError(`余额不足 (当前: $${balance.toFixed(4)}, 最低需要: $${estimatedCost.toFixed(4)})`);
  }

  return true;
}

/**
 * 管理员充值
 */
async function adminRecharge(adminUserId, targetUserId, amount, note = '') {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('充值金额无效');
  }
  if (amount > 1000000) throw new ValidationError('单次充值金额不能超过 $1,000,000');
  return adminAdjustBalance(adminUserId, targetUserId, amount, note, 'admin_recharge');
}

/**
 * 管理员手动调整余额 (正数为增加，负数为扣减)，记录流水。
 * 事务 + FOR UPDATE: 保证流水的 before/after 与真实余额一致，避免并发下失真。
 */
async function adminAdjustBalance(adminUserId, targetUserId, amount, note = '', type = 'admin_adjust') {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) throw new ValidationError('调整金额无效');
  if (Math.abs(amount) > 1000000) throw new ValidationError('单次调整金额不能超过 $1,000,000');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [userRows] = await conn.query('SELECT balance FROM users WHERE id = ? FOR UPDATE', [targetUserId]);
    if (userRows.length === 0) throw new NotFoundError('目标用户不存在');

    const balanceBefore = parseFloat(userRows[0].balance);
    const balanceAfter = parseFloat((balanceBefore + amount).toFixed(6));
    if (balanceAfter < 0) throw new ValidationError('调整后余额不能为负数');

    await conn.query('UPDATE users SET balance = ?, updated_at = NOW() WHERE id = ?', [balanceAfter, targetUserId]);

    await conn.query(
      `INSERT INTO user_balance_transactions 
       (user_id, amount, type, balance_before, balance_after, note) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [targetUserId, amount, type, balanceBefore, balanceAfter,
       note || `管理员 #${adminUserId} 调整余额 $${amount}`]
    );

    await conn.commit();
    logger.info('管理员调整余额', { adminUserId, targetUserId, amount, type, balanceBefore, balanceAfter });
    return { balanceBefore, balanceAfter, amount };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 事务结算: 扣费 + 余额流水 + 请求日志在同一事务中完成
 * 防止扣费后无记录、或有记录未扣费
 * @returns {logId} 请求日志 ID
 */
async function settleTransaction({ userId, cost, requestLog }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let balanceBefore = null;
    let balanceAfter = null;

    // 1. 扣费 (仅当有费用)
    if (userId && cost > 0) {
      const [userRows] = await conn.query('SELECT balance FROM users WHERE id = ? FOR UPDATE', [userId]);
      if (userRows.length === 0) throw new Error('用户不存在');
      balanceBefore = parseFloat(userRows[0].balance);
      // 6 位小数与 request_logs.cost 同精度: 按 4 位舍入会让低于 $0.00005 的调用实际不扣费，
      // 却照样记一条非 0 成本，余额与成本之和长期对不上
      balanceAfter = parseFloat((balanceBefore - cost).toFixed(6));

      const [upd] = await conn.query(
        'UPDATE users SET balance = ?, updated_at = NOW() WHERE id = ? AND balance >= ?',
        [balanceAfter, userId, cost]
      );
      if (upd.affectedRows === 0) {
        throw new InsufficientBalanceError('余额不足，扣费失败');
      }

      await conn.query(
        `INSERT INTO user_balance_transactions
         (user_id, amount, type, balance_before, balance_after, reference_id, note)
         VALUES (?, ?, 'api_consumption', ?, ?, ?, ?)`,
        [userId, -cost, balanceBefore, balanceAfter, null, `API 调用消费: $${cost.toFixed(6)}`]
      );
    }

    // 2. 写请求日志
    const {
      providerId = null, providerKeyId = null, model = null,
      requestBody = null, responseBody = null, latencyMs = null, statusCode = null,
      tokensIn = 0, tokensOut = 0, errorMessage = null,
    } = requestLog || {};

    const [logResult] = await conn.query(
      `INSERT INTO request_logs
       (user_id, provider_id, provider_key_id, model, request_body, response_body,
        latency_ms, status_code, tokens_in, tokens_out, cost, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, providerId, providerKeyId, model,
       requestBody ? JSON.stringify(requestBody) : null,
       responseBody ? (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)) : null,
       latencyMs, statusCode, tokensIn, tokensOut, cost, errorMessage]
    );

    const logId = logResult.insertId;

    // 3. 回填流水关联 ID
    if (userId && cost > 0) {
      await conn.query(
        'UPDATE user_balance_transactions SET reference_id = ? WHERE user_id = ? AND reference_id IS NULL AND amount = ? ORDER BY id DESC LIMIT 1',
        [String(logId), userId, -cost]
      );
    }

    await conn.commit();
    logger.info('事务结算完成', { userId, cost, logId, balanceBefore, balanceAfter });
    return { logId, balanceBefore, balanceAfter };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  getPricing,
  getDefaultPricing,
  calculateCost,
  checkBalance,
  settleTransaction,
  adminRecharge,
  adminAdjustBalance,
  DEFAULT_PRICING,
};
