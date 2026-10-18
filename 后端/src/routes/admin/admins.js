const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const User = require('../../models/User');
const { audit } = require('../../services/auditService');
const { adminRecharge } = require('../../services/billingService');
const { ForbiddenError, ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');

/**
 * 管理员权限管理 (仅 superadmin 可访问)
 * - 列出所有 admin 账号
 * - 撤销 admin 身份 (改为 user) / 恢复
 * - 被撤销者刷新后立即丧失管理面板访问权 (JWT 校验实时读库)
 */

// 仅 superadmin 中间件
function requireSuperadmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return next(new ForbiddenError('仅超级管理员可管理管理员权限'));
  }
  next();
}

// 超管给自己充值 (写入余额流水, 仅限 superadmin)
router.post('/self-recharge', requireAuth, requireSuperadmin, async (req, res, next) => {
  try {
    const { amount, note } = req.body;
    const parsed = parseFloat(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ValidationError('充值金额必须为大于 0 的有限数字');
    }
    if (parsed > 1000000) {
      throw new ValidationError('单次充值金额过大');
    }

    const result = await adminRecharge(
      req.user.id, req.user.id, parsed,
      note || `超级管理员自助充值 $${parsed}`,
    );

    audit({
      actorId: req.user.id, actorName: req.user.username,
      action: 'admin.self_recharge',
      targetType: 'user', targetId: req.user.id,
      detail: { amount: parsed, note: note || '' },
      ip: req.ip,
    }).catch(() => {});

    logger.info('超管自助充值', { userId: req.user.id, amount: parsed });
    res.json({
      success: true,
      message: `充值成功，当前余额 $${result.balanceAfter.toFixed(4)}`,
      data: result,
    });
  } catch (err) { next(err); }
});

// 列出所有 admin/superadmin 账号 + 曾被撤销为 user 的账号 (audit 有 admin.revoke 记录)，
// 否则被撤销者从列表消失，"恢复管理员"按钮失去入口
router.get('/admins', requireAuth, requireSuperadmin, async (req, res, next) => {
  try {
    const { pool } = require('../../config/database');
    const [rows] = await pool.query(
      `SELECT id, username, email, role, is_active, created_at
       FROM users
       WHERE role IN ('admin', 'superadmin')
          OR (role = 'user' AND id IN (
               SELECT DISTINCT CAST(target_id AS UNSIGNED) FROM audit_logs
               WHERE action = 'admin.revoke' AND target_type = 'user'
             ))
       ORDER BY FIELD(role, 'superadmin', 'admin'), created_at ASC`
    );
    res.json({ success: true, data: { list: rows } });
  } catch (err) { next(err); }
});

// 撤销/恢复管理员身份 (改为 user / 恢复为 admin)
router.put('/admins/:id/role', requireAuth, requireSuperadmin, async (req, res, next) => {
  try {
    const { role } = req.body; // 'user' (撤销) 或 'admin' (恢复)
    if (!['user', 'admin'].includes(role)) {
      throw new ValidationError('role 仅支持 user 或 admin');
    }

    const target = await User.findById(parseInt(req.params.id));
    if (!target) throw new ValidationError('用户不存在');
    if (target.role === 'superadmin') throw new ForbiddenError('不能修改超级管理员身份');
    // 禁止对自己降权: 唯一超管把自己降为 user 会导致系统永久无超级管理员 (自锁)
    if (target.id === req.user.id) throw new ForbiddenError('不能修改自己的管理员身份');

    const { pool } = require('../../config/database');
    await pool.query('UPDATE users SET role = ?, updated_at = NOW() WHERE id = ?', [role, target.id]);

    audit({
      actorId: req.user.id, actorName: req.user.username,
      action: role === 'user' ? 'admin.revoke' : 'admin.restore',
      targetType: 'user', targetId: target.id,
      detail: { targetName: target.username, newRole: role },
      ip: req.ip,
    }).catch(() => {});

    logger.info('管理员权限变更', { actorId: req.user.id, targetId: target.id, role });
    res.json({
      success: true,
      message: role === 'user'
        ? `已撤销 ${target.username} 的管理员身份，其刷新后立即失效`
        : `已恢复 ${target.username} 的管理员身份`,
    });
  } catch (err) { next(err); }
});

// 停用/启用管理账号 (is_active)
router.put('/admins/:id/status', requireAuth, requireSuperadmin, async (req, res, next) => {
  try {
    const { isActive } = req.body;
    const target = await User.findById(parseInt(req.params.id));
    if (!target) throw new ValidationError('用户不存在');
    if (target.role === 'superadmin') throw new ForbiddenError('不能停用超级管理员');
    // 禁止停用自己 (自锁风险)
    if (target.id === req.user.id && !isActive) throw new ForbiddenError('不能停用自己的账号');

    await User.setActive(target.id, !!isActive);
    audit({
      actorId: req.user.id, actorName: req.user.username,
      action: isActive ? 'admin.enable' : 'admin.disable',
      targetType: 'user', targetId: target.id,
      detail: { targetName: target.username },
      ip: req.ip,
    }).catch(() => {});

    res.json({ success: true, message: isActive ? '账号已启用' : '账号已停用' });
  } catch (err) { next(err); }
});

module.exports = router;
