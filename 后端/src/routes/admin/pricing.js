const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const PricingConfig = require('../../models/PricingConfig');
const ProviderType = require('../../models/ProviderType');
const { auditMiddleware } = require('../../services/auditService');
const { ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');

// 厂商类型从 provider_types 表动态读取 (支持管理员新增/重命名/删除分类)
async function loadProviderTypes() {
  const rows = await ProviderType.list({ activeOnly: true });
  return rows.map(r => ({ value: r.code, label: r.label }));
}

async function assertValidProviderType(providerType) {
  const types = await ProviderType.list({ activeOnly: true });
  if (!types.some(t => t.code === providerType)) {
    throw new ValidationError(`未知厂商类型: ${providerType}`);
  }
}

/**
 * 价格字段严格类型校验: 必须为有限非负数字。
 * 旧校验 `'abc' < 0 === false` 会让字符串穿透入库污染计费。
 * 仅校验已提供的字段 (供 PUT 部分更新复用)。
 */
function validatePricingFields({ promptPrice, completionPrice, multiplier } = {}) {
  if (promptPrice !== undefined) {
    const p = Number(promptPrice);
    if (typeof promptPrice !== 'number' || !Number.isFinite(p) || p < 0) {
      throw new ValidationError('promptPrice 必须为非负数字');
    }
  }
  if (completionPrice !== undefined) {
    const c = Number(completionPrice);
    if (typeof completionPrice !== 'number' || !Number.isFinite(c) || c < 0) {
      throw new ValidationError('completionPrice 必须为非负数字');
    }
  }
  if (multiplier !== undefined) {
    const m = Number(multiplier);
    if (typeof multiplier !== 'number' || !Number.isFinite(m) || m <= 0) {
      throw new ValidationError('倍率必须为大于 0 的有限数字');
    }
  }
}

// 可定价模型候选列表 (供前端下拉选择, 不用手打模型名):
// 上游检测可用模型 + 已有模型路由 + 已有定价, 去重排序
router.get('/available-models', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { pool } = require('../../config/database');
    const [avail] = await pool.query(
      "SELECT DISTINCT model FROM model_availability WHERE status = 'available' AND model <> '__key__'"
    );
    const [routes] = await pool.query('SELECT DISTINCT model_pattern FROM model_routes');
    const [pricings] = await pool.query('SELECT DISTINCT model_pattern FROM pricing_configs');

    const set = new Set();
    for (const r of [...avail, ...routes, ...pricings]) {
      const v = String(r.model || r.model_pattern || '').replace(/\*+$/, '').trim();
      if (v) set.add(v);
    }
    res.json({ success: true, data: { models: [...set].sort((a, b) => a.localeCompare(b)) } });
  } catch (err) { next(err); }
});

// 批量调整倍率 (一键给全部/部分定价统一加价)
// action: 'set' 设为指定倍率 | 'multiply' 在当前倍率基础上乘以
// scope:  'all' 全部启用项 | 'upstream' 仅"跟随上游" | 'custom' 仅"自定义价格"
router.post('/batch', requireAuth, requireAdmin, auditMiddleware('pricing.batch', 'pricing'), async (req, res, next) => {
  try {
    const { action, multiplier, scope = 'all' } = req.body;
    if (!['set', 'multiply'].includes(action)) throw new ValidationError('action 仅支持 set 或 multiply');
    const m = Number(multiplier);
    if (!Number.isFinite(m) || m <= 0) throw new ValidationError('倍率必须为大于 0 的数字');
    if (!['all', 'upstream', 'custom'].includes(scope)) throw new ValidationError('scope 仅支持 all / upstream / custom');

    const { pool } = require('../../config/database');
    let where = 'is_active = 1';
    if (scope === 'upstream') where += ' AND prompt_price = 0 AND completion_price = 0';
    if (scope === 'custom') where += ' AND (prompt_price <> 0 OR completion_price <> 0)';

    const sql = action === 'set'
      ? `UPDATE pricing_configs SET multiplier = ?, updated_at = NOW() WHERE ${where}`
      : `UPDATE pricing_configs SET multiplier = ROUND(multiplier * ?, 3), updated_at = NOW() WHERE ${where}`;

    const [result] = await pool.query(sql, [m]);
    logger.info('批量调整定价倍率', { adminId: req.user.id, action, multiplier: m, scope, updated: result.affectedRows });
    res.json({ success: true, message: `已调整 ${result.affectedRows} 条定价的倍率`, data: { updated: result.affectedRows } });
  } catch (err) { next(err); }
});

// 获取全部定价配置
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [list, providerTypes] = await Promise.all([PricingConfig.list(), loadProviderTypes()]);
    res.json({ success: true, data: { list, providerTypes } });
  } catch (err) { next(err); }
});

// 新增定价 (含倍率: 用户价 = 基准价 x 倍率)
router.post('/', requireAuth, requireAdmin, auditMiddleware('pricing.create', 'pricing'), async (req, res, next) => {
  try {
    const { modelPattern, providerType = 'openai', promptPrice, completionPrice, multiplier = 1 } = req.body;
    if (!modelPattern) throw new ValidationError('缺少 modelPattern');
    await assertValidProviderType(providerType);
    if (promptPrice === undefined || completionPrice === undefined) {
      throw new ValidationError('缺少 promptPrice 或 completionPrice');
    }
    validatePricingFields({ promptPrice, completionPrice, multiplier });

    const config = await PricingConfig.create({
      modelPattern, providerType, promptPrice, completionPrice, multiplier,
    });
    logger.info('新增定价配置', { adminId: req.user.id, modelPattern, providerType, multiplier });
    res.status(201).json({ success: true, data: { config } });
  } catch (err) { next(err); }
});

// 更新定价 (含启用/禁用、倍率; 价格字段与创建时同等校验，防止负数/字符串污染计费)
router.put('/:id', requireAuth, requireAdmin, auditMiddleware('pricing.update', 'pricing'), async (req, res, next) => {
  try {
    const { providerType } = req.body;
    if (providerType) await assertValidProviderType(providerType);
    validatePricingFields(req.body);
    const config = await PricingConfig.update(parseInt(req.params.id), req.body);
    if (!config) throw new ValidationError('定价配置不存在');
    res.json({ success: true, data: { config } });
  } catch (err) { next(err); }
});

// 删除定价
router.delete('/:id', requireAuth, requireAdmin, auditMiddleware('pricing.delete', 'pricing'), async (req, res, next) => {
  try {
    await PricingConfig.delete(parseInt(req.params.id));
    res.json({ success: true, message: '已删除' });
  } catch (err) { next(err); }
});

module.exports = router;
