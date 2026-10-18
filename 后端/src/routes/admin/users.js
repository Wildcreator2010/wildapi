const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const User = require('../../models/User');
const { adminRecharge, adminAdjustBalance } = require('../../services/billingService');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../utils/errors');
const { parsePagination } = require('../../utils/pagination');
const logger = require('../../utils/logger');

/** 隔离检查: admin 不能操作其他 admin/superadmin 账号 */
async function assertCanManage(actor, targetId) {
  if (actor.role === 'superadmin') return;
  const target = await User.findById(targetId);
  if (target && ['admin', 'superadmin'].includes(target.role)) {
    throw new ForbiddenError('仅超级管理员可管理管理员账号');
  }
}

// 获取用户列表 (分页 + 搜索 + 过滤)
// 用户隔离: admin 只能看到普通用户; superadmin 可看到全部
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { page = 1, pageSize = 20, search = '', role = '', isActive } = req.query;
    // admin 只能管理普通用户: 角色过滤对非超管强制为 'user'，
    // 否则 ?role=superadmin 即可越过隔离拿到全部管理员行 (含 balance/wildaccount_id)
    const effectiveRole = req.user.role !== 'superadmin' ? 'user' : role;
    // isActive 必须是 0/1: parseInt('abc')=NaN 会被拼进 SQL 变成 `is_active = NaN` → 500
    let isActiveFilter = null;
    if (isActive !== undefined && isActive !== '') {
      const n = Number(isActive);
      if (n !== 0 && n !== 1) throw new ValidationError('isActive 只能是 0 或 1');
      isActiveFilter = n;
    }
    const { page: safePage, pageSize: safePageSize } = parsePagination(req.query);
    const result = await User.list({
      page: safePage,
      pageSize: safePageSize,
      search, role: effectiveRole,
      isActive: isActiveFilter,
    });
    res.json({ success: true, data: { ...result, actorRole: req.user.role } });
  } catch (err) { next(err); }
});

// 获取单个用户详情 (隔离检查与其余接口一致: admin 不可读取管理员账号详情)
router.get('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    await assertCanManage(req.user, id);
    const user = await User.findById(id);
    if (!user) throw new NotFoundError('用户不存在');
    res.json({ success: true, data: { user } });
  } catch (err) { next(err); }
});

// 管理员给用户充值 (隔离检查 + 金额有限性/上限校验，防 Infinity/负数穿透)
router.post('/:id/recharge', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await assertCanManage(req.user, parseInt(req.params.id));
    const { amount, note } = req.body;
    const parsed = parseFloat(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ValidationError('充值金额必须为大于 0 的有限数字');
    }
    if (parsed > 1000000) {
      throw new ValidationError('单次充值金额不能超过 $1,000,000');
    }

    const result = await adminRecharge(req.user.id, parseInt(req.params.id), parsed, note || '');
    logger.info('管理员充值完成', {
      adminId: req.user.id, targetId: req.params.id, amount: parsed,
    });

    res.json({
      success: true,
      message: `成功为用户充值 $${parsed.toFixed(2)}`,
      data: result,
    });
  } catch (err) { next(err); }
});

// 设置用户并发上限
router.put('/:id/concurrency', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { limit } = req.body;
    const parsed = parseInt(limit);
    if (!parsed || parsed < 1 || parsed > 100) {
      throw new ValidationError('并发数需在 1-100 之间');
    }

    const target = await User.findById(parseInt(req.params.id));
    if (!target) throw new NotFoundError('用户不存在');
    // 隔离: admin 不能修改其他 admin
    if (req.user.role !== 'superadmin' && ['admin', 'superadmin'].includes(target.role)) {
      throw new ForbiddenError('仅超级管理员可管理管理员账号');
    }

    const { pool } = require('../../config/database');
    await pool.query('UPDATE users SET concurrent_limit = ?, updated_at = NOW() WHERE id = ?', [parsed, target.id]);

    const { audit } = require('../../services/auditService');
    audit({
      actorId: req.user.id, actorName: req.user.username,
      action: 'user.concurrency', targetType: 'user', targetId: target.id,
      detail: { targetName: target.username, limit: parsed },
      ip: req.ip,
    }).catch(() => {});

    res.json({ success: true, message: `已将 ${target.username} 的并发上限设为 ${parsed}` });
  } catch (err) { next(err); }
});

// 设置用户 RPM 限制 (每分钟请求数，与并发上限独立)
router.put('/:id/rpm', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rpm } = req.body;
    const parsed = parseInt(rpm);
    if (!parsed || parsed < 1 || parsed > 1000) {
      throw new ValidationError('RPM 需在 1-1000 之间');
    }

    const target = await User.findById(parseInt(req.params.id));
    if (!target) throw new NotFoundError('用户不存在');
    // 隔离: admin 不能修改其他 admin (含自己)
    if (req.user.role !== 'superadmin' && ['admin', 'superadmin'].includes(target.role)) {
      throw new ForbiddenError('仅超级管理员可管理管理员账号');
    }

    const { pool } = require('../../config/database');
    await pool.query('UPDATE users SET rpm_limit = ?, updated_at = NOW() WHERE id = ?', [parsed, target.id]);

    const { audit } = require('../../services/auditService');
    audit({
      actorId: req.user.id, actorName: req.user.username,
      action: 'user.rpm', targetType: 'user', targetId: target.id,
      detail: { targetName: target.username, rpm: parsed },
      ip: req.ip,
    }).catch(() => {});

    res.json({ success: true, message: `已将 ${target.username} 的 RPM 限制设为 ${parsed} 次/分钟` });
  } catch (err) { next(err); }
});

// 管理员手动调整余额 (正数为增加，负数为扣减)
router.post('/:id/adjust', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await assertCanManage(req.user, parseInt(req.params.id));
    const { amount, note } = req.body;
    const parsed = parseFloat(amount);
    if (!Number.isFinite(parsed) || parsed === 0) throw new ValidationError('调整金额无效');

    const result = await adminAdjustBalance(req.user.id, parseInt(req.params.id), parsed, note || '');
    logger.info('管理员调整余额完成', {
      adminId: req.user.id, targetId: req.params.id, amount: parsed,
    });

    res.json({
      success: true,
      message: parsed >= 0
        ? `成功为用户增加余额 $${parsed.toFixed(2)}`
        : `成功扣减用户余额 $${Math.abs(parsed).toFixed(2)}`,
      data: result,
    });
  } catch (err) { next(err); }
});

// 启用/禁用用户
router.put('/:id/status', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await assertCanManage(req.user, parseInt(req.params.id));
    const { isActive } = req.body;
    if (isActive === undefined) throw new ValidationError('请指定 isActive 字段');

    const user = await User.setActive(parseInt(req.params.id), !!isActive);
    if (!user) throw new NotFoundError('用户不存在');

    res.json({
      success: true,
      message: isActive ? '用户已启用' : '用户已禁用',
      data: { user },
    });
  } catch (err) { next(err); }
});

// 获取用户余额流水 (隔离检查: 与其他接口一致，普通 admin 不可查看其他管理员流水)
router.get('/:id/transactions', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await assertCanManage(req.user, parseInt(req.params.id));
    const target = await User.findById(parseInt(req.params.id));
    if (!target) throw new NotFoundError('用户不存在');

    const { pool } = require('../../config/database');
    const { page, pageSize, offset } = parsePagination(req.query);

    const [countResult] = await pool.query(
      'SELECT COUNT(*) as total FROM user_balance_transactions WHERE user_id = ?',
      [target.id]
    );
    const [rows] = await pool.query(
      `SELECT * FROM user_balance_transactions WHERE user_id = ? 
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [target.id, pageSize, offset]
    );

    res.json({
      success: true,
      data: { list: rows, total: countResult[0].total, page, pageSize },
    });
  } catch (err) { next(err); }
});

module.exports = router;
