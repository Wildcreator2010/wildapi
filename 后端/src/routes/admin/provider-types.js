const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const ProviderType = require('../../models/ProviderType');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const logger = require('../../utils/logger');

// 代码格式校验: 小写字母/数字/下划线, 2-32 位
const CODE_RE = /^[a-z0-9_]{2,32}$/;

// 列出全部分类
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const list = await ProviderType.list();
    res.json({ success: true, data: { list } });
  } catch (err) { next(err); }
});

// 新增分类
router.post('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { code, label, sortOrder } = req.body;
    if (!code || !CODE_RE.test(String(code))) {
      throw new ValidationError('分类代码需为 2-32 位小写字母/数字/下划线');
    }
    if (!label || !String(label).trim()) {
      throw new ValidationError('请填写分类显示名称');
    }
    if (await ProviderType.findByCode(String(code))) {
      throw new ValidationError(`分类代码 ${code} 已存在`);
    }
    const type = await ProviderType.create({
      code: String(code),
      label: String(label).trim(),
      sortOrder: parseInt(sortOrder, 10) || 0,
    });
    logger.info('新增供应商分类', { adminId: req.user.id, code, label });
    res.status(201).json({ success: true, data: { type } });
  } catch (err) { next(err); }
});

// 重命名/更新分类 (code 变更时级联更新 providers.type / pricing_configs.provider_type)
router.put('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const target = await ProviderType.findById(parseInt(req.params.id));
    if (!target) throw new NotFoundError('分类不存在');

    const fields = {};
    if (req.body.code !== undefined) {
      const code = String(req.body.code);
      if (!CODE_RE.test(code)) throw new ValidationError('分类代码需为 2-32 位小写字母/数字/下划线');
      if (code !== target.code) {
        if (await ProviderType.findByCode(code)) throw new ValidationError(`分类代码 ${code} 已存在`);
        fields.code = code;
      }
    }
    if (req.body.label !== undefined) {
      const label = String(req.body.label).trim();
      if (!label) throw new ValidationError('请填写分类显示名称');
      fields.label = label;
    }
    if (req.body.sortOrder !== undefined) fields.sort_order = parseInt(req.body.sortOrder, 10) || 0;
    if (req.body.isActive !== undefined) fields.is_active = req.body.isActive ? 1 : 0;

    if (Object.keys(fields).length === 0) {
      throw new ValidationError('未提供任何可更新字段');
    }

    // 级联: code 变更时同步服务商与定价配置引用
    if (fields.code && fields.code !== target.code) {
      const { pool } = require('../../config/database');
      await pool.query('UPDATE providers SET type = ? WHERE type = ?', [fields.code, target.code]);
      await pool.query('UPDATE pricing_configs SET provider_type = ? WHERE provider_type = ?', [fields.code, target.code]);
    }

    const type = await ProviderType.update(target.id, fields);
    logger.info('更新供应商分类', { adminId: req.user.id, id: target.id, fields });
    res.json({ success: true, message: '分类已更新', data: { type } });
  } catch (err) { next(err); }
});

// 删除分类 (被服务商/定价引用时禁止删除)
router.delete('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const target = await ProviderType.findById(parseInt(req.params.id));
    if (!target) throw new NotFoundError('分类不存在');

    const { providerCount, pricingCount } = await ProviderType.countReferences(target.code);
    if (providerCount > 0) {
      throw new ValidationError(`该分类下存在 ${providerCount} 个服务商，请先转移或删除这些服务商后再删除分类`);
    }
    if (pricingCount > 0) {
      throw new ValidationError(`该分类被 ${pricingCount} 条定价配置引用，请先调整定价后再删除分类`);
    }

    await ProviderType.delete(target.id);
    logger.info('删除供应商分类', { adminId: req.user.id, code: target.code });
    res.json({ success: true, message: `分类 ${target.label} 已删除` });
  } catch (err) { next(err); }
});

module.exports = router;
